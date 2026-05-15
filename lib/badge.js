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
  const settings = await getSettings();
  const cfg = settings.badge ?? {};
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
  const hours = cfg.thresholdHours ?? 24;
  const title = count === 0
    ? "Tab Triage AI"
    : `Tab Triage AI — ${count} tab${count === 1 ? "" : "s"} untouched for ${hours}h+`;

  await Promise.all([
    chrome.action.setBadgeText({ text }),
    chrome.action.setTitle({ title }),
  ]);
  return { count };
}
