import {
  getSettings,
  listSessions,
  deleteSession,
  saveSessionWithResult,
  updateSession,
  getSessionLimitState,
} from "../lib/storage.js";
import { readTriageCache, saveTriageCache, clearTriageCache } from "../lib/triage_cache.js";
import { LLMError } from "../lib/llm/index.js";
import {
  applyAllAsTabGroups,
  findLiveTabsForUrls,
  focusOrOpenTabByUrl,
  formatApplyFailureMessage,
  restoreSession,
  saveCloseRecoverySession,
  summarizeApplyResults,
} from "../lib/actions.js";
import {
  appendSessionToNotionPage,
  sendSessionToNotion,
  triageToNotionSession,
  NotionError,
} from "../lib/notion.js";
import {
  clearNotionPartialExport,
  loadNotionPartialExport,
  notionExportKey,
  notionGroupsPayload,
  saveNotionPartialExport,
} from "../lib/notion_retry.js";
import { setTriageRunning, formatThresholdLabel } from "../lib/badge.js";
import { applyStoredTheme, watchThemeChanges } from "../lib/theme.js";
import { runQuotaLimitedTriage, TriageQuotaError } from "../lib/triage_quota.js";
import { getStaleTabs, getTriageEligibleTabs, splitStaleBulkActionTabs, staleThresholdMs } from "../lib/tab_policy.js";
import { refreshPlan, openCheckout } from "../lib/billing.js";
import { getPlanQuotaSummary, formatLifetimePrice } from "../lib/plan_quota.js";
import { normalizeTriageGroups } from "../lib/triage_normalize.js";
import {
  BACKGROUND_FEATURES,
  BACKGROUND_STATUS_KEY,
  STATUS_LEVELS,
  formatBackgroundStatusMessage,
  readBackgroundStatus,
} from "../lib/background_status.js";

const $ = sel => document.querySelector(sel);

const state = {
  cache: null,
  missingApiKey: false,
  triageRunning: false,
  staleTabs: [],
  pendingNoteSaves: new Map(),
  noteSaveTimers: new Map(),
  timeRefreshTimer: null,
  timeRefreshVisibilityHandler: null,
  timeRefreshRunning: false,
};

const NOTE_SAVE_ACK_GRACE_MS = 10000;
const TIME_SENSITIVE_REFRESH_MS = 60 * 1000;

const els = {
  statOpen: $("#stat-open"),
  statStale: $("#stat-stale"),
  statStaleLabel: $("#stat-stale-label"),
  statDupes: $("#stat-dupes"),
  statSessions: $("#stat-sessions"),
  triageNow: $("#triage-now"),
  clearHistory: $("#clear-history"),
  openSettings: $("#open-settings"),
  planName: $("#plan-name"),
  planPrice: $("#plan-price"),
  planQuota: $("#plan-quota"),
  planTabLimit: $("#plan-tab-limit"),
  upgradeLifetime: $("#upgrade-lifetime"),
  planSettings: $("#plan-settings"),
  setupCard: $("#setup-card"),
  setupOpenSettings: $("#setup-open-settings"),
  backgroundStatusCard: $("#background-status-card"),
  backgroundStatusMeta: $("#background-status-meta"),
  backgroundStatusList: $("#background-status-list"),
  heroStatus: $("#hero-status"),
  notionNotice: $("#notion-notice"),
  latestMeta: $("#latest-meta"),
  latestBody: $("#latest-body"),
  staleList: $("#stale-list"),
  staleCount: $("#stale-count"),
  staleHelp: $("#stale-help"),
  staleEmpty: $("#stale-empty"),
  staleFooter: $("#stale-footer"),
  archiveAllStale: $("#archive-all-stale"),
  closeAllStale: $("#close-all-stale"),
  dupesList: $("#dupes-list"),
  dupesCount: $("#dupes-count"),
  dupesEmpty: $("#dupes-empty"),
  dupesFooter: $("#dupes-footer"),
  closeAllDupes: $("#close-all-dupes"),
  sessionList: $("#session-list"),
  sessionsCount: $("#sessions-count"),
  sessionsEmpty: $("#sessions-empty"),
  srStatus: $("#sr-status"),
  srAlert: $("#sr-alert"),
};

function announceStatus(msg) {
  announceToLiveRegion(els.srStatus, msg);
}

function announceAlert(msg) {
  announceToLiveRegion(els.srAlert, msg);
}

function announceToLiveRegion(region, msg) {
  if (!region || !msg) return;
  region.textContent = "";
  requestAnimationFrame(() => {
    region.textContent = msg;
  });
}

function selectorAttr(value) {
  return String(value ?? "").replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

function focusElement(el) {
  if (!el || !el.isConnected || el.disabled || el.closest?.(".hidden")) return false;
  const canFocus = el.matches?.("button, a[href], input, textarea, select, [tabindex]");
  if (!canFocus && !el.hasAttribute("tabindex")) el.tabIndex = -1;
  el.focus({ preventScroll: true });
  return document.activeElement === el;
}

function focusFirstAvailable(selectors, root = document) {
  for (const selector of selectors.filter(Boolean)) {
    const el = root.querySelector(selector);
    if (focusElement(el)) return true;
  }
  return false;
}

async function shouldShowNewTabDashboard() {
  try {
    const settings = await getSettings();
    return settings.newtab?.enabled !== false;
  } catch {
    return true;
  }
}

function revealNewTabDashboard() {
  document.body.style.visibility = "";
}

async function init() {
  if (!await shouldShowNewTabDashboard()) {
    window.location.replace("about:blank");
    return;
  }
  try {
    await applyStoredTheme();
  } finally {
    revealNewTabDashboard();
  }
  watchThemeChanges();
  await refreshPlan().catch(() => {});
  els.openSettings.addEventListener("click", openSettings);
  els.planSettings.addEventListener("click", openSettings);
  els.setupOpenSettings.addEventListener("click", openSettings);
  els.upgradeLifetime.addEventListener("click", onUpgradeLifetime);
  els.triageNow.addEventListener("click", onTriageNow);
  els.clearHistory.addEventListener("click", onClearHistory);
  els.closeAllDupes.addEventListener("click", onCloseAllDuplicates);
  els.archiveAllStale.addEventListener("click", onArchiveAllStale);
  els.closeAllStale.addEventListener("click", onCloseAllStale);
  const refreshBillingOnReturn = debounce(() => {
    if (document.visibilityState === "visible") {
      refreshBillingState({ verify: true }).catch(() => {});
    }
  }, 250);
  window.addEventListener("focus", refreshBillingOnReturn);
  document.addEventListener("visibilitychange", refreshBillingOnReturn);
  await Promise.all([
    renderSetupState(),
    renderBillingState(),
    renderBackgroundStatus(),
    renderStats(),
    renderLatest(),
    renderStale(),
    renderDuplicates(),
    renderSessions(),
  ]);
  // Live-update when the auto-triage or popup writes a new cache.
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "local") return;
    if (changes.tt_settings?.newValue?.newtab?.enabled === false) {
      window.location.replace("about:blank");
      return;
    }
    if (changes.tt_settings) {
      renderSetupState().catch(() => {});
      renderBillingState().catch(() => {});
      renderBackgroundStatus().catch(() => {});
    }
    if (changes[BACKGROUND_STATUS_KEY]) renderBackgroundStatus().catch(() => {});
    if (changes.tt_quota) renderBillingState().catch(() => {});
    if (changes.tt_last_triage) renderLatest().catch(() => {});
    if (changes.tt_sessions && !isOwnNoteAutosaveChange(changes.tt_sessions)) {
      renderSessions().catch(() => {});
    }
  });
  // Tab inventory changes — debounce so a rapid burst (opening 10 links
  // at once, navigating, etc.) collapses into one re-render.
  const debouncedTabRefresh = debounce(() => {
    renderStats().catch(() => {});
    renderStale().catch(() => {});
    renderDuplicates().catch(() => {});
  }, 400);
  chrome.tabs.onCreated.addListener(debouncedTabRefresh);
  chrome.tabs.onRemoved.addListener(debouncedTabRefresh);
  chrome.tabs.onUpdated.addListener((_, change) => {
    if (change.url || change.status === "complete") debouncedTabRefresh();
  });
  chrome.tabs.onActivated.addListener(debouncedTabRefresh);
  startTimeSensitiveRefresh();
}

