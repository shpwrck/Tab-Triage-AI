// Background service worker. Handles cross-context actions that the popup
// can't easily do itself (creating windows, hotkey opening the popup),
// and runs ExtPay's background listeners so paid status stays fresh
// across the extension.

import { getExtPay, billingEnabled, refreshPlan } from "../lib/billing.js";
import { installAutoTriage } from "../lib/auto_triage.js";
import { installBadge, updateBadge, applyTriageRunning } from "../lib/badge.js";
import { installSleepStale } from "../lib/sleep_stale.js";
import { installSessionSync } from "../lib/session_sync.js";
import { installSessionSnapshots } from "../lib/session_snapshots.js";
import { runManualTriage } from "../lib/manual_triage.js";
import { readPopupTriageState, startPopupTriage } from "../lib/popup_triage.js";
import { formatApplyFailureMessage, restoreSession } from "../lib/actions.js";
import {
  BACKGROUND_FEATURES,
  STATUS_LEVELS,
  clearBackgroundFeatureStatus,
  recordBackgroundFeatureStatus,
} from "../lib/background_status.js";

const SHORTCUT_FALLBACK_NOTIFICATION_PREFIX = "tt-shortcut-fallback:";

if (billingEnabled()) {
  getExtPay().startBackground();
  refreshPlan().catch(() => {});
}

installAutoTriage();
installBadge();
installSleepStale();
installSessionSync();
installSessionSnapshots();

chrome.runtime.onInstalled.addListener(details => {
  if (details.reason !== "install") return;
  openOnboardingSettings().catch(() => {});
});

// Settings changes from the options page should refresh the badge right
// away so the user sees their threshold/toggle change take effect.
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && changes.tt_settings) {
    updateBadge().catch(() => {});
  }
});

chrome.commands.onCommand.addListener(async cmd => {
  if (cmd === "open-popup" || cmd === "search-tabs") {
    await openPopupForCommand(cmd);
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
        title: "Tab Triage AI failed",
        message: e?.message ?? String(e),
        priority: 1,
      }).catch(() => {});
    }
  }
});

chrome.notifications.onClicked.addListener(notificationId => {
  if (!isShortcutFallbackNotification(notificationId)) return;
  openShortcutFallbackSettings(notificationId).catch(() => {});
});

chrome.notifications.onButtonClicked.addListener(notificationId => {
  if (!isShortcutFallbackNotification(notificationId)) return;
  openShortcutFallbackSettings(notificationId).catch(() => {});
});

async function openOnboardingSettings() {
  try {
    await chrome.runtime.openOptionsPage();
  } catch {
    await chrome.tabs.create({ url: chrome.runtime.getURL("options/options.html") });
  }
}

async function openPopupForCommand(cmd) {
  try {
    if (!chrome.action?.openPopup) {
      throw new Error("chrome.action.openPopup is unavailable in this browser context.");
    }
    await chrome.action.openPopup();
    await clearBackgroundFeatureStatus(BACKGROUND_FEATURES.SHORTCUTS).catch(() => {});
  } catch (e) {
    await handlePopupShortcutFallback(cmd, e);
  }
}

async function handlePopupShortcutFallback(cmd, error) {
  const command = shortcutCommandInfo(cmd);
  const status = await recordBackgroundFeatureStatus(BACKGROUND_FEATURES.SHORTCUTS, {
    level: STATUS_LEVELS.WARNING,
    title: "Shortcut could not open popup",
    message: `${command.label} could not open the popup from this Chrome shortcut.`,
    guidance: "Use the toolbar icon, or open Settings to review shortcuts and fallback steps.",
    code: "open_popup_unavailable",
    details: error?.message ?? String(error ?? ""),
    meta: { command: cmd },
  }).catch(() => null);

  try {
    await notifyShortcutFallback(cmd, status);
  } catch {
    await openShortcutSettings().catch(() => {});
  }
}

async function notifyShortcutFallback(cmd, status) {
  const command = shortcutCommandInfo(cmd);
  const message = status
    ? notificationMessageForShortcutStatus(status)
    : `${command.label} could not open the popup from this shortcut. Open Settings to review shortcuts.`;
  await chrome.notifications.create(`${SHORTCUT_FALLBACK_NOTIFICATION_PREFIX}${cmd}`, {
    type: "basic",
    iconUrl: chrome.runtime.getURL("icons/icon128.png"),
    title: "Tab Triage AI shortcut needs attention",
    message,
    priority: 1,
    buttons: [{ title: "Open Settings" }],
  });
}

async function openShortcutFallbackSettings(notificationId) {
  await chrome.notifications.clear(notificationId).catch(() => {});
  await openShortcutSettings();
}

async function openShortcutSettings() {
  const url = chrome.runtime.getURL("options/options.html#section-shortcuts");
  try {
    await chrome.tabs.create({ url });
  } catch {
    await chrome.runtime.openOptionsPage();
  }
}

function isShortcutFallbackNotification(notificationId) {
  return String(notificationId ?? "").startsWith(SHORTCUT_FALLBACK_NOTIFICATION_PREFIX);
}

function shortcutCommandInfo(cmd) {
  switch (cmd) {
    case "search-tabs":
      return { label: "Search tabs and sessions" };
    case "open-popup":
      return { label: "Open Tab Triage AI" };
    default:
      return { label: "The shortcut" };
  }
}

function notificationMessageForShortcutStatus(status) {
  const msg = [status.message, status.guidance].filter(Boolean).join(" ");
  return msg.length > 180 ? `${msg.slice(0, 177)}...` : msg;
}

function formatManualTriageNotification({ groups, candidates, totalCandidates, cap, applySummary }) {
  if (!groups?.length) {
    return {
      title: "Tab Triage AI",
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

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.type === "restore-session") {
    restoreSession({ urls: msg.urls, groups: msg.groups, windowId: msg.windowId }).then(
      result => sendResponse({ ok: true, windowId: result?.windowId ?? null }),
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
