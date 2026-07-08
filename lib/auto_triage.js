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
import { runQuotaLimitedTriage, TriageQuotaError } from "./triage_quota.js";
import { applyAllAsTabGroups, formatApplyFailureMessage, summarizeApplyResults } from "./actions.js";
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

  let result;
  await setTriageRunning(true).catch(() => {});
  try {
    ({ result } = await runQuotaLimitedTriage({
      settings,
      tabs: candidates,
      afterTriage: async ({ rawGroups, tabs: triageCandidates, cap }) => {
        const tabsById = new Map(triageCandidates.map(t => [t.id, t]));
        const placedIds = new Set();
        const groupsToApply = [];
        const cachedGroups = [];
        // Defer the LLM's "Unsorted" group (if any) to the end so we can merge
        // leftovers — singleton-dropped tabs, unrecognized tab_ids, tabs the LLM
        // simply omitted — into one bucket instead of letting them vanish.
        let llmUnsorted = null;
        for (let i = 0; i < rawGroups.length; i++) {
          const g = rawGroups[i];
          const ids = (g.tab_ids ?? []).filter(id => tabsById.has(id));
          if ((g.label ?? "").trim().toLowerCase() === "unsorted") {
            llmUnsorted = { group: g, ids };
            continue;
          }
          if (ids.length < 2) continue; // never create a 1-tab group
          const groupTabs = ids.map(id => tabsById.get(id));
          ids.forEach(id => placedIds.add(id));
          const groupForApply = {
            label: g.label,
            emoji: g.emoji,
            summary: g.summary,
            colorIndex: i,
            tabs: groupTabs.map(t => ({ id: t.id, windowId: t.windowId, title: t.title, url: t.url, favIconUrl: t.favIconUrl })),
          };
          groupsToApply.push(groupForApply);
          cachedGroups.push(cacheGroupForTriage(groupForApply));
        }

        const unsortedIds = [];
        const seen = new Set();
        for (const id of [...(llmUnsorted?.ids ?? []), ...triageCandidates.map(t => t.id)]) {
          if (placedIds.has(id) || seen.has(id)) continue;
          if (!tabsById.has(id)) continue;
          seen.add(id);
          unsortedIds.push(id);
        }
        if (unsortedIds.length > 0) {
          const unsortedTabs = unsortedIds.map(id => tabsById.get(id));
          const unsortedGroup = {
            label: "Unsorted",
            summary: llmUnsorted?.group.summary,
            colorIndex: 8,
            tabs: unsortedTabs.map(t => ({ id: t.id, windowId: t.windowId, title: t.title, url: t.url, favIconUrl: t.favIconUrl })),
          };
          groupsToApply.push(unsortedGroup);
          cachedGroups.push(cacheGroupForTriage(unsortedGroup));
        }

        const applyResults = await applyAllAsTabGroups({ groups: groupsToApply });
        const applySummary = summarizeApplyResults({ groups: groupsToApply, results: applyResults });
        for (const failure of applySummary.failures) {
          console.warn("[auto-triage] applyAsTabGroup failed", failure.label, failure.error);
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

        return { groupedCount: applySummary.groupedTabCount, cachedGroups, applySummary, cap };
      },
    }));
  } catch (e) {
    if (e instanceof TriageQuotaError) {
      lastRunMap[windowId] = Date.now();
      await chrome.storage.local.set({ [LAST_RUN_KEY]: lastRunMap }).catch(() => {});
      if (at.notify) {
        await notifyAutoTriage({
          title: "Tab Triage limit reached",
          message: e.message,
          priority: 1,
        });
      }
      return;
    }
    console.warn("[auto-triage] run failed", e?.message ?? e);
    return;
  } finally {
    await setTriageRunning(false).catch(() => {});
  }

  if (at.notify && result.applySummary?.attemptedGroupCount > 0) {
    await notifyAutoTriage(formatAutoTriageNotification(result));
  }
}

function formatAutoTriageNotification(result) {
  const summary = result.applySummary;
  const scopedCount = result.cap.applied
    ? `${summary.groupedTabCount} of ${result.cap.originalCount}`
    : String(summary.groupedTabCount);
  const clusterWord = summary.groupedGroupCount === 1 ? "cluster" : "clusters";
  if (summary.failedGroupCount) {
    const successPrefix = summary.groupedGroupCount
      ? `Grouped ${scopedCount} tabs into ${summary.groupedGroupCount} ${clusterWord}. `
      : "No tab groups were applied. ";
    return {
      title: summary.groupedGroupCount ? "Tab Triage partially grouped" : "Tab Triage could not group tabs",
      message: `${successPrefix}${formatApplyFailureMessage(summary)}`,
      priority: 1,
    };
  }
  return {
    title: "Tab Triage",
    message: `Grouped ${scopedCount} tabs into ${summary.groupedGroupCount} ${clusterWord}.`,
    priority: 0,
  };
}

function cacheGroupForTriage(group) {
  return {
    label: group.label,
    emoji: group.emoji,
    summary: group.summary,
    tabs: (group.tabs ?? []).map(t => ({ title: t.title, url: t.url, favIconUrl: t.favIconUrl })),
  };
}

async function notifyAutoTriage({ title, message, priority }) {
  try {
    await chrome.notifications.create({
      type: "basic",
      iconUrl: chrome.runtime.getURL("icons/icon128.png"),
      title,
      message,
      priority,
    });
  } catch {}
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