function openSettings() {
  chrome.runtime.openOptionsPage().catch(() => {});
}

async function renderSetupState() {
  const settings = await getSettings();
  state.missingApiKey = !settings.llm?.apiKey;
  els.setupCard.classList.toggle("hidden", !state.missingApiKey);
  els.triageNow.disabled = state.missingApiKey || state.triageRunning;
  els.triageNow.title = state.missingApiKey ? "Add an API key in Settings first." : "";
}

async function refreshBillingState({ verify = false } = {}) {
  if (verify) await refreshPlan().catch(() => {});
  await renderBillingState();
}

async function renderBillingState() {
  const settings = await getSettings();
  const summary = await getPlanQuotaSummary(settings);
  const price = formatLifetimePrice(summary.lifetimePrice);

  els.planName.textContent = summary.isLifetime ? "Lifetime plan" : "Free plan";
  els.planQuota.textContent = summary.isLifetime
    ? "Unlimited triages"
    : `${summary.quota.remaining}/${summary.quota.limit} triages left this week`;
  els.planTabLimit.textContent = Number.isFinite(summary.tabLimit)
    ? `${summary.tabLimit} tabs per triage`
    : "Unlimited tabs per triage";

  if (summary.isLifetime) {
    els.planPrice.textContent = "Unlimited triages and no tab cap.";
    els.upgradeLifetime.classList.add("hidden");
    return;
  }

  els.planPrice.textContent = summary.billingEnabled && price
    ? `${price} one-time upgrade for unlimited.`
    : "Lifetime checkout launching soon.";
  els.upgradeLifetime.classList.remove("hidden");
  els.upgradeLifetime.disabled = false;
  els.upgradeLifetime.textContent = summary.billingEnabled && price
    ? `Buy lifetime - ${price}`
    : "Lifetime soon";
  els.upgradeLifetime.title = summary.billingEnabled
    ? "Open lifetime checkout."
    : "Open Settings for launch details.";
}

async function onUpgradeLifetime() {
  const hadFocus = document.activeElement === els.upgradeLifetime;
  const originalText = els.upgradeLifetime.textContent;
  const originalTitle = els.upgradeLifetime.title;
  els.upgradeLifetime.disabled = true;
  els.upgradeLifetime.textContent = "Opening checkout";
  announceStatus("Opening checkout.");
  try {
    await openCheckout();
    await refreshBillingState({ verify: true });
  } catch (e) {
    setHeroStatus(`Checkout failed: ${e.message ?? e}`, "err");
  } finally {
    els.upgradeLifetime.disabled = false;
    els.upgradeLifetime.textContent = originalText;
    els.upgradeLifetime.title = originalTitle;
    if (hadFocus) focusElement(els.upgradeLifetime);
  }
}

async function renderBackgroundStatus() {
  const [settings, statuses] = await Promise.all([getSettings(), readBackgroundStatus()]);
  const rows = [];
  if (settings.autoTriage?.enabled && statuses[BACKGROUND_FEATURES.AUTO_TRIAGE]) {
    rows.push(["Auto-triage", statuses[BACKGROUND_FEATURES.AUTO_TRIAGE]]);
  }
  if (settings.sync?.enabled && statuses[BACKGROUND_FEATURES.SESSION_SYNC]) {
    rows.push(["Sync", statuses[BACKGROUND_FEATURES.SESSION_SYNC]]);
  }

  if (!rows.length) {
    els.backgroundStatusCard.classList.add("hidden");
    els.backgroundStatusList.innerHTML = "";
    els.backgroundStatusMeta.textContent = "";
    return;
  }

  els.backgroundStatusCard.classList.remove("hidden");
  els.backgroundStatusMeta.textContent = `${rows.length} issue${rows.length === 1 ? "" : "s"}`;
  els.backgroundStatusList.innerHTML = rows.map(([label, status]) => `
    <li class="background-status-item ${backgroundStatusClass(status)}" title="${escapeAttr(status.details || "")}">
      <div class="background-status-title">${escape(label)}</div>
      <div class="background-status-message">${escape(formatBackgroundStatusForCard(status))}</div>
    </li>
  `).join("");
}

function formatBackgroundStatusForCard(status) {
  const base = formatBackgroundStatusMessage(status);
  const seen = status.occurrenceCount > 1 ? `Seen ${status.occurrenceCount} times.` : "";
  const lastSeen = status.updatedAt ? `Last seen ${humanAgo(Date.now() - status.updatedAt)} ago.` : "";
  return [base, seen, lastSeen].filter(Boolean).join(" ");
}

function backgroundStatusClass(status) {
  if (status.level === STATUS_LEVELS.ERROR) return "err";
  if (status.level === STATUS_LEVELS.WARNING) return "warn";
  return "";
}

function debounce(fn, ms) {
  let t = null;
  return (...args) => {
    if (t) clearTimeout(t);
    t = setTimeout(() => fn(...args), ms);
  };
}

function startTimeSensitiveRefresh() {
  if (state.timeRefreshTimer) return;
  state.timeRefreshTimer = setInterval(() => {
    refreshTimeSensitiveContent().catch(() => {});
  }, TIME_SENSITIVE_REFRESH_MS);
  state.timeRefreshVisibilityHandler = () => {
    if (document.visibilityState === "visible") {
      refreshTimeSensitiveContent().catch(() => {});
    }
  };
  document.addEventListener("visibilitychange", state.timeRefreshVisibilityHandler);
  window.addEventListener("pagehide", stopTimeSensitiveRefresh, { once: true });
}

function stopTimeSensitiveRefresh() {
  if (state.timeRefreshTimer) {
    clearInterval(state.timeRefreshTimer);
    state.timeRefreshTimer = null;
  }
  if (state.timeRefreshVisibilityHandler) {
    document.removeEventListener("visibilitychange", state.timeRefreshVisibilityHandler);
    state.timeRefreshVisibilityHandler = null;
  }
  state.timeRefreshRunning = false;
}

async function refreshTimeSensitiveContent() {
  if (document.visibilityState !== "visible" || state.timeRefreshRunning) return;
  state.timeRefreshRunning = true;
  try {
    refreshLatestMeta();
    await Promise.all([
      renderBackgroundStatus(),
      renderStats(),
      renderStale(),
    ]);
  } finally {
    state.timeRefreshRunning = false;
  }
}

function trackNoteAutosave(id, notes) {
  const key = String(id);
  const value = normalizeNote(notes);
  const values = state.pendingNoteSaves.get(key) ?? new Set();
  values.add(value);
  state.pendingNoteSaves.set(key, values);

  const existingTimer = state.noteSaveTimers.get(key);
  if (existingTimer) clearTimeout(existingTimer);
  state.noteSaveTimers.set(key, setTimeout(() => {
    state.pendingNoteSaves.delete(key);
    state.noteSaveTimers.delete(key);
  }, NOTE_SAVE_ACK_GRACE_MS));
}

function clearTrackedNoteAutosave(id, notes) {
  const key = String(id);
  const values = state.pendingNoteSaves.get(key);
  if (!values) return;
  values.delete(normalizeNote(notes));
  if (values.size) return;

  state.pendingNoteSaves.delete(key);
  const timer = state.noteSaveTimers.get(key);
  if (timer) clearTimeout(timer);
  state.noteSaveTimers.delete(key);
}

