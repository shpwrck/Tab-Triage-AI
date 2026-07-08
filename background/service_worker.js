// Background service worker. Handles cross-context actions that the popup
// can't easily do itself (creating windows, hotkey opening the popup),
// and runs ExtPay's background listeners so paid status stays fresh
// across the extension.

import { getExtPay, billingEnabled, refreshPlan } from "../lib/billing.js";
import { installAutoTriage } from "../lib/auto_triage.js";
import { installBadge, updateBadge, applyTriageRunning } from "../lib/badge.js";
import { installSleepStale } from "../lib/sleep_stale.js";
import { installSessionSync } from "../lib/session_sync.js";
import { runManualTriage } from "../lib/manual_triage.js";
import { readPopupTriageState, startPopupTriage } from "../lib/popup_triage.js";
import { formatApplyFailureMessage } from "../lib/actions.js";

if (billingEnabled()) {
  getExtPay().startBackground();
  refreshPlan().catch(() => {});
}

installAutoTriage();
installBadge();
installSleepStale();
installSessionSync();

// Settings changes from the options page should refresh the badge right
// away so the user sees their threshold/toggle change take effect.
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && changes.tt_settings) {
    updateBadge().catch(() => {});
  }
});

chrome.commands.onCommand.addListener(async cmd => {
  if (cmd === "open-popup" || cmd === "search-tabs") {
    try {
      await chrome.action.openPopup();
    } catch {
      // openPopup() may be unavailable in some contexts; fall back silently.
    }
    return;
  }
  if (cmd === "triage-now") {
    try {
      const win = await chrome.windows.getLastFocused();
      const result = await runManualTriage({ windowId: win?.id });
      const notification = formatManualTriageNotification(result);
      chrome.notifications.create({
        type: "basic",
        iconUrl: chrome.runtime.getURL("icons/icon128.png"),
        title: notification.title,
        message: notification.message,
        priority: notification.priority,
      }).catch(() => {});
    } catch (e) {
      chrome.notifications.create({
        type: "basic",
        iconUrl: chrome.runtime.getURL("icons/icon128.png"),
        title: "Tab Triage failed",
        message: e?.message ?? String(e),
        priority: 1,
      }).catch(() => {});
    }
  }
});

function formatManualTriageNotification({ groups, candidates, totalCandidates, cap, applySummary }) {
  if (!groups?.length) {
    return {
      title: "Tab Triage",
      message: "Triage finished, but no tab groups were applied.",
      priority: 0,
    };
  }

  const summary = applySummary ?? {
    groupedTabCount: candidates,
    groupedGroupCount: groups.length,
    failedGroupCount: 0,
  };
  const scopedCount = cap?.applied
    ? `${summary.groupedTabCount} of ${totalCandidates}`
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

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.type === "restore-session") {
    restoreSession(msg.urls).then(
      win => sendResponse({ ok: true, windowId: win?.id ?? null }),
      err => sendResponse({ ok: false, error: String(err?.message ?? err) }),
    );
    return true;
  }
  if (msg?.type === "refresh-plan") {
    refreshPlan().then(
      result => sendResponse({ ok: true, ...result }),
      err => sendResponse({ ok: false, error: String(err?.message ?? err) }),
    );
    return true;
  }
  if (msg?.type === "tt-set-triage-running") {
    applyTriageRunning(!!msg.running).then(
      () => sendResponse({ ok: true }),
      err => sendResponse({ ok: false, error: String(err?.message ?? err) }),
    );
    return true;
  }
  if (msg?.type === "tt-popup-triage-start") {
    startPopupTriage({ tabs: msg.tabs, windowId: msg.windowId }).then(
      state => sendResponse({ ok: true, state }),
      err => sendResponse({ ok: false, error: String(err?.message ?? err) }),
    );
    return true;
  }
  if (msg?.type === "tt-popup-triage-state") {
    readPopupTriageState().then(
      state => sendResponse({ ok: true, state }),
      err => sendResponse({ ok: false, error: String(err?.message ?? err) }),
    );
    return true;
  }
});

async function restoreSession(urls) {
  if (!urls?.length) throw new Error("No URLs to restore");
  return chrome.windows.create({ url: urls, focused: true });
}
