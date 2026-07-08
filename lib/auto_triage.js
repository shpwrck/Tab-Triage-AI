// Auto-triage: when new tabs land in a window, debounce/throttle, then
// regroup the window's tabs as native Chrome tab groups. Tabs already
// in a group may be moved into a different group if the AI model groups
// them somewhere else.
//
// Design constraints, in order:
//
// 1. Cost: each run costs an AI provider call. Defaults: 10s debounce + 90s
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
import { isTriageEligibleTab } from "./tab_policy.js";
import { normalizeTriageGroups } from "./triage_normalize.js";
import {
  BACKGROUND_FEATURES,
  STATUS_LEVELS,
  clearBackgroundFeatureStatus,
  markBackgroundStatusNotified,
  recordBackgroundFeatureStatus,
  shouldNotifyBackgroundStatus,
} from "./background_status.js";

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

  // Reassess all triage-eligible tabs — including those already
  // in a Chrome tab group. chrome.tabs.group() will move them out of
  // their current group into the new one when we re-apply.
  const tabs = await chrome.tabs.query({ windowId });
  const candidates = tabs.filter(isTriageEligibleTab);
  if (candidates.length < at.minTabs) return;

  let result;
  await setTriageRunning(true).catch(() => {});
  try {
    ({ result } = await runQuotaLimitedTriage({
      settings,
      tabs: candidates,
      afterTriage: async ({ rawGroups, tabs: triageCandidates, cap }) => {
        const groupsToApply = normalizeTriageGroups({ rawGroups, tabs: triageCandidates });

        const applyResults = await applyAllAsTabGroups({ groups: groupsToApply });
        const applySummary = summarizeApplyResults({ groups: groupsToApply, results: applyResults });
        for (const failure of applySummary.failures) {
          console.warn("[auto-triage] applyAsTabGroup failed", failure.label, failure.error);
        }

        // Cache the triage so the new-tab page can render summaries without
        // calling the AI provider again.
        if (groupsToApply.length > 0) {
          await saveTriageCache({ windowId, groups: groupsToApply }).catch(() => {});
        }

        // Record results.
        lastRunMap[windowId] = Date.now();
        await chrome.storage.local.set({ [LAST_RUN_KEY]: lastRunMap });
        await saveSettings({ autoTriage: { lastRunAt: Date.now() } });
        if (applySummary.failedGroupCount) {
          await recordAutoTriageApplyStatus(applySummary).catch(() => {});
        } else {
          await clearBackgroundFeatureStatus(BACKGROUND_FEATURES.AUTO_TRIAGE).catch(() => {});
        }

        return { groupedCount: applySummary.groupedTabCount, cachedGroups: groupsToApply, applySummary, cap };
      },
    }));
  } catch (e) {
    if (e instanceof TriageQuotaError) {
      lastRunMap[windowId] = Date.now();
      await chrome.storage.local.set({ [LAST_RUN_KEY]: lastRunMap }).catch(() => {});
      const status = await recordAutoTriageQuotaStatus(e).catch(() => null);
      if (status && shouldNotifyBackgroundStatus(status, { cooldownMs: 60 * 60 * 1000 })) {
        await notifyAutoTriage({
          title: "Tab Triage AI limit reached",
          message: e.message,
          priority: 1,
        });
        await markBackgroundStatusNotified(BACKGROUND_FEATURES.AUTO_TRIAGE).catch(() => {});
      }
      return;
    }
    console.warn("[auto-triage] run failed", e?.message ?? e);
    const status = await recordAutoTriageRunFailure(e).catch(() => null);
    if (status && shouldNotifyBackgroundStatus(status, { minOccurrences: 2 })) {
      await notifyAutoTriage({
        title: "Auto-triage needs attention",
        message: notificationMessageForStatus(status),
        priority: 1,
      });
      await markBackgroundStatusNotified(BACKGROUND_FEATURES.AUTO_TRIAGE).catch(() => {});
    }
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
  const groupWord = summary.groupedGroupCount === 1 ? "group" : "groups";
  if (summary.failedGroupCount) {
    const successPrefix = summary.groupedGroupCount
      ? `Grouped ${scopedCount} tabs into ${summary.groupedGroupCount} ${groupWord}. `
      : "No tab groups were applied. ";
    return {
      title: summary.groupedGroupCount ? "Tab Triage AI partially grouped" : "Tab Triage AI could not group tabs",
      message: `${successPrefix}${formatApplyFailureMessage(summary)}`,
      priority: 1,
    };
  }
  return {
    title: "Tab Triage AI",
    message: `Grouped ${scopedCount} tabs into ${summary.groupedGroupCount} ${groupWord}.`,
    priority: 0,
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

async function recordAutoTriageApplyStatus(applySummary) {
  return recordBackgroundFeatureStatus(BACKGROUND_FEATURES.AUTO_TRIAGE, {
    level: STATUS_LEVELS.WARNING,
    title: "Auto-triage partially applied",
    message: formatApplyFailureMessage(applySummary),
    guidance: "Tabs were not closed. Try again from the new tab page if the window still needs grouping.",
    code: "apply_failed",
    meta: {
      failedGroupCount: applySummary.failedGroupCount,
      failedTabCount: applySummary.failedTabCount,
    },
  });
}

async function recordAutoTriageQuotaStatus(error) {
  return recordBackgroundFeatureStatus(BACKGROUND_FEATURES.AUTO_TRIAGE, {
    level: STATUS_LEVELS.WARNING,
    title: "Auto-triage limit reached",
    message: error.message,
    guidance: "Open Settings to check your plan, or wait for the weekly free limit to reset.",
    code: "triage_quota",
  });
}

async function recordAutoTriageRunFailure(error) {
  return recordBackgroundFeatureStatus(BACKGROUND_FEATURES.AUTO_TRIAGE, {
    level: error?.retryable ? STATUS_LEVELS.WARNING : STATUS_LEVELS.ERROR,
    title: "Auto-triage failed",
    message: error?.message ?? String(error),
    guidance: guidanceForAutoTriageError(error),
    code: error?.code || "run_failed",
    details: error?.details || "",
  });
}

function guidanceForAutoTriageError(error) {
  switch (error?.code) {
    case "auth":
      return "Open Settings and update the API key, then make sure the selected model is allowed for that key.";
    case "rate_limit":
      return "Check provider billing or quota, or wait before trying again.";
    case "network":
      return "Check your internet connection, VPN/firewall, and provider base URL in Settings.";
    case "bad_request":
      return "Check the model name and provider/base URL in Settings.";
    case "bad_model_output":
    case "output_limit":
    case "triage_too_large":
      return "Try again with fewer tabs in the window or choose a model with larger JSON output capacity.";
    case "provider_unavailable":
    case "request_timeout":
      return "Try again in a moment. If it keeps happening, test the provider connection in Settings.";
    default:
      return "Open Settings, test the provider connection, then try auto-triage again.";
  }
}

function notificationMessageForStatus(status) {
  const msg = [status.message, status.guidance].filter(Boolean).join(" ");
  return msg.length > 180 ? `${msg.slice(0, 177)}...` : msg;
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