function isOwnNoteAutosaveChange(change) {
  const oldSessions = Array.isArray(change.oldValue) ? change.oldValue : [];
  const newSessions = Array.isArray(change.newValue) ? change.newValue : [];
  if (!oldSessions.length || oldSessions.length !== newSessions.length) return false;

  const matched = [];
  for (let i = 0; i < newSessions.length; i++) {
    const previous = oldSessions[i];
    const next = newSessions[i];
    if (!previous || !next || previous.id !== next.id) return false;
    if (sessionsMatch(previous, next)) continue;
    if (!sessionsMatchExceptNotes(previous, next)) return false;

    const notes = normalizeNote(next.notes);
    const pending = state.pendingNoteSaves.get(String(next.id));
    if (!pending?.has(notes)) return false;
    matched.push([next.id, notes]);
  }

  if (!matched.length) return false;
  for (const [id, notes] of matched) clearTrackedNoteAutosave(id, notes);
  return true;
}

function sessionsMatch(a, b) {
  return JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
}

function sessionsMatchExceptNotes(a, b) {
  return JSON.stringify(sessionWithoutNotes(a)) === JSON.stringify(sessionWithoutNotes(b));
}

function sessionWithoutNotes(session) {
  const { notes: _notes, ...rest } = session ?? {};
  return rest;
}

function normalizeNote(notes) {
  return String(notes ?? "");
}

async function renderStats() {
  const [tabs, settings, sessions] = await Promise.all([
    chrome.tabs.query({ url: ["http://*/*", "https://*/*"] }),
    getSettings(),
    listSessions(),
  ]);
  els.statOpen.textContent = tabs.length;

  const hours = settings.badge?.thresholdHours ?? 24;
  const thresholdMs = staleThresholdMs(hours);
  const now = Date.now();
  const stale = getStaleTabs(tabs, { now, thresholdMs });
  els.statStale.textContent = stale.length;
  els.statStaleLabel.textContent = `stale (${formatThresholdLabel(hours)})`;

  const { totalRedundant } = computeDuplicates(tabs);
  els.statDupes.textContent = totalRedundant;

  els.statSessions.textContent = sessions.length;
}

function computeDuplicates(tabs) {
  // Group by exact URL — fragments and query strings count, so
  // "?ref=foo" and "?ref=bar" of the same page are NOT duplicates.
  // Most-recently-accessed copy of each URL is the "keep" candidate.
  const byUrl = new Map();
  for (const t of tabs) {
    if (!t.url || !/^https?:/.test(t.url)) continue;
    if (!byUrl.has(t.url)) byUrl.set(t.url, []);
    byUrl.get(t.url).push(t);
  }
  const duplicates = [];
  let totalRedundant = 0;
  for (const [url, list] of byUrl) {
    if (list.length < 2) continue;
    list.sort((a, b) => (b.lastAccessed ?? 0) - (a.lastAccessed ?? 0));
    const keep = list[0];
    const closeable = list.slice(1);
    totalRedundant += closeable.length;
    duplicates.push({
      url,
      title: keep.title || url,
      favIconUrl: keep.favIconUrl,
      keepId: keep.id,
      closeIds: closeable.map(t => t.id),
      closeTabs: closeable.map(t => ({ title: t.title, url: t.url, favIconUrl: t.favIconUrl })),
    });
  }
  duplicates.sort((a, b) => b.closeIds.length - a.closeIds.length);
  return { duplicates, totalRedundant };
}

function captureDuplicateFocus() {
  const active = document.activeElement;
  if (active === els.closeAllDupes) return { type: "dupe-footer" };
  if (!els.dupesList.contains(active)) return null;
  const action = active?.dataset?.action || "";
  return action ? { type: "dupe-row", action } : null;
}

function restoreDuplicateFocus(focus) {
  if (!focus) return;
  if (focus.type === "dupe-footer") {
    focusFirstAvailable([
      "#close-all-dupes:not(:disabled)",
      "#dupes-list button[data-action='close-dupes']",
      "#dupes-card",
    ]);
    return;
  }
  focusFirstAvailable([
    `#dupes-list button[data-action="${selectorAttr(focus.action)}"]:not(:disabled)`,
    "#dupes-list button[data-action='close-dupes']:not(:disabled)",
    "#close-all-dupes:not(:disabled)",
    "#dupes-card",
  ]);
}

async function renderDuplicates({ focus = captureDuplicateFocus() } = {}) {
  const tabs = await chrome.tabs.query({ url: ["http://*/*", "https://*/*"] });
  const { duplicates, totalRedundant } = computeDuplicates(tabs);

  els.dupesCount.textContent = totalRedundant === 0
    ? ""
    : `${totalRedundant} redundant`;

  if (!duplicates.length) {
    els.dupesList.innerHTML = "";
    els.dupesEmpty.classList.remove("hidden");
    els.dupesFooter.classList.add("hidden");
    restoreDuplicateFocus(focus);
    return;
  }
  els.dupesEmpty.classList.add("hidden");
  els.dupesFooter.classList.remove("hidden");
  els.closeAllDupes.textContent = `Close all duplicates · ${totalRedundant}`;

  els.dupesList.innerHTML = "";
  for (const d of duplicates) {
    const li = document.createElement("li");
    const n = d.closeIds.length + 1;
    li.innerHTML = `
      <img class="favicon" src="${escapeAttr(d.favIconUrl || "")}" />
      <div class="dup-body">
        <span class="dup-title" title="${escapeAttr(d.title)}">${escape(d.title)}</span>
        <span class="dup-url" title="${escapeAttr(d.url)}">${escape(d.url)}</span>
      </div>
      <span class="dup-count">${n} copies</span>
      <div class="dup-actions">
        <button data-action="focus" data-keep-id="${d.keepId}" title="Focus the kept tab">Open</button>
        <button data-action="close-dupes" data-close-ids="${d.closeIds.join(",")}" class="danger-subtle" title="Close ${d.closeIds.length} duplicate${d.closeIds.length === 1 ? "" : "s"}">Close ${d.closeIds.length}</button>
      </div>
    `;
    li.querySelectorAll("button[data-action]").forEach(btn => {
      btn.addEventListener("click", () => onDupeAction(btn.dataset.action, btn.dataset, btn));
    });
    els.dupesList.appendChild(li);
  }
  hideBrokenFavicons(els.dupesList);
  restoreDuplicateFocus(focus);
}

async function loadStaleTabs() {
  const [tabs, settings] = await Promise.all([
    chrome.tabs.query({ url: ["http://*/*", "https://*/*"] }),
    getSettings(),
  ]);
  const hours = settings.badge?.thresholdHours ?? 24;
  const thresholdMs = staleThresholdMs(hours);
  const now = Date.now();
  const { staleTabs, actionTabs, protectedTabs } = splitStaleBulkActionTabs(tabs, { now, thresholdMs });
  return { staleTabs, actionTabs, protectedTabs, hours, now };
}

function protectedStaleNote(count) {
  if (!count) return "";
  return ` ${count} active or audible stale tab${count === 1 ? "" : "s"} will stay open.`;
}

function setStaleBulkButtonState({ actionTabs, protectedTabs }) {
  const hasProtected = protectedTabs.length > 0;
  const count = hasProtected ? actionTabs.length : state.staleTabs.length;
  els.closeAllStale.disabled = actionTabs.length === 0;
  els.archiveAllStale.disabled = actionTabs.length === 0;
  els.closeAllStale.textContent = hasProtected ? `Close safe · ${count}` : `Close all · ${count}`;
  els.archiveAllStale.textContent = hasProtected ? `Archive safe · ${count}` : `Archive all · ${count}`;
}

