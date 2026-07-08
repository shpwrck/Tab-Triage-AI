// Mirror saved sessions to chrome.storage.sync so they roam with the
// user's Chrome profile across devices.
//
// chrome.storage.sync limits to keep in mind:
//   - 102 KB total
//   - 8 KB per item (we store one item per session under tt_session_<id>)
//   - 512 keys total
//   - 1800 ops/hour, 120 ops/minute (we batch on changes)
//
// Sessions over the per-item byte budget are skipped — they stay in
// local-only storage and we surface a warning. Most sessions are small
// (titles + URLs); a 50-tab session is typically ~5 KB.

import { getSettings, listSessions } from "./storage.js";
import {
  BACKGROUND_FEATURES,
  STATUS_LEVELS,
  clearBackgroundFeatureStatus,
  markBackgroundStatusNotified,
  recordBackgroundFeatureStatus,
  shouldNotifyBackgroundStatus,
} from "./background_status.js";

const PREFIX = "tt_session_";
const MAX_BYTES = 7500; // 8 KB minus key + JSON overhead headroom
const OVERSIZED_SESSION_NOTIFICATION_COOLDOWN_MS = 12 * 60 * 60 * 1000;

let _installed = false;

export function installSessionSync() {
  if (_installed) return;
  _installed = true;

  // Initial pull at startup so sessions written from another device show
  // up here without waiting for an event.
  (async () => {
    const settings = await getSettings();
    if (settings.sync?.enabled) {
      try {
        await pullFromSync();
      } catch (e) {
        await recordSessionSyncError("Startup sync pull", e).catch(() => {});
      }
    }
  })();

  chrome.storage.onChanged.addListener(async (changes, area) => {
    try {
      if (area === "local" && changes.tt_sessions) {
        const enabled = (await getSettings()).sync?.enabled;
        if (enabled) {
          const result = await pushLocalToSync();
          await recordSessionSyncPushResult(result);
        }
      } else if (area === "sync") {
        await applySyncChanges(changes);
      }
    } catch (e) {
      console.warn("[session-sync] handler failed", e?.message ?? e);
      await recordSessionSyncError("Session sync update", e).catch(() => {});
    }
  });
}

// Called when the user toggles sync. Push everything we have, then on
// disable also clear our keys so we don't keep stale data in Google's
// sync silo after they've opted out.
export async function onSyncEnabledChange(enabled) {
  if (enabled) {
    try {
      await pullFromSync();
      const result = await pushLocalToSync();
      await recordSessionSyncPushResult(result);
      return result;
    } catch (e) {
      await recordSessionSyncError("Enable sync", e).catch(() => {});
      throw e;
    }
  }
  try {
    await clearSyncSessions();
    await clearBackgroundFeatureStatus(BACKGROUND_FEATURES.SESSION_SYNC).catch(() => {});
    return { cleared: true };
  } catch (e) {
    await recordSessionSyncError("Disable sync", e).catch(() => {});
    throw e;
  }
}

async function pushLocalToSync() {
  const sessions = await listSessions();
  const remote = await chrome.storage.sync.get(null);
  const remoteKeys = new Set(Object.keys(remote).filter(k => k.startsWith(PREFIX)));
  const wantKeys = new Set();
  const toSet = {};
  let skipped = 0;
  for (const s of sessions) {
    const blob = JSON.stringify(s);
    if (blob.length > MAX_BYTES) {
      skipped++;
      continue;
    }
    const key = PREFIX + s.id;
    wantKeys.add(key);
    // Only write if the value actually changed — avoids ping-pong and
    // quota churn.
    if (JSON.stringify(remote[key] ?? null) !== blob) {
      toSet[key] = s;
    }
  }
  const toRemove = [...remoteKeys].filter(k => !wantKeys.has(k));
  if (toRemove.length) await chrome.storage.sync.remove(toRemove);
  if (Object.keys(toSet).length) await chrome.storage.sync.set(toSet);
  return { synced: wantKeys.size, skipped, written: Object.keys(toSet).length, removed: toRemove.length };
}

