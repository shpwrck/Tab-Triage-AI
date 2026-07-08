// Sleep stale tabs: when the user enables it in Settings, the same
// staleness threshold that drives the toolbar badge also triggers
// chrome.tabs.discard() on each qualifying tab. Discarded tabs stay in
// the tab strip — they just stop using memory until clicked again.
//
// Runs on the same alarm cadence as the badge so we don't add another
// timer. Skips: pinned tabs, the currently-active tab in each window,
// audible tabs (likely a music/video tab the user wants alive),
// already-discarded tabs.

import { getSettings } from "./storage.js";
import { isSleepStaleEligibleTab, staleThresholdMs } from "./tab_policy.js";

const ALARM_NAME = "tt-sleep-stale";
const PERIODIC_MINUTES = 5;

let _installed = false;

export function installSleepStale() {
  if (_installed) return;
  _installed = true;
  chrome.alarms.create(ALARM_NAME, { periodInMinutes: PERIODIC_MINUTES, when: Date.now() + 30_000 });
  chrome.alarms.onAlarm.addListener(alarm => {
    if (alarm.name === ALARM_NAME) sweep().catch(() => {});
  });
}

export async function sweep() {
  const settings = await getSettings();
  if (!settings.sleep?.enabled) return { slept: 0 };

  const thresholdMs = staleThresholdMs(settings.badge?.thresholdHours);
  const now = Date.now();
  const tabs = await chrome.tabs.query({ url: ["http://*/*", "https://*/*"] });
  let slept = 0;
  for (const t of tabs) {
    if (!isSleepStaleEligibleTab(t, { now, thresholdMs })) continue;
    try {
      await chrome.tabs.discard(t.id);
      slept++;
    } catch {
      // tab could already be gone or unable to discard (e.g. devtools open); ignore
    }
  }
  return { slept };
}
