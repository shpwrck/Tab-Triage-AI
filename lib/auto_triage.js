// Auto-triage: when new tabs land in a window, debounce/throttle, then
// re-group the window's tabs as native Chrome tab groups. Tabs already
// in a group may be moved into a different group if the LLM clusters
// them somewhere else.
//
// Design constraints, in order:
//
// 1. Cost: each run costs a Claude call. Defaults: 10s debounce + 90s
//    throttle + 6-tab minimum means typical browsing yields a few runs
//    per hour, not dozens.
// 2. Resilient to service-worker eviction: state lives in chrome.storage,
//    debounce uses chrome.alarms (survives SW restart), not setTimeout.
// 3. Per-window: each browser window has its own pending alarm and
//    throttle window keyed by windowId.
// 4. Pinned tabs are never touched.

import { getSettings, saveSettings } from "./storage.js";
import { triageTabs } from "./llm/index.js";
import { applyAsTabGroup } from "./actions.js";
import { saveTriageCache } from "./triage_cache.js";
import { setTriageRunning } from "./badge.js";

const ALARM_PREFIX = "tt-auto-triage:";
const LAST_RUN_KEY = "tt_auto_last_run"; // { [windowId]: epochMs }

// Wire up Chrome listeners. Idempotent.
let _installed = false;
export function installAutoTriage() {
  if (_installed) return;
  _installed = true;

  chrome.tabs.onCreated.addListener(tab => maybeSchedule(tab?.windowId));
  // onUpdated covers the "tab navigated to a real URL" moment, which is
  // when a tab actually becomes triageable (the Ctrl+T new-tab page has
  // no useful title).
  chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
    if (changeInfo.status === "complete" && tab?.url && /^https?:/.test(tab.url)) {
      maybeSchedule(tab.windowId);
    }
  });
  chrome.alarms.onAlarm.addListener(alarm => {
    if (!alarm.name.startsWith(ALARM_PREFIX)) return;
    const windowId = Number(alarm.name.slice(ALARM_PREFIX.length));
    if (Number.isFinite(windowId)) runForWindow(windowId).catch(e => console.warn("[auto-triage] run failed", e));
  });
  chrome.windows.onRemoved.addListener(windowId => {
    chrome.alarms.clear(`${ALARM_PREFIX}${windowId}`).catch(() => {});
  });
}

async function maybeSchedule(windowId) {
  if (!Number.isFinite(windowId)) return;
  const settings = await getSettings();
  const at = settings.autoTriage;
  if (!at.enabled) return;
  if (!settings.llm?.apiKey) return;
  if (at.pausedUntil && Date.now() < at.pausedUntil) return;

  // Reset/create the debounce alarm. chrome.alarms.create with the same
  // name overwrites — that's exactly the debounce behavior we want.
  await chrome.alarms.create(`${ALARM_PREFIX}${windowId}`, {
    when: Date.now() + at.debounceSeconds * 1000,
  });
}

async function runForWindow(windowId) {
  const settings = await getSettings();
  const at = settings.autoTriage;
  if (!at.enabled || !settings.llm?.apiKey) return;
  if (at.pausedUntil && Date.now() < at.pausedUntil) return;

  // Throttle per-window.
  const lastRunMap = await getLastRunMap();
  const last = lastRunMap[windowId] ?? 0;
  if (Date.now() - last < at.throttleSeconds * 1000) return;

  // Confirm the window still exists.
  let win;
  try { win = await chrome.windows.get(windowId); } catch { return; }
  if (!win) return;

  // Reassess all real-URL, non-pinned tabs — including those already
  // in a Chrome tab group. chrome.tabs.group() will move them out of
  // their current group into the new one when we re-apply.
  const tabs = await chrome.tabs.query({ windowId });
  const candidates = tabs.filter(t => t.url && /^https?:/.test(t.url) && !t.pinned);
  if (candidates.length < at.minTabs) return;

  let groups;
  await setTriageRunning(true).catch(() => {});
  try {
    groups = await triageTabs({
      settings,
      tabs: candidates.map(t => ({ id: t.id, title: t.title, url: t.url })),
    });
  } catch (e) {
    console.warn("[auto-triage] Claude call failed", e?.message ?? e);
    return;
  } finally {
    await setTriageRunning(false).catch(() => {});
  }

  const tabsById = new Map(candidates.map(t => [t.id, t]));
  let groupedCount = 0;
  const cachedGroups = [];
  for (let i = 0; i < groups.length; i++) {
    const g = groups[i];
    const ids = (g.tab_ids ?? []).filter(id => tabsById.has(id));
    if (ids.length < 2) continue; // never create a 1-tab group
    const groupTabs = ids.map(id => tabsById.get(id));
    cachedGroups.push({
      label: g.label,
      emoji: g.emoji,
      summary: g.summary,
      tabs: groupTabs.map(t => ({ title: t.title, url: t.url, favIconUrl: t.favIconUrl })),
    });
    try {
      await applyAsTabGroup({ group: g, tabs: groupTabs, colorIndex: i });
      groupedCount += ids.length;
    } catch (e) {
      console.warn("[auto-triage] applyAsTabGroup failed", e?.message ?? e);
    }
  }

  // Cache the triage so the new-tab page can render summaries without
  // calling the LLM again.
  if (cachedGroups.length > 0) {
    await saveTriageCache({ windowId, groups: cachedGroups }).catch(() => {});
  }

  // Record results.
  lastRunMap[windowId] = Date.now();
  await chrome.storage.local.set({ [LAST_RUN_KEY]: lastRunMap });
  await saveSettings({ autoTriage: { lastRunAt: Date.now() } });

  if (at.notify && groupedCount > 0) {
    try {
      await chrome.notifications.create({
        type: "basic",
        iconUrl: chrome.runtime.getURL("icons/icon128.png"),
        title: "Tab Triage",
        message: `Grouped ${groupedCount} tabs into ${groups.length} clusters.`,
        priority: 0,
      });
    } catch {}
  }
}

async function getLastRunMap() {
  const { [LAST_RUN_KEY]: m } = await chrome.storage.local.get(LAST_RUN_KEY);
  return m ?? {};
}

export async function pauseAutoTriage(minutes) {
  await saveSettings({ autoTriage: { pausedUntil: Date.now() + minutes * 60_000 } });
}

export async function resumeAutoTriage() {
  await saveSettings({ autoTriage: { pausedUntil: 0 } });
}