function captureStaleFocus() {
  const active = document.activeElement;
  if (active === els.closeAllStale || active === els.archiveAllStale) {
    return { type: "stale-footer", id: active.id };
  }
  if (!els.staleList.contains(active)) return null;
  if (active?.classList?.contains("tab-close")) return { type: "stale-row" };
  return null;
}

function restoreStaleFocus(focus) {
  if (!focus) return;
  if (focus.type === "stale-footer") {
    focusFirstAvailable([
      `#${selectorAttr(focus.id)}:not(:disabled)`,
      "#stale-list .tab-close",
      "#stale-card",
    ]);
    return;
  }
  focusFirstAvailable([
    "#stale-list .tab-close",
    "#close-all-stale:not(:disabled)",
    "#archive-all-stale:not(:disabled)",
    "#stale-card",
  ]);
}

async function renderStale({ focus = captureStaleFocus() } = {}) {
  const { staleTabs: stale, actionTabs, protectedTabs, hours, now } = await loadStaleTabs();

  state.staleTabs = stale;
  els.staleHelp.textContent = `Tabs you haven't used in ${formatThresholdLabel(hours)}. Pinned tabs are excluded.`;
  els.staleCount.textContent = stale.length === 0 ? "" : `${stale.length} tab${stale.length === 1 ? "" : "s"}`;

  if (!stale.length) {
    els.staleList.innerHTML = "";
    els.staleEmpty.classList.remove("hidden");
    els.staleFooter.classList.add("hidden");
    restoreStaleFocus(focus);
    return;
  }
  els.staleEmpty.classList.add("hidden");
  els.staleFooter.classList.remove("hidden");
  setStaleBulkButtonState({ actionTabs, protectedTabs });

  els.staleList.innerHTML = "";
  for (const t of stale) {
    const li = document.createElement("li");
    const ago = humanAgo(now - (t.lastAccessed ?? now));
    li.innerHTML = `
      <img class="favicon" src="${escapeAttr(t.favIconUrl || "")}" />
      <div class="stale-body">
        <span class="stale-title" title="${escapeAttr(t.title || t.url)}">${escape(t.title || t.url)}</span>
        <span class="stale-meta">${escape(safeHost(t.url))} · ${escape(ago)} ago</span>
      </div>
      <button class="tab-close" data-tab-id="${t.id}" title="Close this tab">×</button>
    `;
    li.querySelector(".tab-close").addEventListener("click", async () => {
      try {
        await chrome.tabs.remove(t.id);
        setHeroStatus(`Closed "${t.title || t.url}".`, "ok");
        await renderStale({ focus: { type: "stale-row" } });
        await renderStats();
      } catch (e) {
        setHeroStatus(`Couldn't close: ${e.message ?? e}`, "err");
      }
    });
    els.staleList.appendChild(li);
  }
  hideBrokenFavicons(els.staleList);
  restoreStaleFocus(focus);
}

async function onCloseAllStale() {
  const { staleTabs, actionTabs, protectedTabs, hours } = await loadStaleTabs();
  if (!staleTabs.length) return;
  if (!actionTabs.length) {
    setHeroStatus("Active or audible stale tabs need to be closed one at a time.", "err");
    await renderStale();
    await renderStats();
    return;
  }
  const label = formatThresholdLabel(hours);
  if (!confirm(`Close ${actionTabs.length} stale tab${actionTabs.length === 1 ? "" : "s"}? A recovery session will be saved first.${protectedStaleNote(protectedTabs.length)}`)) return;
  try {
    await flashAsyncButton(els.closeAllStale, async () => {
      const recovery = await requireCloseRecovery({
        title: `Recovery: stale tabs (${label})`,
        groups: [{
          label: `Stale tabs (${label})`,
          summary: [
            `${actionTabs.length} stale tab${actionTabs.length === 1 ? "" : "s"} (${label})`,
            "Captured from the new-tab dashboard before close-all.",
          ],
          tabs: actionTabs,
        }],
        note: "Saved before closing stale tabs from the new-tab dashboard.",
      });
      await chrome.tabs.remove(actionTabs.map(t => t.id));
      setHeroStatus(`Closed ${actionTabs.length} stale tab${actionTabs.length === 1 ? "" : "s"}. ${closeRecoveryMessage(recovery)}`, "ok");
    }, { sendingLabel: "Saving…", okLabel: "Recoverable" });
    await renderStale({ focus: { type: "stale-footer", id: "close-all-stale" } });
    await renderStats();
    await renderSessions();
  } catch (e) {
    setHeroStatus(`Couldn't close stale tabs: ${e.message ?? e}`, "err");
  }
}

async function onArchiveAllStale() {
  const { staleTabs, actionTabs, protectedTabs, hours } = await loadStaleTabs();
  if (!staleTabs.length) return;
  if (!actionTabs.length) {
    setHeroStatus("Active or audible stale tabs are protected from bulk archive.", "err");
    await renderStale();
    await renderStats();
    return;
  }
  const label = formatThresholdLabel(hours);
  const session = {
    id: `s_${Date.now()}`,
    createdAt: new Date().toISOString(),
    title: `Stale tabs (${label})`,
    groups: [
      {
        label: `Stale tabs (${label})`,
        emoji: "",
        summary: [
          `${actionTabs.length} stale tab${actionTabs.length === 1 ? "" : "s"} (${label})`,
          "Captured from the new-tab dashboard",
          "Restore via Saved sessions to revisit",
        ],
        tabs: actionTabs.map(t => ({ title: t.title, url: t.url, favIconUrl: t.favIconUrl })),
      },
    ],
  };
  try {
    await confirmSessionSaveCapacity("archive these stale tabs", "Archive canceled; no tabs were closed.");
    const saveResult = await saveSessionWithResult(session);
    await chrome.tabs.remove(actionTabs.map(t => t.id));
    const note = protectedTabs.length ? ` ${protectedStaleNote(protectedTabs.length).trim()}` : "";
    const limitNotice = sessionLimitNotice(saveResult);
    setHeroStatus([
      `Archived ${actionTabs.length} stale tab${actionTabs.length === 1 ? "" : "s"} — recoverable from Saved sessions.${note}`,
      limitNotice,
    ].filter(Boolean).join(" "), "ok");
    await renderStale({ focus: { type: "stale-footer", id: "archive-all-stale" } });
    await renderStats();
    await renderSessions();
  } catch (e) {
    setHeroStatus(`Couldn't archive stale tabs: ${e.message ?? e}`, "err");
  }
}

async function onDupeAction(action, dataset, btn) {
  if (action === "focus") {
    const id = Number(dataset.keepId);
    try {
      const tab = await chrome.tabs.get(id);
      await chrome.windows.update(tab.windowId, { focused: true });
      await chrome.tabs.update(id, { active: true });
    } catch (e) {
      setHeroStatus(`Tab no longer exists.`, "err");
    }
  } else if (action === "close-dupes") {
    const ids = (dataset.closeIds || "").split(",").map(Number).filter(n => !Number.isNaN(n));
    if (!ids.length) return;
    try {
      await flashAsyncButton(btn, async () => {
        const tabs = await getLiveTabsByIds(ids);
        const recovery = await requireCloseRecovery({
          title: "Recovery: duplicate tabs",
          groups: [{
            label: "Duplicate tabs",
            summary: [
              `${ids.length} duplicate tab${ids.length === 1 ? "" : "s"} closed`,
              "Most recently used copy was kept.",
            ],
            tabs,
          }],
          note: "Saved before closing duplicate tabs from the new-tab dashboard.",
        });
        await chrome.tabs.remove(ids);
        setHeroStatus(`Closed ${ids.length} duplicate${ids.length === 1 ? "" : "s"}. ${closeRecoveryMessage(recovery)}`, "ok");
      }, { sendingLabel: "Saving…", okLabel: "Recoverable" });
      await renderDuplicates({ focus: { type: "dupe-row", action: "close-dupes" } });
      await renderStats();
      await renderSessions();
    } catch (e) {
      setHeroStatus(`Couldn't close duplicates: ${e.message ?? e}`, "err");
    }
  }
}

