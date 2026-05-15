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

const PREFIX = "tt_session_";
const MAX_BYTES = 7500; // 8 KB minus key + JSON overhead headroom

let _installed = false;

export function installSessionSync() {
  if (_installed) return;
  _installed = true;

  // Initial pull at startup so sessions written from another device show
  // up here without waiting for an event.
  (async () => {
    const settings = await getSettings();
    if (settings.sync?.enabled) {
      await pullFromSync().catch(() => {});
    }
  })();

  chrome.storage.onChanged.addListener(async (changes, area) => {
    try {
      if (area === "local" && changes.tt_sessions) {
        const enabled = (await getSettings()).sync?.enabled;
        if (enabled) await pushLocalToSync();
      } else if (area === "sync") {
        await applySyncChanges(changes);
      }
    } catch (e) {
      console.warn("[session-sync] handler failed", e?.message ?? e);
    }
  });
}

// Called when the user toggles sync. Push everything we have, then on
// disable also clear our keys so we don't keep stale data in Google's
// sync silo after they've opted out.
export async function onSyncEnabledChange(enabled) {
  if (enabled) {
    await pullFromSync().catch(() => {});
    await pushLocalToSync().catch(() => {});
  } else {
    await clearSyncSessions().catch(() => {});
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
  return { synced: wantKeys.size, skipped };
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
