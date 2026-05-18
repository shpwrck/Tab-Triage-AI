// Toolbar badge: shows the count of "stale" tabs — tabs you haven't
// activated in the last N hours, summed across all windows in the
// current profile. Driven by tab events; never calls Claude.

import { getSettings } from "./storage.js";

const ALARM_NAME = "tt-badge-refresh";
const DEBOUNCE_MS = 600; // collapse bursts of tab events into one update
const PERIODIC_MINUTES = 15; // re-evaluate so tabs cross the staleness line

// Amber draws the eye against the red icon background; stays readable on
// both light and dark Chrome themes.
const BADGE_BG = "#f59e0b";
const BADGE_FG = "#1a0c00";

// While a triage is in flight, the badge swaps to a blue dot so the user
// sees something is happening. Stored in chrome.storage.local because
// triage can run in any context (SW, popup, newtab) but only the SW
// updates the badge on alarms — the shared flag keeps them in sync.
const TRIAGE_BG = "#2563eb";
const TRIAGE_FG = "#ffffff";
const TRIAGE_TEXT = "...";
const TRIAGE_FLAG_KEY = "tt_triage_running";
// Safety net: if a caller forgets to clear the flag (crashed tab, etc.),
// treat it as stale after this many ms.
const TRIAGE_FLAG_MAX_AGE_MS = 5 * 60_000;

// Human-friendly threshold label. Whole hours stay as "24h+"; sub-hour
// values flip to minutes; round day multiples flip to days. Used by the
// badge title and the new-tab dashboard so a 30-minute custom threshold
// renders as "30m+" instead of "0.5h+".
export function formatThresholdLabel(hours) {
  const h = Number(hours);
  if (!Number.isFinite(h) || h <= 0) return "24h+";
  if (h < 1) return `${Math.max(1, Math.round(h * 60))}m+`;
  if (h >= 24 && h % 24 === 0) return `${h / 24}d+`;
  if (Number.isInteger(h)) return `${h}h+`;
  return `${h.toFixed(1)}h+`;
}

let _installed = false;

export function installBadge() {
  if (_installed) return;
  _installed = true;

  chrome.action.setBadgeBackgroundColor({ color: BADGE_BG });
  if (chrome.action.setBadgeTextColor) {
    chrome.action.setBadgeTextColor({ color: BADGE_FG });
  }

  const schedule = () => {
    // .create with the same name overwrites the pending alarm — perfect
    // debounce for bursty tab events. Use a periodic flag so tabs slowly
    // age into staleness even when nothing is happening.
    chrome.alarms.create(ALARM_NAME, {
      when: Date.now() + DEBOUNCE_MS,
      periodInMinutes: PERIODIC_MINUTES,
    });
  };

  chrome.tabs.onCreated.addListener(schedule);
  chrome.tabs.onRemoved.addListener(schedule);
  chrome.tabs.onActivated.addListener(schedule);
  chrome.tabs.onUpdated.addListener((_, change) => {
    if (change.status === "complete" || change.url) schedule();
  });
  chrome.windows.onFocusChanged.addListener(() => schedule());
  chrome.alarms.onAlarm.addListener(alarm => {
    if (alarm.name === ALARM_NAME) updateBadge().catch(() => {});
  });

  // Initial render so the badge appears as soon as the worker boots.
  updateBadge().catch(() => {});
}

export async function updateBadge() {
  if (await isTriageRunning()) {
    await paintTriageBadge();
    return { triaging: true };
  }

  const settings = await getSettings();
  const cfg = settings.badge ?? {};
  // Restore the stale-tab badge color in case a previous paint left the
  // triage blue behind.
  await chrome.action.setBadgeBackgroundColor({ color: BADGE_BG });
  if (chrome.action.setBadgeTextColor) {
    await chrome.action.setBadgeTextColor({ color: BADGE_FG });
  }
  if (!cfg.enabled) {
    await Promise.all([
      chrome.action.setBadgeText({ text: "" }),
      chrome.action.setTitle({ title: "Tab Triage AI" }),
    ]);
    return { count: 0 };
  }

  const thresholdMs = (cfg.thresholdHours ?? 24) * 60 * 60 * 1000;
  const now = Date.now();
  // We only consider http(s) tabs — chrome:// and about: pages aren't
  // candidates for triage so they shouldn't pad the number.
  const tabs = await chrome.tabs.query({ url: ["http://*/*", "https://*/*"] });
  const stale = tabs.filter(
    t => typeof t.lastAccessed === "number" && now - t.lastAccessed >= thresholdMs,
  );
  const count = stale.length;

  const text = count === 0 ? "" : count > 99 ? "99+" : String(count);
  const label = formatThresholdLabel(cfg.thresholdHours ?? 24);
  const title = count === 0
    ? "Tab Triage AI"
    : `Tab Triage AI — ${count} tab${count === 1 ? "" : "s"} untouched for ${label}`;

  await Promise.all([
    chrome.action.setBadgeText({ text }),
    chrome.action.setTitle({ title }),
  ]);
  return { count };
}

// Flip the toolbar badge into "triage in progress" mode. Callers should
// wrap their triageTabs() call:
//   await setTriageRunning(true);
//   try { await triageTabs(...); } finally { await setTriageRunning(false); }
//
// From page contexts (popup, newtab, options) we round-trip through the
// service worker — chrome.action paints initiated from a popup don't
// always land on the toolbar icon, but SW paints always do.
export async function setTriageRunning(running) {
  if (typeof document !== "undefined") {
    try {
      await chrome.runtime.sendMessage({ type: "tt-set-triage-running", running: !!running });
      return;
    } catch (e) {
      console.warn("[badge] SW message failed, painting locally", e?.message ?? e);
      // Fall through to local paint as a best-effort fallback.
    }
  }
  await applyTriageRunning(running);
}

// Internal: actually flip the flag + paint. Used by the SW message
// handler and as a fallback when no SW is reachable.
export async function applyTriageRunning(running) {
  if (running) {
    await chrome.storage.local.set({ [TRIAGE_FLAG_KEY]: Date.now() });
    await paintTriageBadge();
  } else {
    await chrome.storage.local.remove(TRIAGE_FLAG_KEY);
    await updateBadge().catch(() => {});
  }
}

async function isTriageRunning() {
  const { [TRIAGE_FLAG_KEY]: at } = await chrome.storage.local.get(TRIAGE_FLAG_KEY);
  if (typeof at !== "number") return false;
  if (Date.now() - at > TRIAGE_FLAG_MAX_AGE_MS) {
    await chrome.storage.local.remove(TRIAGE_FLAG_KEY);
    return false;
  }
  return true;
}

async function paintTriageBadge() {
  await chrome.action.setBadgeBackgroundColor({ color: TRIAGE_BG });
  if (chrome.action.setBadgeTextColor) {
    await chrome.action.setBadgeTextColor({ color: TRIAGE_FG });
  }
  await Promise.all([
    chrome.action.setBadgeText({ text: TRIAGE_TEXT }),
    chrome.action.setTitle({ title: "Tab Triage AI — triaging..." }),
  ]);
}