async function onCloseAllDuplicates() {
  const tabs = await chrome.tabs.query({ url: ["http://*/*", "https://*/*"] });
  const { duplicates, totalRedundant } = computeDuplicates(tabs);
  if (!totalRedundant) return;
  if (!confirm(`Close ${totalRedundant} duplicate tab${totalRedundant === 1 ? "" : "s"} across ${duplicates.length} URL${duplicates.length === 1 ? "" : "s"}? A recovery session will be saved first. The most recently used copy of each will be kept.`)) return;
  const ids = duplicates.flatMap(d => d.closeIds);
  try {
    await flashAsyncButton(els.closeAllDupes, async () => {
      const recovery = await requireCloseRecovery({
        title: "Recovery: duplicate tabs",
        groups: duplicateRecoveryGroups(duplicates),
        note: "Saved before closing duplicate tabs from the new-tab dashboard.",
      });
      await chrome.tabs.remove(ids);
      setHeroStatus(`Closed ${ids.length} duplicate tab${ids.length === 1 ? "" : "s"}. ${closeRecoveryMessage(recovery)}`, "ok");
    }, { sendingLabel: "Saving…", okLabel: "Recoverable" });
    await renderDuplicates({ focus: { type: "dupe-footer" } });
    await renderStats();
    await renderSessions();
  } catch (e) {
    setHeroStatus(`Couldn't close duplicates: ${e.message ?? e}`, "err");
  }
}

async function requireCloseRecovery(options) {
  await confirmSessionSaveCapacity("save a recovery session", "Recovery save canceled; no tabs were closed.");
  const recovery = await saveCloseRecoverySession(options);
  if (!recovery) throw new Error("No recoverable tabs found; nothing was closed.");
  return recovery;
}

function closeRecoveryMessage(recovery) {
  const limitNotice = sessionLimitNotice(recovery.saveResult);
  return [
    `Recoverable from Saved sessions: "${recovery.session.title}".`,
    limitNotice,
  ].filter(Boolean).join(" ");
}

async function confirmSessionSaveCapacity(actionLabel, cancelMessage) {
  const state = await getSessionLimitState(1);
  if (state.wouldBlock) {
    throw new Error(`Saved session limit reached (${state.count}/${state.limit}). Delete an older session or change the limit in Settings before saving another session.`);
  }
  if (!state.wouldDiscard) return;
  const deleted = state.wouldDiscard === 1
    ? "the oldest saved session"
    : `${state.wouldDiscard} oldest saved sessions`;
  const ok = confirm(`You already have ${state.count} saved sessions. To ${actionLabel}, Tab Triage AI will keep your newest ${state.limit} sessions and delete ${deleted}. Continue?`);
  if (!ok) throw new Error(cancelMessage || "Session save canceled.");
}

function sessionLimitNotice(result) {
  if (!result?.discarded) return "";
  const deleted = result.discarded === 1
    ? "the oldest saved session"
    : `${result.discarded} oldest saved sessions`;
  return `Session limit (${result.limit}) reached; deleted ${deleted}. Change this in Settings.`;
}

function duplicateRecoveryGroups(duplicates) {
  return (duplicates ?? []).map((d, index) => ({
    label: d.title || safeHost(d.url) || `Duplicate URL ${index + 1}`,
    summary: [
      `${(d.closeTabs ?? []).length} duplicate tab${(d.closeTabs ?? []).length === 1 ? "" : "s"} closed`,
      "Most recently used copy was kept.",
    ],
    tabs: d.closeTabs ?? [],
  }));
}

async function getLiveTabsByIds(ids) {
  const tabs = await Promise.all(ids.map(id => chrome.tabs.get(id).catch(() => null)));
  return tabs.filter(Boolean);
}

async function renderLatest({ focus = null } = {}) {
  const cached = await readTriageCache();
  state.cache = cached;
  if (!cached || !cached.groups?.length) {
    els.latestMeta.textContent = "";
    els.latestBody.innerHTML = `
      <div class="empty">
        <p>No triage on file yet.</p>
        <p class="muted">Run one from the popup, enable auto-triage in Settings, or click "Triage now" above.</p>
      </div>
    `;
    restoreLatestFocus(focus);
    return;
  }

  refreshLatestMeta();

  els.latestBody.innerHTML = `<div class="groups"></div>`;
  const container = els.latestBody.querySelector(".groups");
  cached.groups.forEach((g, idx) => {
    container.appendChild(buildGroupNode(g, idx));
  });
  hideBrokenFavicons(els.latestBody);
  restoreLatestFocus(focus);
}

function refreshLatestMeta() {
  const cached = state.cache;
  if (!cached || !cached.groups?.length) return;
  els.latestMeta.textContent = formatLatestMeta(cached);
}

function formatLatestMeta(cached) {
  const createdAt = typeof cached.createdAt === "number"
    ? cached.createdAt
    : Date.parse(cached.createdAt);
  const ageMs = Number.isFinite(createdAt) ? Date.now() - createdAt : 0;
  return `${cached.groups.length} groups · ${humanAgo(Math.max(0, ageMs))} ago`;
}

function buildGroupNode(g, idx) {
  const article = document.createElement("article");
  article.className = "group";
  article.dataset.idx = String(idx);
  article.tabIndex = -1;

  const tabsHtml = (g.tabs ?? [])
    .map(
      t => `
      <li data-url="${escapeAttr(t.url)}">
        <img class="favicon" src="${escapeAttr(t.favIconUrl || "")}" />
        <a href="${escapeAttr(t.url)}" target="_blank" rel="noopener noreferrer" data-action="open-tab" data-tab-url="${escapeAttr(t.url)}" title="${escapeAttr(t.title)}">${escape(t.title)}</a>
        <button class="tab-close" data-action="close-tab" data-tab-url="${escapeAttr(t.url)}" title="Close this tab">×</button>
      </li>
    `,
    )
    .join("");
  const summary = (g.summary ?? []).map(b => `<li>${escape(b)}</li>`).join("");

  article.innerHTML = `
    <header class="group-head">
      <div class="group-label">${escape(g.label || "Group")}</div>
      <span class="group-count">${(g.tabs ?? []).length} tabs</span>
    </header>
    <ul class="group-summary">${summary}</ul>
    <ul class="group-tabs">${tabsHtml}</ul>
    <div class="group-actions">
      <button data-action="archive" class="primary small" title="Save as a session and close these tabs">Archive</button>
      <button data-action="new-window" class="small" title="Move these tabs to a new window">New window</button>
      <button data-action="notion" class="small" title="Send this group to Notion">Send to Notion</button>
      <button data-action="close" class="small danger-subtle" title="Save a recovery session and close these tabs">Close all</button>
    </div>
  `;

  article.querySelectorAll("button[data-action]").forEach(btn => {
    btn.addEventListener("click", e => {
      e.stopPropagation();
      onGroupAction(idx, btn.dataset.action, btn.dataset.tabUrl, btn);
    });
  });

  article.querySelectorAll("a[data-action='open-tab']").forEach(link => {
    link.addEventListener("click", onLatestTabLinkClick);
  });

  return article;
}