async function pullFromSync() {
  const remote = await chrome.storage.sync.get(null);
  const incoming = [];
  for (const [k, v] of Object.entries(remote)) {
    if (k.startsWith(PREFIX) && v && typeof v === "object" && v.id) incoming.push(v);
  }
  if (!incoming.length) return { added: 0 };

  const local = await listSessions();
  const byId = new Map(local.map(s => [s.id, s]));
  let mutated = false;
  for (const r of incoming) {
    const existing = byId.get(r.id);
    if (!existing) {
      local.unshift(r);
      byId.set(r.id, r);
      mutated = true;
    } else if (JSON.stringify(existing) !== JSON.stringify(r)) {
      // Remote version differs — last-write-wins by createdAt-on-update isn't
      // tracked, so we just take the remote version. Conflicts here are rare
      // (notes edited on two devices in the same minute).
      const idx = local.findIndex(s => s.id === r.id);
      local[idx] = r;
      mutated = true;
    }
  }
  if (mutated) {
    await chrome.storage.local.set({ tt_sessions: local });
  }
  return { added: local.length };
}

async function applySyncChanges(changes) {
  const enabled = (await getSettings()).sync?.enabled;
  if (!enabled) return;
  const relevant = Object.entries(changes).filter(([k]) => k.startsWith(PREFIX));
  if (!relevant.length) return;

  const local = await listSessions();
  let mutated = false;
  for (const [key, change] of relevant) {
    const id = key.slice(PREFIX.length);
    if (change.newValue) {
      const idx = local.findIndex(s => s.id === id);
      const blob = JSON.stringify(change.newValue);
      if (idx === -1) {
        local.unshift(change.newValue);
        mutated = true;
      } else if (JSON.stringify(local[idx]) !== blob) {
        local[idx] = change.newValue;
        mutated = true;
      }
    } else if (change.oldValue) {
      const idx = local.findIndex(s => s.id === id);
      if (idx !== -1) {
        local.splice(idx, 1);
        mutated = true;
      }
    }
  }
  if (mutated) {
    await chrome.storage.local.set({ tt_sessions: local });
  }
}

async function clearSyncSessions() {
  const remote = await chrome.storage.sync.get(null);
  const keys = Object.keys(remote).filter(k => k.startsWith(PREFIX));
  if (keys.length) await chrome.storage.sync.remove(keys);
}

async function recordSessionSyncPushResult({ synced = 0, skipped = 0, written = 0, removed = 0 } = {}) {
  if (!skipped) {
    await clearBackgroundFeatureStatus(BACKGROUND_FEATURES.SESSION_SYNC).catch(() => {});
    return null;
  }
  const message = skipped === 1
    ? "1 saved session is too large for Chrome sync and stayed local-only."
    : `${skipped} saved sessions are too large for Chrome sync and stayed local-only.`;
  const status = await recordBackgroundFeatureStatus(BACKGROUND_FEATURES.SESSION_SYNC, {
    level: STATUS_LEVELS.WARNING,
    title: "Some saved sessions stayed local-only",
    message,
    guidance: "Trim notes or split very large sessions. Smaller saved sessions still sync.",
    code: "session_too_large",
    meta: { synced, skipped, written, removed },
  });
  if (shouldNotifyBackgroundStatus(status, { cooldownMs: OVERSIZED_SESSION_NOTIFICATION_COOLDOWN_MS })) {
    await notifySessionSyncStatus(status);
    await markBackgroundStatusNotified(BACKGROUND_FEATURES.SESSION_SYNC).catch(() => {});
  }
  return status;
}

async function recordSessionSyncError(operation, error) {
  const status = await recordBackgroundFeatureStatus(BACKGROUND_FEATURES.SESSION_SYNC, {
    level: STATUS_LEVELS.ERROR,
    title: "Session sync failed",
    message: `${operation} failed: ${error?.message ?? String(error)}`,
    guidance: "Check that Chrome sync is available and has storage quota, then toggle Sync off and on in Settings.",
    code: "sync_failed",
    details: error?.stack || error?.message || "",
  });
  if (shouldNotifyBackgroundStatus(status, { minOccurrences: 2 })) {
    await notifySessionSyncStatus(status);
    await markBackgroundStatusNotified(BACKGROUND_FEATURES.SESSION_SYNC).catch(() => {});
  }
  return status;
}

async function notifySessionSyncStatus(status) {
  try {
    await chrome.notifications.create({
      type: "basic",
      iconUrl: chrome.runtime.getURL("icons/icon128.png"),
      title: status.title || "Session sync needs attention",
      message: notificationMessageForStatus(status),
      priority: 1,
    });
  } catch {}
}

function notificationMessageForStatus(status) {
  const msg = [status.message, status.guidance].filter(Boolean).join(" ");
  return msg.length > 180 ? `${msg.slice(0, 177)}...` : msg;
}