function restoreLatestFocus(focus) {
  if (!focus) return;
  if (focus.type === "latest-tab") {
    focusFirstAvailable([
      `#latest-body .group[data-idx="${focus.idx}"] button[data-action="close-tab"]`,
      `#latest-body .group[data-idx="${focus.idx}"] .group-actions button:not(:disabled)`,
      `#latest-body .group[data-idx="${focus.idx}"]`,
      "#latest-card",
    ]);
    return;
  }
  if (focus.type === "latest-group") {
    focusFirstAvailable([
      `#latest-body .group[data-idx="${focus.idx}"] button[data-action="${selectorAttr(focus.action)}"]:not(:disabled)`,
      `#latest-body .group[data-idx="${focus.idx}"] .group-actions button:not(:disabled)`,
      `#latest-body .group[data-idx="${focus.idx + 1}"] .group-actions button:not(:disabled)`,
      `#latest-body .group[data-idx="${Math.max(0, focus.idx - 1)}"] .group-actions button:not(:disabled)`,
      "#latest-card",
    ]);
  }
}

function onLatestTabLinkClick(e) {
  const url = e.currentTarget?.dataset?.tabUrl || e.currentTarget?.href;
  if (!url) return;
  e.preventDefault();
  e.stopPropagation();
  focusOrOpenTabByUrl(url).catch(err => {
    setHeroStatus(`Open failed: ${err.message ?? err}`, "err");
  });
}

async function onGroupAction(idx, action, tabUrlAttr, btn) {
  const cache = state.cache;
  if (!cache) return;
  const g = cache.groups[idx];
  if (!g) return;

  if (action === "close-tab") {
    const url = tabUrlAttr;
    const live = await findLiveTabsForUrls([url]);
    for (const t of live) {
      try { await chrome.tabs.remove(t.id); } catch {}
    }
    g.tabs = g.tabs.filter(t => t.url !== url);
    await persistCacheAndRefresh(cache, { type: "latest-tab", idx });
    setHeroStatus(`Closed 1 tab from "${g.label}".`, "ok");
    return;
  }

  if (action === "notion") {
    const btn = document.querySelector(
      `#latest-body .group[data-idx="${idx}"] button[data-action="notion"]`,
    );
    const groups = [g];
    try {
      await exportSessionToNotion({
        key: notionExportKey("triage-group", notionGroupsPayload(groups)),
        btn,
        sessionFactory: ({ provider }) => triageToNotionSession({
          title: g.label || "Tab group",
          groups,
          provider,
        }),
      });
    } catch {
      // Visible detail is kept in the Notion notice.
    }
    return;
  }

  const liveTabs = await findLiveTabsForUrls(g.tabs.map(t => t.url));

  try {
    if (action === "archive") {
      const session = {
        id: `s_${Date.now()}`,
        createdAt: new Date().toISOString(),
        title: g.label || "Archived group",
        groups: [
          {
            label: g.label,
            emoji: g.emoji,
            summary: g.summary,
            tabs: g.tabs.map(t => ({ title: t.title, url: t.url, favIconUrl: t.favIconUrl })),
          },
        ],
      };
      await confirmSessionSaveCapacity("archive this group", "Archive canceled; no tabs were closed.");
      const saveResult = await saveSessionWithResult(session);
      if (liveTabs.length) await chrome.tabs.remove(liveTabs.map(t => t.id));
      cache.groups.splice(idx, 1);
      await persistCacheAndRefresh(cache, { type: "latest-group", idx, action });
      await renderSessions();
      await renderStats();
      const limitNotice = sessionLimitNotice(saveResult);
      setHeroStatus([
        `Archived "${g.label}" — ${liveTabs.length} tab${liveTabs.length === 1 ? "" : "s"} closed, recoverable from Saved sessions.`,
        limitNotice,
      ].filter(Boolean).join(" "), "ok");
    } else if (action === "new-window") {
      if (!liveTabs.length) {
        setHeroStatus(`No live tabs left for "${g.label}".`, "err");
        return;
      }
      const win = await chrome.windows.create({ tabId: liveTabs[0].id, focused: true });
      if (liveTabs.length > 1) {
        await chrome.tabs.move(liveTabs.slice(1).map(t => t.id), { windowId: win.id, index: -1 });
      }
      cache.groups.splice(idx, 1);
      await persistCacheAndRefresh(cache, { type: "latest-group", idx, action });
      setHeroStatus(`Moved ${liveTabs.length} tab${liveTabs.length === 1 ? "" : "s"} to a new window.`, "ok");
    } else if (action === "close") {
      if (!confirm(`Close ${g.tabs.length} tabs in "${g.label}"? A recovery session will be saved first.`)) return;
      const recovery = liveTabs.length ? await requireCloseRecovery({
        title: `Recovery: ${g.label || "tab group"}`,
        groups: [{ ...g, tabs: liveTabs }],
        note: "Saved before closing this group from the new-tab dashboard.",
      }) : null;
      if (liveTabs.length) await chrome.tabs.remove(liveTabs.map(t => t.id));
      cache.groups.splice(idx, 1);
      await persistCacheAndRefresh(cache, { type: "latest-group", idx, action });
      await renderSessions();
      if (recovery) {
        if (btn) btn.textContent = "Recoverable";
        setHeroStatus(`Closed ${liveTabs.length} tab${liveTabs.length === 1 ? "" : "s"} from "${g.label}". ${closeRecoveryMessage(recovery)}`, "ok");
      } else {
        setHeroStatus(`Closed ${liveTabs.length} tab${liveTabs.length === 1 ? "" : "s"} from "${g.label}".`, "ok");
      }
    }
  } catch (e) {
    setHeroStatus(`Action failed: ${e.message ?? e}`, "err");
    if (btn) focusElement(btn);
  }
}

async function persistCacheAndRefresh(cache, focus = null) {
  // Preserve the original triage timestamp — these mutations are not a
  // fresh triage, just edits to an existing one.
  await saveTriageCache({
    windowId: cache.windowId,
    groups: cache.groups,
    createdAt: cache.createdAt,
  });
  await renderLatest({ focus });
  await renderStats();
}

function captureSessionFocus() {
  const active = document.activeElement;
  if (!els.sessionList.contains(active)) return null;
  if (active?.matches?.("textarea.session-notes")) {
    return {
      type: "session-notes",
      id: active.dataset.id,
      selectionStart: active.selectionStart,
      selectionEnd: active.selectionEnd,
    };
  }
  const action = active?.dataset?.action;
  const id = active?.dataset?.id;
  if (action && id) return { type: "session-action", action, id };
  return null;
}

function restoreSessionFocus(focus) {
  if (!focus) return;
  if (focus.type === "session-notes") {
    const textarea = els.sessionList.querySelector(`textarea.session-notes[data-id="${selectorAttr(focus.id)}"]`);
    if (focusElement(textarea)) {
      const start = Number.isInteger(focus.selectionStart) ? focus.selectionStart : textarea.value.length;
      const end = Number.isInteger(focus.selectionEnd) ? focus.selectionEnd : start;
      textarea.setSelectionRange(start, end);
    }
    return;
  }
  if (focus.type === "session-action") {
    focusFirstAvailable([
      `#session-list button[data-action="${selectorAttr(focus.action)}"][data-id="${selectorAttr(focus.id)}"]`,
      `#session-list button[data-id="${selectorAttr(focus.id)}"]`,
      "#session-list button[data-action]",
      "#sessions-card",
    ]);
    return;
  }
  if (focus.type === "session-list") {
    focusFirstAvailable([
      "#session-list button[data-action]",
      "#sessions-card",
    ]);
  }
}

async function renderSessions({ focus = captureSessionFocus() } = {}) {
  const sessions = await listSessions();
  els.sessionsCount.textContent = `${sessions.length}`;
  if (!sessions.length) {
    els.sessionList.innerHTML = "";
    els.sessionsEmpty.classList.remove("hidden");
    restoreSessionFocus(focus);
    return;
  }
  els.sessionsEmpty.classList.add("hidden");
  els.sessionList.innerHTML = "";
  for (const s of sessions) {
    const totalTabs = s.groups.reduce((n, g) => n + g.tabs.length, 0);
    const summary = (s.groups[0]?.summary?.[0] ?? "").slice(0, 140);
    const li = document.createElement("li");
    const notesValue = s.notes ?? "";
    li.innerHTML = `
      <div class="session-meta">
        <span>${escape(new Date(s.createdAt).toLocaleString())}</span>
        <span>${s.groups.length} groups · ${totalTabs} tabs</span>
      </div>
      <div class="session-title">${escape(s.title)}</div>
      ${summary ? `<div class="session-summary">${escape(summary)}</div>` : ""}
      <textarea class="session-notes" data-id="${s.id}" rows="1" placeholder="Add a note for this session…">${escape(notesValue)}</textarea>
      <div class="session-actions">
        <button data-action="restore-here" data-id="${s.id}" class="primary small">Open here</button>
        <button data-action="restore-new" data-id="${s.id}" class="small">New window</button>
        <button data-action="rename" data-id="${s.id}" class="small">Rename</button>
        <button data-action="copy" data-id="${s.id}" class="small">Copy Markdown</button>
        <button data-action="notion" data-id="${s.id}" class="small">Send to Notion</button>
        <button data-action="delete" data-id="${s.id}" class="small danger-subtle">Delete</button>
      </div>
    `;
    els.sessionList.appendChild(li);
  }
  els.sessionList.querySelectorAll("button[data-action]").forEach(btn => {
    btn.addEventListener("click", () => onSessionAction(btn.dataset.action, btn.dataset.id, sessions));
  });
  // Debounced save-on-input for notes — no save button needed.
  els.sessionList.querySelectorAll("textarea.session-notes").forEach(ta => {
    const id = ta.dataset.id;
    const persist = debounce(async () => {
      const notes = ta.value;
      trackNoteAutosave(id, notes);
      try {
        await updateSession(id, { notes });
        announceStatus("Note saved.");
      } catch (e) {
        clearTrackedNoteAutosave(id, notes);
        announceAlert(`Note save failed: ${e.message ?? e}`);
        throw e;
      }
    }, 500);
    ta.addEventListener("input", persist);
    ta.addEventListener("input", () => {
      const session = sessions.find(x => x.id === id);
      if (session) session.notes = ta.value;
    });
    // Auto-grow rows so the textarea expands as the user types.
    ta.addEventListener("input", () => {
      ta.style.height = "auto";
      ta.style.height = `${Math.min(ta.scrollHeight, 200)}px`;
    });
    if (ta.value) {
      ta.style.height = "auto";
      ta.style.height = `${Math.min(ta.scrollHeight, 200)}px`;
    }
  });
  restoreSessionFocus(focus);
}

async function onSessionAction(action, id, sessions) {
  const s = sessions.find(x => x.id === id);
  if (!s) return;
  if (action === "restore-here" || action === "restore-new") {
    const tabCount = sessionTabCount(s);
    if (!tabCount) return;
    try {
      if (action === "restore-here") {
        const win = await chrome.windows.getCurrent();
        await restoreSession({ groups: s.groups, windowId: win.id });
        setHeroStatus(`Opened "${s.title}" in this window (${tabCount} tabs).`, "ok");
      } else {
        await restoreSession({ groups: s.groups });
        setHeroStatus(`Opened "${s.title}" in a new window (${tabCount} tabs).`, "ok");
      }
    } catch (e) {
      setHeroStatus(`Restore failed: ${e.message ?? e}`, "err");
    }
  } else if (action === "delete") {
    if (confirm("Delete this session?")) {
      await deleteSession(id);
      await renderSessions({ focus: { type: "session-list" } });
      await renderStats();
      setHeroStatus(`Deleted saved session "${s.title}".`, "ok");
    }
  } else if (action === "rename") {
    const nextTitle = prompt("Rename saved session", s.title ?? "");
    if (nextTitle == null) return;
    const title = nextTitle.trim();
    if (!title) {
      setHeroStatus("Enter a title to rename this session.", "err");
      return;
    }
    await updateSession(id, { title });
    s.title = title;
    await renderSessions({ focus: { type: "session-action", action: "rename", id } });
    setHeroStatus(`Renamed saved session to "${title}".`, "ok");
  } else if (action === "copy") {
    await navigator.clipboard.writeText(sessionToMarkdown(s));
    setHeroStatus(`Copied "${s.title}" as Markdown.`, "ok");
  } else if (action === "notion") {
    const btn = els.sessionList.querySelector(`button[data-action="notion"][data-id="${id}"]`);
    try {
      await exportSessionToNotion({
        key: notionExportKey("session", { id: s.id, createdAt: s.createdAt }),
        btn,
        sessionFactory: () => s,
      });
    } catch {
      // Visible detail is kept in the Notion notice.
    }
  }
}

async function exportSessionToNotion({ key, btn, sessionFactory }) {
  const pending = loadNotionPartialExport(key);
  await flashAsyncButton(btn, async () => {
    const { token, parentPageId, provider } = await assertNotionReady();
    const session = pending?.session ?? sessionFactory({ provider });
    try {
      const page = pending
        ? await appendSessionToNotionPage({
          session,
          token,
          pageId: pending.pageId,
          pageUrl: pending.pageUrl,
          startBlockIndex: pending.nextBlockIndex,
        })
        : await sendSessionToNotion({ session, token, parentPageId });
      clearNotionPartialExport(key);
      showNotionNotice({
        tone: "ok",
        message: pending
          ? "Appended the remaining blocks to the existing Notion page."
          : "Sent to Notion.",
        pageUrl: page?.url || pending?.pageUrl,
        linkLabel: "Open page",
      });
    } catch (e) {
      if (e instanceof NotionError) {
        handleNotionExportFailure({ key, session, error: e });
      }
      throw e;
    }
  }, {
    sendingLabel: pending ? "Appending…" : "Sending…",
    okLabel: pending ? "Appended" : "Sent",
  });
}

function handleNotionExportFailure({ key, session, error }) {
  if (error.pageId) {
    const record = {
      key,
      session,
      pageId: error.pageId,
      pageUrl: error.pageUrl,
      nextBlockIndex: error.nextBlockIndex,
      totalBlocks: error.totalBlocks,
      errorMessage: error.message,
    };
    saveNotionPartialExport(record);
    showNotionNotice({
      tone: "error",
      message: partialNotionFailureMessage(record, error),
      pageUrl: record.pageUrl,
      linkLabel: "Open partial page",
    });
    return;
  }
  showNotionNotice({
    tone: "error",
    message: `Notion export failed: ${error.message}`,
  });
}

function partialNotionFailureMessage(record, error) {
  const total = Number.isInteger(record.totalBlocks) ? record.totalBlocks : 0;
  const next = Number.isInteger(record.nextBlockIndex) ? record.nextBlockIndex : 0;
  const progress = total ? ` after writing ${Math.min(next, total)} of ${total} blocks` : "";
  const remainingCount = total ? Math.max(total - next, 0) : null;
  const remaining = remainingCount == null
    ? "the remaining blocks"
    : `${remainingCount} remaining ${remainingCount === 1 ? "block" : "blocks"}`;
  return `Notion created a partial page${progress}, then failed: ${error.message}. Click Send to Notion again to append ${remaining} to that page instead of creating another page.`;
}

function showNotionNotice({ message, tone = "", pageUrl = "", linkLabel = "Open page" }) {
  if (!els.notionNotice) return;
  els.notionNotice.classList.remove("is-error", "is-ok", "is-warn");
  if (tone) els.notionNotice.classList.add(`is-${tone}`);
  els.notionNotice.textContent = "";
  const text = document.createElement("span");
  text.textContent = message;
  els.notionNotice.append(text);
  if (pageUrl) {
    els.notionNotice.append(" ");
    const link = document.createElement("a");
    link.href = pageUrl;
    link.target = "_blank";
    link.rel = "noopener noreferrer";
    link.textContent = linkLabel;
    els.notionNotice.append(link);
  }
  els.notionNotice.classList.remove("hidden");
}

async function onTriageNow() {
  setHeroStatus("");
  const hadFocus = document.activeElement === els.triageNow;
  const settings = await getSettings();
  if (!settings.llm?.apiKey) {
    await renderSetupState();
    setHeroStatus("Add an API key in Settings first.", "err");
    return;
  }
  const win = await chrome.windows.getCurrent().catch(() => null);
  if (!win) {
    setHeroStatus("Couldn't find a focused window.", "err");
    return;
  }
  // Reassess all triage-eligible tabs — grouped tabs included.
  const tabs = await chrome.tabs.query({ windowId: win.id });
  const candidates = getTriageEligibleTabs(tabs, settings);
  if (candidates.length < 2) {
    setHeroStatus("Need at least 2 non-excluded tabs to triage.", "err");
    return;
  }

  state.triageRunning = true;
  els.triageNow.disabled = true;
  els.triageNow.textContent = "Triaging…";
  setHeroStatus("Triaging tabs.");
  await setTriageRunning(true).catch(() => {});
  try {
    const { result } = await runQuotaLimitedTriage({
      settings,
      tabs: candidates,
      onPreflight: ({ cap }) => {
        if (cap.applied) setHeroStatus(cap.message);
      },
      afterTriage: async ({ rawGroups, tabs: triageCandidates, cap }) => {
        const groups = normalizeTriageGroups({ rawGroups, tabs: triageCandidates });
        const applyResults = await applyAllAsTabGroups({ groups });
        const applySummary = summarizeApplyResults({ groups, results: applyResults });
        await saveTriageCache({ windowId: win.id, groups });
        await renderLatest();
        await renderStats();
        return { groups, cap, applySummary };
      },
    });
    setHeroStatus(formatApplyStatus(result.applySummary, result.cap), result.applySummary.failedGroupCount ? "err" : "ok");
  } catch (e) {
    if (e instanceof TriageQuotaError) {
      setHeroStatus(e.message, "err");
    } else {
      const msg = e instanceof LLMError ? e.message : (e.message ?? String(e));
      const details = e instanceof LLMError ? e.details : "";
      setHeroStatus(`Triage failed: ${msg}`, "err", details);
    }
  } finally {
    await setTriageRunning(false).catch(() => {});
    state.triageRunning = false;
    els.triageNow.disabled = state.missingApiKey;
    els.triageNow.textContent = "Triage now";
    await renderBillingState().catch(() => {});
    if (hadFocus) focusElement(els.triageNow);
  }
}

async function onClearHistory() {
  const cached = await readTriageCache();
  if (!cached || !cached.groups?.length) {
    setHeroStatus("No triage history to clear.", "");
    return;
  }
  if (!confirm("Clear the latest triage from the dashboard? Open tabs and saved sessions are not affected.")) return;
  try {
    await clearTriageCache();
    state.cache = null;
    await renderLatest();
    setHeroStatus("Triage history cleared.", "ok");
  } catch (e) {
    setHeroStatus(`Couldn't clear history: ${e.message ?? e}`, "err");
  }
}

function setHeroStatus(msg, cls = "", details = "") {
  els.heroStatus.textContent = msg;
  els.heroStatus.title = details;
  els.heroStatus.className = `status muted ${cls}`;
  els.heroStatus.setAttribute("role", cls === "err" ? "alert" : "status");
  els.heroStatus.setAttribute("aria-live", cls === "err" ? "assertive" : "polite");
}

function formatApplyStatus(summary, cap) {
  const scopedCount = cap?.applied
    ? `${summary.groupedTabCount} of ${cap.originalCount}`
    : String(summary.groupedTabCount);
  const groupWord = summary.groupedGroupCount === 1 ? "group" : "groups";
  if (summary.failedGroupCount) {
    const successPrefix = summary.groupedGroupCount
      ? `Grouped ${scopedCount} tabs into ${summary.groupedGroupCount} ${groupWord}. `
      : "No tab groups were applied. ";
    return `${successPrefix}${formatApplyFailureMessage(summary)}`;
  }
  if (!summary.groupedGroupCount) return "Triage finished, but no tab groups were applied.";
  return `Grouped ${scopedCount} tabs into ${summary.groupedGroupCount} ${groupWord}.`;
}

// Wrap an async action with a button's inline "Sending… / Sent / Failed"
// states so feedback lives next to the cause instead of at the top of
// the page. Failure puts the message in the button's title attribute.
async function flashAsyncButton(btn, action, { sendingLabel = "Sending…", okLabel = "Sent", failLabel = "Failed" } = {}) {
  if (!btn) return action();
  const hadFocus = document.activeElement === btn;
  const originalText = btn.textContent;
  const originalTitle = btn.title;
  btn.disabled = true;
  btn.textContent = sendingLabel;
  announceStatus(sendingLabel);
  try {
    await action();
    btn.textContent = okLabel;
    announceStatus(okLabel);
    setTimeout(() => {
      btn.textContent = originalText;
      btn.title = originalTitle;
      btn.disabled = false;
      if (hadFocus) focusElement(btn);
    }, 1800);
  } catch (e) {
    btn.textContent = e?.shortLabel || failLabel;
    btn.title = e?.message ?? String(e);
    announceAlert(e?.message ?? String(e));
    setTimeout(() => {
      btn.textContent = originalText;
      btn.title = originalTitle;
      btn.disabled = false;
      if (hadFocus) focusElement(btn);
    }, 2800);
    throw e;
  }
}

class GateError extends Error {
  constructor(message, shortLabel) {
    super(message);
    this.shortLabel = shortLabel;
  }
}

async function assertNotionReady() {
  const settings = await getSettings();
  if (settings.plan !== "lifetime") {
    throw new GateError(
      "Notion export is a lifetime feature. Open Settings to upgrade.",
      "Lifetime only",
    );
  }
  const { token, parentPageId } = settings.notion ?? {};
  if (!token || !parentPageId) {
    throw new GateError(
      "Set up Notion in Settings (token + parent page) first.",
      "Set up first",
    );
  }
  return { token, parentPageId, provider: settings.llm?.provider };
}

function sessionToMarkdown(s) {
  let out = `# ${s.title}\n\n_${new Date(s.createdAt).toLocaleString()}_\n\n`;
  for (const g of s.groups) {
    out += `## ${g.label}\n\n`;
    for (const b of g.summary ?? []) out += `- ${b}\n`;
    out += `\n`;
    for (const t of g.tabs) out += `- [${t.title}](${t.url})\n`;
    out += `\n`;
  }
  return out;
}

function sessionTabCount(session) {
  return (session?.groups ?? []).reduce((count, group) => (
    count + (group?.tabs ?? []).filter(tab => typeof tab?.url === "string" && tab.url.trim()).length
  ), 0);
}

function hideBrokenFavicons(root) {
  root.querySelectorAll("img.favicon").forEach(img => {
    if (!img.getAttribute("src")) {
      img.style.visibility = "hidden";
      return;
    }
    const hide = () => (img.style.visibility = "hidden");
    img.addEventListener("error", hide);
    if (img.complete && img.naturalWidth === 0) hide();
  });
}

function safeHost(url) {
  try { return new URL(url).hostname.replace(/^www\./, ""); } catch { return ""; }
}

function humanAgo(ms) {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h} h`;
  return `${Math.round(h / 24)} d`;
}

function escape(s) {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}
function escapeAttr(s) {
  return escape(s).replace(/"/g, "&quot;");
}

init().catch(e => setHeroStatus(`Init error: ${e.message ?? e}`, "err"));
