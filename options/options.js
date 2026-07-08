import {
  getSettings,
  saveSettings,
  listSessions,
  importSessions,
  previewSessionImport,
  getSessionLimitState,
  SESSION_LIMIT_CHOICES,
  SESSION_OVERFLOW_BLOCK_NEW,
  SESSION_OVERFLOW_DISCARD_OLDEST,
} from "../lib/storage.js";
import { refreshPlan, openCheckout, openLogin, billingEnabled, lifetimePriceUsd } from "../lib/billing.js";
import { pauseAutoTriage, resumeAutoTriage } from "../lib/auto_triage.js";
import { updateBadge } from "../lib/badge.js";
import { PROVIDERS, pingProvider, LLMError } from "../lib/llm/index.js";
import { onSyncEnabledChange } from "../lib/session_sync.js";
import { pingNotion, extractPageId, NotionError } from "../lib/notion.js";
import { applyStoredTheme, applyTheme, watchThemeChanges } from "../lib/theme.js";
import {
  BACKGROUND_FEATURES,
  BACKGROUND_STATUS_KEY,
  STATUS_LEVELS,
  clearBackgroundFeatureStatus,
  formatBackgroundStatusMessage,
  getBackgroundFeatureStatus,
} from "../lib/background_status.js";

const $ = sel => document.querySelector(sel);

const els = {
  provider: $("#llm-provider"),
  providerHelp: $("#llm-key-help"),
  key: $("#api-key"),
  model: $("#llm-model"),
  modelHelp: $("#llm-model-help"),
  baseUrlField: $("#llm-baseurl-field"),
  baseUrl: $("#llm-baseurl"),
  baseUrlHelp: $("#llm-baseurl-help"),
  instructions: $("#llm-instructions"),
  toggle: $("#toggle-visibility"),
  save: $("#save"),
  test: $("#test"),
  status: $("#status"),
  planStatus: $("#plan-status"),
  planActions: $("#plan-actions"),
  waitlistWrap: $("#waitlist-wrap"),
  waitlistRow: $("#waitlist-row"),
  waitlistEmail: $("#waitlist-email"),
  waitlist: $("#waitlist"),
  waitlistStatus: $("#waitlist-status"),
  autoEnabled: $("#auto-enabled"),
  autoConfig: $("#auto-config"),
  autoDebounce: $("#auto-debounce"),
  autoThrottle: $("#auto-throttle"),
  autoMinTabs: $("#auto-min-tabs"),
  autoNotify: $("#auto-notify"),
  pause1h: $("#pause-1h"),
  pauseTilTomorrow: $("#pause-til-tomorrow"),
  resume: $("#resume"),
  autoStatus: $("#auto-status"),
  badgeEnabled: $("#badge-enabled"),
  badgeThreshold: $("#badge-threshold"),
  badgeThresholdCustomOpt: $("#badge-threshold-custom-opt"),
  badgeThresholdCustom: $("#badge-threshold-custom"),
  badgeThresholdCustomValue: $("#badge-threshold-custom-value"),
  badgeThresholdCustomUnit: $("#badge-threshold-custom-unit"),
  badgeThresholdCustomHint: $("#badge-threshold-custom-hint"),
  badgeStatus: $("#badge-status"),
  sleepEnabled: $("#sleep-enabled"),
  syncEnabled: $("#sync-enabled"),
  syncStatus: $("#sync-status"),
  notionToken: $("#notion-token"),
  notionParent: $("#notion-parent"),
  notionParentHint: $("#notion-parent-hint"),
  notionPlanNote: $("#notion-plan-note"),
  notionToggle: $("#notion-toggle"),
  notionSave: $("#notion-save"),
  notionTest: $("#notion-test"),
  notionStatus: $("#notion-status"),
  themeRadios: document.querySelectorAll('input[name="theme"]'),
  themeHelp: $("#theme-help"),
  newtabEnabled: $("#newtab-enabled"),
  newtabStatus: $("#newtab-status"),
  shortcutList: $("#shortcut-list"),
  shortcutSettings: $("#shortcut-settings"),
  shortcutStatus: $("#shortcut-status"),
  sessionLimit: $("#session-limit"),
  sessionOverflow: $("#session-overflow"),
  sessionLimitStatus: $("#session-limit-status"),
  exportBtn: $("#export-settings"),
  importBtn: $("#import-settings"),
  importFile: $("#import-file"),
  dataStatus: $("#data-status"),
  dataHint: $("#data-hint"),
};

const providerDrafts = {};
let activeLlmProvider = "";

const CHROME_SHORTCUT_SETTINGS_URL = "chrome://extensions/shortcuts";
const SHORTCUT_ORDER = ["open-popup", "search-tabs", "triage-now"];
const SHORTCUT_COPY = Object.freeze({
  "open-popup": {
    label: "Open Tab Triage AI",
    description: "Opens the popup from anywhere Chrome accepts extension shortcuts.",
  },
  "search-tabs": {
    label: "Search tabs and sessions",
    description: "Opens the popup with the search field ready for typing.",
  },
  "triage-now": {
    label: "Triage current window",
    description: "Runs tab grouping for the last focused Chrome window.",
  },
});

function setStatusElement(el, msg, cls = "", details = "") {
  if (!el) return;
  el.textContent = msg;
  el.title = details;
  el.className = `status ${cls}`;
  setLiveStatusMode(el, cls);
}

function setStatusHtml(el, html, cls = "", details = "") {
  if (!el) return;
  el.innerHTML = html;
  el.title = details;
  el.className = cls || "muted";
  setLiveStatusMode(el, cls);
}

function setLiveStatusMode(el, cls = "") {
  el.setAttribute("role", cls === "err" ? "alert" : "status");
  el.setAttribute("aria-live", cls === "err" ? "assertive" : "polite");
  el.setAttribute("aria-atomic", "true");
}

async function init() {
  await applyStoredTheme();
  watchThemeChanges();
  initSectionNav();

  const settings = await getSettings();

  populateProviderOptions();
  activeLlmProvider = settings.llm.provider;
  seedProviderDraft(activeLlmProvider, settings.llm);
  setProviderUi(activeLlmProvider);
  els.key.value = settings.llm.apiKey ?? "";
  applyProviderDraft(activeLlmProvider);
  els.instructions.value = settings.llm.customInstructions ?? "";

  els.provider.addEventListener("change", () => {
    rememberProviderDraft(activeLlmProvider);
    const provider = els.provider.value;
    activeLlmProvider = provider;
    setProviderUi(provider);
    applyProviderDraft(provider);
    latestLlmTestId += 1;
  });

  els.toggle.addEventListener("click", () => {
    const showing = els.key.type === "text";
    els.key.type = showing ? "password" : "text";
    els.toggle.textContent = showing ? "Show" : "Hide";
  });
  els.save.addEventListener("click", onSave);
  els.test.addEventListener("click", onTest);
  els.waitlist.addEventListener("click", onWaitlist);

  await renderPlan();
  await initTheme();
  await initNewTab(settings);
  await initShortcuts();
  await initAutoTriage(settings);
  await initBadge(settings);
  await initSync(settings);
  await initNotion(settings);
  await initDataSection();
  watchBackgroundStatusChanges();
}

function initSectionNav() {
  const links = Array.from(document.querySelectorAll(".page-nav a"));
  const entries = [];
  for (const a of links) {
    const target = document.querySelector(a.getAttribute("href"));
    if (target) entries.push({ link: a, target });
  }
  if (!entries.length) return;

  const setActive = link => {
    for (const e of entries) e.link.classList.toggle("active", e.link === link);
  };

  // A nav click locks that link in until the user actively scrolls. Trailing
  // sections (Backup/Privacy) can't always be scrolled up to the trigger
  // line — the page is already at max scroll — so plain scroll-spy would
  // resolve them to whatever section sits at the top of the viewport.
  let pinned = null;
  for (const e of entries) {
    e.link.addEventListener("click", () => {
      pinned = e.link;
      setActive(e.link);
    });
  }
  const releasePin = () => { pinned = null; };
  window.addEventListener("wheel", releasePin, { passive: true });
  window.addEventListener("touchstart", releasePin, { passive: true });
  window.addEventListener("keydown", e => {
    if (["ArrowUp", "ArrowDown", "PageUp", "PageDown", "Home", "End", " "].includes(e.key)) {
      releasePin();
    }
  });

  // Trigger line sits just past a section's anchored resting position
  // (driven by `scroll-margin-top` on `section.card`), so the section a
  // user just clicked actually crosses it.
  const scrollMargin = parseFloat(getComputedStyle(entries[0].target).scrollMarginTop) || 0;
  const triggerOffset = scrollMargin + 8;

  const update = () => {
    if (pinned) { setActive(pinned); return; }
    // Section that straddles the trigger line is "in focus".
    for (const e of entries) {
      const r = e.target.getBoundingClientRect();
      if (r.top <= triggerOffset && r.bottom > triggerOffset) {
        setActive(e.link);
        return;
      }
    }
    // No straddler: above the first section or past the last. Pick by
    // which end of the page we're closer to.
    const scroller = document.scrollingElement || document.documentElement;
    const pastEnd = scroller.scrollTop > scroller.scrollHeight - window.innerHeight - 4;
    setActive(pastEnd ? entries[entries.length - 1].link : entries[0].link);
  };

  let scheduled = false;
  const onScroll = () => {
    if (scheduled) return;
    scheduled = true;
    requestAnimationFrame(() => { scheduled = false; update(); });
  };
  window.addEventListener("scroll", onScroll, { passive: true });
  window.addEventListener("resize", onScroll);
  update();
}

async function initTheme() {
  // Plan refresh just ran in renderPlan(); re-read cached settings so
  // lifetime gates keep using the preserved local plan if refresh is stale.
  const fresh = await getSettings();
  const isLifetime = fresh.plan === "lifetime";
  const current = fresh.display?.theme ?? "system";

  els.themeHelp.textContent = isLifetime
    ? "Pick a theme for the settings and new-tab pages."
    : "Dark mode is a Lifetime feature. Free plan is light only.";

  for (const radio of els.themeRadios) {
    radio.checked = radio.value === (isLifetime ? current : "light");
    radio.disabled = !isLifetime && radio.value !== "light";
    radio.addEventListener("change", async () => {
      if (!radio.checked) return;
      const theme = radio.value;
      await saveSettings({ display: { theme } });
      applyTheme(theme);
    });
  }
}

async function initNewTab(settings) {
  els.newtabEnabled.checked = settings.newtab?.enabled !== false;
  els.newtabEnabled.addEventListener("change", async () => {
    const enabled = els.newtabEnabled.checked;
    await saveSettings({ newtab: { enabled } });
    setStatusElement(
      els.newtabStatus,
      enabled ? "New-tab dashboard enabled." : "New tabs will open as blank pages.",
      "ok",
    );
  });
}

async function initShortcuts() {
  els.shortcutSettings.addEventListener("click", openChromeShortcutSettings);
  const rendered = await renderShortcuts();
  if (rendered) await refreshShortcutStatus();
}

async function renderShortcuts() {
  try {
    const commands = await chrome.commands.getAll();
    const byName = new Map(commands.map(command => [command.name, command]));
    const ordered = SHORTCUT_ORDER
      .map(name => ({ name, ...(byName.get(name) ?? {}) }))
      .filter(command => SHORTCUT_COPY[command.name]);
    els.shortcutList.replaceChildren(...ordered.map(renderShortcutItem));
    return true;
  } catch (e) {
    els.shortcutList.replaceChildren();
    setShortcutStatus(`Could not read shortcuts: ${e.message ?? e}`, "err");
    return false;
  }
}

function renderShortcutItem(command) {
  const copy = SHORTCUT_COPY[command.name];
  const item = document.createElement("li");
  item.className = "shortcut-item";

  const text = document.createElement("div");
  const name = document.createElement("div");
  name.className = "shortcut-name";
  name.textContent = copy.label;
  const description = document.createElement("div");
  description.className = "shortcut-description";
  description.textContent = command.description || copy.description;
  text.append(name, description);

  const key = document.createElement("kbd");
  key.className = `shortcut-key${command.shortcut ? "" : " unset"}`;
  key.textContent = command.shortcut || "Not set";

  item.append(text, key);
  return item;
}

async function openChromeShortcutSettings() {
  setShortcutStatus("Opening Chrome shortcut settings.", "");
  try {
    await chrome.tabs.create({ url: CHROME_SHORTCUT_SETTINGS_URL });
    setShortcutStatus("Chrome shortcut settings opened in a new tab.", "ok");
  } catch (e) {
    setShortcutStatus(
      `Open ${CHROME_SHORTCUT_SETTINGS_URL} in Chrome to change shortcuts.`,
      "warn",
      e?.message ?? String(e ?? ""),
    );
  }
}

async function refreshShortcutStatus() {
  const status = await getBackgroundFeatureStatus(BACKGROUND_FEATURES.SHORTCUTS);
  if (status) {
    setShortcutStatus(formatInlineBackgroundStatus(status), statusClass(status), status.details || "");
  } else {
    setShortcutStatus("", "");
  }
}

function setShortcutStatus(msg, cls, details = "") {
  setStatusElement(els.shortcutStatus, msg, cls, details);
}

async function initNotion(settings) {
  const fresh = await getSettings();
  const isLifetime = fresh.plan === "lifetime";
  const notionSettings = fresh.notion ?? settings.notion ?? {};

  els.notionToken.value = notionSettings.token ?? "";
  const savedParentInput = notionSettings.parentPageInput || notionSettings.parentPageId || "";
  els.notionParent.value = savedParentInput;
  setNotionParentHint(notionSettings.parentPageId);
  renderNotionPlanGate(isLifetime);

  els.notionToggle.addEventListener("click", () => {
    if (!isLifetime) {
      setNotionStatus("Notion export is a Lifetime feature.", "warn");
      return;
    }
    const showing = els.notionToken.type === "text";
    els.notionToken.type = showing ? "password" : "text";
    els.notionToggle.textContent = showing ? "Show" : "Hide";
  });

  els.notionParent.addEventListener("input", () => {
    setNotionParentHint();
  });

  els.notionSave.addEventListener("click", async () => {
    if (!isLifetime) {
      setNotionStatus("Notion export is a Lifetime feature.", "warn");
      return;
    }
    const token = els.notionToken.value.trim();
    const parentRaw = els.notionParent.value.trim();
    const parentPageId = extractPageId(parentRaw);
    if (!token || !parentPageId) {
      setNotionStatus("Enter both a token and a parent page.", "err");
      return;
    }
    await saveSettings({ notion: { token, parentPageId, parentPageInput: parentRaw } });
    setNotionParentHint(parentPageId);
    setNotionStatus("Saved. Parent page resolved.", "ok");
  });

  els.notionTest.addEventListener("click", async () => {
    if (!isLifetime) {
      setNotionStatus("Notion export is a Lifetime feature.", "warn");
      return;
    }
    const token = els.notionToken.value.trim();
    const parentPageId = extractPageId(els.notionParent.value.trim());
    if (!token || !parentPageId) {
      setNotionStatus("Enter both a token and a parent page.", "err");
      return;
    }
    setNotionStatus("Testing…", "");
    try {
      await pingNotion({ token, parentPageId });
      setNotionParentHint(parentPageId);
      setNotionStatus("Connected. The integration can see this page.", "ok");
    } catch (e) {
      const msg = e instanceof NotionError ? e.message : (e.message ?? String(e));
      setNotionStatus(
        msg.includes("Could not find page")
          ? `${msg} — did you invite the integration to the page (⋯ → Connections)?`
          : `Failed: ${msg}`,
        "err",
      );
    }
  });
}

function renderNotionPlanGate(isLifetime) {
  const price = lifetimePriceUsd();
  const lockedCopy = billingEnabled()
    ? `Notion export requires Lifetime ($${price} one-time). Upgrade in the Plan section before setting up token and page access.`
    : "Notion export requires Lifetime. Checkout is not live yet, so setup will unlock when Lifetime checkout launches.";
  els.notionPlanNote.textContent = isLifetime
    ? "Notion export is included with your Lifetime plan. Your token stays on this device and is used only when you send an export."
    : lockedCopy;
  els.notionPlanNote.classList.toggle("warn", !isLifetime);

  for (const control of [
    els.notionToken,
    els.notionParent,
    els.notionToggle,
    els.notionSave,
    els.notionTest,
  ]) {
    control.disabled = !isLifetime;
  }
  setNotionStatus(isLifetime ? "" : "Lifetime required before setup.", isLifetime ? "" : "warn");
}

function setNotionParentHint(parentPageId) {
  els.notionParentHint.textContent = parentPageId
    ? `Each export becomes a child page of this one. Resolved page ID ending ${parentPageId.slice(-8)}.`
    : "Each export becomes a child page of this one.";
}

function setNotionStatus(msg, cls) {
  setStatusElement(els.notionStatus, msg, cls);
}

async function initSync(settings) {
  els.syncEnabled.checked = !!settings.sync?.enabled;
  await refreshSyncStatus(settings.sync);
  els.syncEnabled.addEventListener("change", async () => {
    const enabled = els.syncEnabled.checked;
    await saveSettings({ sync: { enabled } });
    setStatusElement(els.syncStatus, enabled ? "Syncing…" : "Sync disabled. Sync silo cleared.");
    try {
      await onSyncEnabledChange(enabled);
      if (enabled) {
        const hasStatus = await refreshSyncStatus({ enabled: true });
        if (!hasStatus) {
          setStatusElement(els.syncStatus, "Sync enabled. Saved sessions will appear on other Chromes signed in to this account.", "ok");
        }
      } else {
        setStatusElement(els.syncStatus, "Sync disabled. Sessions stay local-only on this device.", "ok");
      }
    } catch (e) {
      const hasStatus = await refreshSyncStatus({ enabled: true });
      if (!hasStatus) {
        setStatusElement(els.syncStatus, `Sync error: ${e.message ?? e}`, "err");
      }
    }
  });
}

async function refreshSyncStatus(sync) {
  if (!sync?.enabled) {
    setStatusElement(els.syncStatus, "");
    return false;
  }
  const status = await getBackgroundFeatureStatus(BACKGROUND_FEATURES.SESSION_SYNC);
  if (!status) {
    setStatusElement(els.syncStatus, "");
    return false;
  }
  setStatusElement(els.syncStatus, formatInlineBackgroundStatus(status), statusClass(status), status.details || "");
  return true;
}

function populateProviderOptions() {
  els.provider.innerHTML = "";
  for (const [id, p] of Object.entries(PROVIDERS)) {
    const opt = document.createElement("option");
    opt.value = id;
    opt.textContent = p.label;
    els.provider.appendChild(opt);
  }
}

function setProviderUi(provider) {
  els.provider.value = provider;
  const p = PROVIDERS[provider];
  if (!p) return;
  renderSafeHelpLinks(els.providerHelp, p.keyHelp);
  els.key.placeholder = p.keyPlaceholder || "sk-...";
  els.baseUrlField.classList.toggle("hidden", !p.supportsBaseUrl);
  els.baseUrl.disabled = !p.supportsBaseUrl;
  els.model.placeholder = p.defaultModel;
  els.modelHelp.textContent = p.modelHelp || "Defaults to a cheap/fast model for the selected AI provider. Override if you want.";
  els.baseUrl.placeholder = p.baseUrlPlaceholder || "";
  els.baseUrlHelp.textContent = p.baseUrlHelp || "";
  if (!p.supportsBaseUrl) els.baseUrl.value = "";
}

const HELP_URL_RE = /\bhttps?:\/\/[^\s<>"']+/g;
const TRAILING_URL_PUNCTUATION_RE = /[.,!?;:)]$/;

function renderSafeHelpLinks(el, text) {
  const value = String(text ?? "");
  const nodes = [];
  let cursor = 0;

  for (const match of value.matchAll(HELP_URL_RE)) {
    const rawMatch = match[0];
    const matchStart = match.index ?? 0;
    const { urlText, suffix } = splitTrailingUrlPunctuation(rawMatch);
    const anchor = createSafeHelpLink(urlText);

    if (!anchor) continue;
    if (matchStart > cursor) {
      nodes.push(document.createTextNode(value.slice(cursor, matchStart)));
    }
    nodes.push(anchor);
    if (suffix) nodes.push(document.createTextNode(suffix));
    cursor = matchStart + rawMatch.length;
  }

  if (cursor < value.length) {
    nodes.push(document.createTextNode(value.slice(cursor)));
  }

  el.replaceChildren(...(nodes.length ? nodes : [document.createTextNode(value)]));
}

function splitTrailingUrlPunctuation(rawUrl) {
  let urlText = rawUrl;
  let suffix = "";
  while (TRAILING_URL_PUNCTUATION_RE.test(urlText)) {
    suffix = urlText.slice(-1) + suffix;
    urlText = urlText.slice(0, -1);
  }
  return { urlText, suffix };
}

function createSafeHelpLink(urlText) {
  let url;
  try {
    url = new URL(urlText);
  } catch {
    return null;
  }
  if (!["https:", "http:"].includes(url.protocol)) return null;

  const link = document.createElement("a");
  link.href = url.href;
  link.textContent = urlText;
  link.target = "_blank";
  link.rel = "noopener";
  return link;
}

function cleanFormText(value) {
  return String(value ?? "").trim();
}

function seedProviderDraft(provider, llm) {
  const p = PROVIDERS[provider];
  if (!p) return;
  providerDrafts[provider] = {
    model: cleanFormText(llm?.model) || p.defaultModel || "",
    baseUrl: p.supportsBaseUrl ? cleanFormText(llm?.baseUrl) : "",
  };
}

function rememberProviderDraft(provider) {
  const p = PROVIDERS[provider];
  if (!p) return;
  providerDrafts[provider] = {
    model: cleanFormText(els.model.value),
    baseUrl: p.supportsBaseUrl ? cleanFormText(els.baseUrl.value) : "",
  };
}

function applyProviderDraft(provider) {
  const p = PROVIDERS[provider];
  if (!p) return;
  const draft = providerDrafts[provider] ?? {};
  els.model.value = draft.model || p.defaultModel || "";
  els.baseUrl.value = p.supportsBaseUrl ? (draft.baseUrl || "") : "";
}

const THRESHOLD_PRESETS = new Set([1, 4, 12, 24, 72, 168]);

function hoursToDisplay(hours) {
  if (hours > 0 && hours < 1) {
    return { value: Math.max(1, Math.round(hours * 60)), unit: "minutes" };
  }
  if (hours >= 24 && hours % 24 === 0) {
    return { value: hours / 24, unit: "days" };
  }
  return { value: Math.max(1, Math.round(hours)), unit: "hours" };
}

function unitToHours(value, unit) {
  if (unit === "minutes") return value / 60;
  if (unit === "days") return value * 24;
  return value;
}

async function initBadge(settings) {
  // Plan refresh just ran in renderPlan(); read settings again so we pick up
  // verified changes, while preserving the cached local plan on refresh failure.
  const fresh = await getSettings();
  const isLifetime = fresh.plan === "lifetime";
  const cfg = fresh.badge;
  let currentThresholdHours = cfg.thresholdHours;

  els.badgeEnabled.checked = !!cfg.enabled;
  els.sleepEnabled.checked = !!fresh.sleep?.enabled;

  els.badgeThresholdCustomOpt.disabled = !isLifetime;
  els.badgeThresholdCustomOpt.textContent = isLifetime ? "Custom…" : "Custom… (Lifetime)";
  els.badgeThresholdCustomHint.textContent = isLifetime
    ? "Set any custom interval."
    : "Lifetime feature. Upgrade in the Plan section above.";

  applyThresholdToUi(cfg.thresholdHours, isLifetime);
  await refreshBadgeStatus();

  els.badgeEnabled.addEventListener("change", async () => {
    const enabled = els.badgeEnabled.checked;
    await saveSettings({ badge: { enabled } });
    await refreshBadgeStatus();
  });

  els.badgeThreshold.addEventListener("change", async () => {
    if (els.badgeThreshold.value === "custom") {
      if (!isLifetime) {
        applyThresholdToUi(currentThresholdHours, false);
        setStatusElement(els.badgeStatus, "Custom intervals are a Lifetime feature.", "err");
        return;
      }
      applyCustomThresholdToUi(currentThresholdHours, true);
      return;
    }
    els.badgeThresholdCustom.classList.add("hidden");
    currentThresholdHours = Number(els.badgeThreshold.value);
    await saveSettings({ badge: { thresholdHours: currentThresholdHours } });
    await refreshBadgeStatus();
  });

  async function persistCustomThreshold() {
    const raw = Number(els.badgeThresholdCustomValue.value);
    if (!Number.isFinite(raw) || raw <= 0) {
      setStatusElement(els.badgeStatus, "Enter a positive number.", "err");
      return;
    }
    const hours = unitToHours(raw, els.badgeThresholdCustomUnit.value);
    currentThresholdHours = hours;
    await saveSettings({ badge: { thresholdHours: hours } });
    await refreshBadgeStatus();
  }
  els.badgeThresholdCustomValue.addEventListener("change", persistCustomThreshold);
  els.badgeThresholdCustomUnit.addEventListener("change", persistCustomThreshold);

  els.sleepEnabled.addEventListener("change", async () => {
    await saveSettings({ sleep: { enabled: els.sleepEnabled.checked } });
  });
}

function applyThresholdToUi(hours, isLifetime) {
  const isPreset = THRESHOLD_PRESETS.has(hours);
  if (isPreset) {
    els.badgeThreshold.value = String(hours);
    els.badgeThresholdCustom.classList.add("hidden");
    return;
  }
  // Non-preset value — show the custom inputs. If the user is on free
  // (e.g. lapsed lifetime), preserve their value but disable editing.
  applyCustomThresholdToUi(hours, isLifetime);
}

function applyCustomThresholdToUi(hours, isLifetime) {
  els.badgeThreshold.value = "custom";
  els.badgeThresholdCustom.classList.remove("hidden");
  const display = hoursToDisplay(hours);
  els.badgeThresholdCustomValue.value = String(display.value);
  els.badgeThresholdCustomUnit.value = display.unit;
  els.badgeThresholdCustomValue.disabled = !isLifetime;
  els.badgeThresholdCustomUnit.disabled = !isLifetime;
}

async function refreshBadgeStatus() {
  try {
    const settings = await getSettings();
    const result = await updateBadge();
    if (!settings.badge?.enabled) {
      setStatusElement(els.badgeStatus, "Threshold saved for dashboard and auto-sleep. Toolbar badge is off.", "ok");
      return;
    }
    const count = result.staleCount ?? result.count ?? 0;
    setStatusElement(els.badgeStatus, count === 0
      ? "Currently 0 stale tabs."
      : `Currently ${count} stale tab${count === 1 ? "" : "s"}.`, "ok");
  } catch (e) {
    setStatusElement(els.badgeStatus, `Could not read tabs: ${e.message ?? e}`, "err");
  }
}

async function initAutoTriage(settings) {
  const at = settings.autoTriage;
  els.autoEnabled.checked = !!at.enabled;
  els.autoDebounce.value = String(at.debounceSeconds);
  els.autoThrottle.value = String(at.throttleSeconds);
  els.autoMinTabs.value = String(at.minTabs);
  els.autoNotify.checked = !!at.notify;
  els.autoConfig.classList.toggle("hidden", !at.enabled);
  await refreshAutoStatus(at);

  els.autoEnabled.addEventListener("change", async () => {
    const enabled = els.autoEnabled.checked;
    await saveSettings({ autoTriage: { enabled } });
    if (!enabled) await clearBackgroundFeatureStatus(BACKGROUND_FEATURES.AUTO_TRIAGE).catch(() => {});
    els.autoConfig.classList.toggle("hidden", !enabled);
    setAutoStatus(enabled ? "Auto-triage on." : "Auto-triage off.", "ok");
  });

  const persist = key => async ev => {
    const val = ev.target.type === "checkbox" ? ev.target.checked : Number(ev.target.value);
    await saveSettings({ autoTriage: { [key]: val } });
    setAutoStatus("Saved.", "ok");
  };
  els.autoDebounce.addEventListener("change", persist("debounceSeconds"));
  els.autoThrottle.addEventListener("change", persist("throttleSeconds"));
  els.autoMinTabs.addEventListener("change", persist("minTabs"));
  els.autoNotify.addEventListener("change", persist("notify"));

  els.pause1h.addEventListener("click", async () => {
    await pauseAutoTriage(60);
    const fresh = (await getSettings()).autoTriage;
    await refreshAutoStatus(fresh);
  });
  els.pauseTilTomorrow.addEventListener("click", async () => {
    const tomorrow = new Date();
    tomorrow.setHours(9, 0, 0, 0);
    if (tomorrow <= new Date()) tomorrow.setDate(tomorrow.getDate() + 1);
    const minutes = Math.ceil((tomorrow.getTime() - Date.now()) / 60_000);
    await pauseAutoTriage(minutes);
    const fresh = (await getSettings()).autoTriage;
    await refreshAutoStatus(fresh);
  });
  els.resume.addEventListener("click", async () => {
    await resumeAutoTriage();
    const fresh = (await getSettings()).autoTriage;
    await refreshAutoStatus(fresh);
  });
}

async function refreshAutoStatus(at) {
  if (!at.enabled) {
    setAutoStatus("", "");
    els.resume.classList.add("hidden");
    return;
  }
  const isPaused = at.pausedUntil && Date.now() < at.pausedUntil;
  const status = await getBackgroundFeatureStatus(BACKGROUND_FEATURES.AUTO_TRIAGE);
  if (status) {
    setAutoStatus(formatInlineBackgroundStatus(status), statusClass(status), status.details || "");
    els.resume.classList.toggle("hidden", !isPaused);
  } else if (isPaused) {
    const when = new Date(at.pausedUntil);
    setAutoStatus(`Paused until ${when.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`, "");
    els.resume.classList.remove("hidden");
  } else if (at.lastRunAt) {
    const ago = humanAgo(Date.now() - at.lastRunAt);
    setAutoStatus(`Last run ${ago} ago.`, "");
    els.resume.classList.add("hidden");
  } else {
    setAutoStatus("", "");
    els.resume.classList.add("hidden");
  }
}

function humanAgo(ms) {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h`;
  return `${Math.round(h / 24)}d`;
}

function setAutoStatus(msg, cls, details = "") {
  setStatusElement(els.autoStatus, msg, cls, details);
}

function watchBackgroundStatusChanges() {
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "local" || !changes[BACKGROUND_STATUS_KEY]) return;
    refreshAutoStatusFromSettings().catch(() => {});
    refreshSyncStatusFromSettings().catch(() => {});
    refreshShortcutStatus().catch(() => {});
  });
}

async function refreshAutoStatusFromSettings() {
  const settings = await getSettings();
  await refreshAutoStatus(settings.autoTriage);
}

async function refreshSyncStatusFromSettings() {
  const settings = await getSettings();
  await refreshSyncStatus(settings.sync);
}

function formatInlineBackgroundStatus(status) {
  const base = formatBackgroundStatusMessage(status);
  const seen = status.occurrenceCount > 1 ? ` Seen ${status.occurrenceCount} times.` : "";
  const lastSeen = status.updatedAt ? ` Last seen ${humanAgo(Date.now() - status.updatedAt)} ago.` : "";
  return `${base}${seen}${lastSeen}`;
}

function statusClass(status) {
  if (status.level === STATUS_LEVELS.ERROR) return "err";
  if (status.level === STATUS_LEVELS.WARNING) return "warn";
  return "";
}

async function renderPlan() {
  els.planActions.innerHTML = "";
  const price = lifetimePriceUsd();

  if (!billingEnabled()) {
    setStatusHtml(els.planStatus, `You're on <strong>Free</strong>. Lifetime checkout isn't live yet — we're polishing it before launch.`);
    els.waitlistWrap.classList.remove("hidden");
    els.waitlistRow.classList.remove("hidden");
    return;
  }

  const planRefresh = await refreshPlan();
  const { plan, verified } = planRefresh;
  if (plan === "lifetime") {
    setStatusHtml(els.planStatus, verified
      ? `You own <strong>Lifetime</strong>. Thanks for supporting the project.`
      : `You own <strong>Lifetime</strong>, saved on this browser. Paid status could not be refreshed.`);
    addAction("Restore on another browser", openLogin);
    els.waitlistWrap.classList.add("hidden");
    els.waitlistRow.classList.add("hidden");
    return;
  }

  setStatusHtml(els.planStatus, verified
    ? `You're on <strong>Free</strong>.`
    : `You're on <strong>Free</strong>. Paid status could not be refreshed.`);
  addAction(`Buy lifetime access · $${price}`, () => openCheckout(), "primary");
  addAction("Already paid? Sign in", openLogin);
  els.waitlistWrap.classList.add("hidden");
  els.waitlistRow.classList.add("hidden");
}

function addAction(label, handler, variant = "ghost") {
  const btn = document.createElement("button");
  btn.className = variant;
  btn.textContent = label;
  btn.addEventListener("click", handler);
  els.planActions.appendChild(btn);
}

let latestLlmTestId = 0;

function readLlmFormSettings() {
  const provider = els.provider.value;
  rememberProviderDraft(provider);
  const providerConfig = PROVIDERS[provider];
  const draft = providerDrafts[provider] ?? {};
  const apiKey = els.key.value.trim();
  const model = cleanFormText(draft.model) || providerConfig?.defaultModel || "";
  const baseUrl = providerConfig?.supportsBaseUrl ? cleanFormText(draft.baseUrl) : "";
  const customInstructions = els.instructions.value.trim();
  return { provider, apiKey, model, baseUrl, customInstructions };
}

function fingerprintLlmSettings(llm) {
  return [llm.provider, llm.apiKey, llm.model, llm.baseUrl, llm.customInstructions]
    .map(value => JSON.stringify(value ?? ""))
    .join("|");
}

function validateLlmFormSettings(llm) {
  if (!llm.apiKey) {
    setStatus("Enter a key first.", "err");
    return false;
  }
  const expectedPrefix = PROVIDERS[llm.provider]?.keyPrefix;
  if (expectedPrefix && !llm.apiKey.startsWith(expectedPrefix)) {
    setStatus(`That doesn't look like a ${PROVIDERS[llm.provider].label} key (expected prefix "${expectedPrefix}").`, "err");
    return false;
  }
  return true;
}

async function onSave() {
  const llm = readLlmFormSettings();
  if (!validateLlmFormSettings(llm)) return;
  latestLlmTestId += 1;
  await saveSettings({ llm });
  setStatus("Saved.", "ok");
}

async function onTest() {
  const llm = readLlmFormSettings();
  if (!validateLlmFormSettings(llm)) return;
  const testId = ++latestLlmTestId;
  const testedFingerprint = fingerprintLlmSettings(llm);
  setStatus("Testing…", "");
  try {
    await pingProvider({ settings: { llm } });
    if (testId !== latestLlmTestId) return;
    const currentLlm = readLlmFormSettings();
    const currentFingerprint = fingerprintLlmSettings(currentLlm);
    if (currentFingerprint !== testedFingerprint) {
      setStatus("Connection works, but settings changed before the test finished. Test again to save the latest settings.", "err");
      return;
    }
    await saveSettings({ llm: currentLlm });
    setStatus("Connection works. Settings saved. You're good to triage.", "ok");
  } catch (e) {
    if (testId !== latestLlmTestId) return;
    const msg = e instanceof LLMError ? e.message : `Network error: ${e.message ?? e}`;
    const details = e instanceof LLMError ? e.details : "";
    setStatus(`Failed: ${msg}`, "err", details);
  }
}

async function onWaitlist() {
  const email = els.waitlistEmail.value.trim();
  if (!/.+@.+\..+/.test(email)) {
    setStatusElement(els.waitlistStatus, "Enter a valid email.", "err");
    return;
  }
  await chrome.storage.local.set({ tt_waitlist_email: email });
  setStatusElement(els.waitlistStatus, "Saved locally. Email jankoszy@gmail.com to lock in the launch discount.", "ok");
}

function setStatus(msg, cls, details = "") {
  setStatusElement(els.status, msg, cls, details);
}

async function initDataSection() {
  const fresh = await getSettings();
  const isLifetime = fresh.plan === "lifetime";

  await initSessionLimitControls(fresh);

  if (!isLifetime) {
    els.exportBtn.disabled = true;
    els.importBtn.disabled = true;
    els.dataHint.textContent = "Settings and sessions backup is a Lifetime feature. Upgrade in the Plan section above.";
    return;
  }

  els.exportBtn.addEventListener("click", onExport);
  els.importBtn.addEventListener("click", () => els.importFile.click());
  els.importFile.addEventListener("change", onImport);
}

async function initSessionLimitControls(settings) {
  els.sessionLimit.innerHTML = "";
  for (const limit of SESSION_LIMIT_CHOICES) {
    const opt = document.createElement("option");
    opt.value = String(limit);
    opt.textContent = `${limit} saved sessions`;
    els.sessionLimit.appendChild(opt);
  }
  els.sessionLimit.value = String(settings.sessions?.limit ?? 100);
  els.sessionOverflow.value = settings.sessions?.overflow === SESSION_OVERFLOW_BLOCK_NEW
    ? SESSION_OVERFLOW_BLOCK_NEW
    : SESSION_OVERFLOW_DISCARD_OLDEST;

  const save = async () => {
    await saveSettings({
      sessions: {
        limit: Number(els.sessionLimit.value),
        overflow: els.sessionOverflow.value,
      },
    });
    await renderSessionLimitStatus();
  };
  els.sessionLimit.addEventListener("change", save);
  els.sessionOverflow.addEventListener("change", save);
  await renderSessionLimitStatus();
}

async function renderSessionLimitStatus() {
  const state = await getSessionLimitState(0);
  const countText = `${state.count}/${state.limit} saved sessions.`;
  const overLimit = Math.max(0, state.count - state.limit);
  let policyText;
  if (state.overflow === SESSION_OVERFLOW_BLOCK_NEW) {
    policyText = "When full, new session saves stop until you delete older sessions or raise the limit.";
  } else if (overLimit) {
    policyText = `The next session save will keep the newest ${state.limit} and delete ${overLimit + 1} oldest saved sessions.`;
  } else {
    policyText = `When full, saving a new session keeps the newest ${state.limit} and deletes the oldest one first.`;
  }
  setStatusElement(
    els.sessionLimitStatus,
    `${countText} ${policyText}`,
    state.count >= state.limit ? "warn" : "",
  );
}

async function onExport() {
  const settings = await getSettings();
  const sessions = await listSessions();
  // Strip the legacy root-level apiKey (always "" post-migration; would
  // confuse readers into thinking there are two separate keys).
  const { apiKey, ...exportable } = settings;
  const backup = {
    version: 1,
    exportedAt: new Date().toISOString(),
    settings: exportable,
    sessions,
  };
  const json = JSON.stringify(backup, null, 2);
  const blob = new Blob([json], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = "tab-triage-backup.json";
  a.click();
  URL.revokeObjectURL(url);
  setDataStatus(`Exported ${sessions.length} saved session${sessions.length === 1 ? "" : "s"}. Keep this file private — it contains your API keys.`, "ok");
}

async function onImport() {
  const file = els.importFile.files[0];
  if (!file) return;
  let parsed;
  try {
    parsed = JSON.parse(await file.text());
  } catch {
    setDataStatus("Invalid JSON file.", "err");
    els.importFile.value = "";
    return;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    setDataStatus("Unrecognized format — expected a JSON object.", "err");
    els.importFile.value = "";
    return;
  }
  const hasSettingsEnvelope = parsed.settings &&
    typeof parsed.settings === "object" &&
    !Array.isArray(parsed.settings);
  const settingsSource = hasSettingsEnvelope ? parsed.settings : { ...parsed };
  if (!hasSettingsEnvelope && Array.isArray(settingsSource.sessions)) {
    delete settingsSource.sessions;
  }
  delete settingsSource.version;
  delete settingsSource.exportedAt;

  // Numeric field sanity checks for the most critical settings.
  if (settingsSource.autoTriage?.debounceSeconds !== undefined &&
      !Number.isFinite(settingsSource.autoTriage.debounceSeconds)) {
    setDataStatus("Import rejected: autoTriage.debounceSeconds must be a number.", "err");
    els.importFile.value = "";
    return;
  }
  if (settingsSource.badge?.thresholdHours !== undefined &&
      !Number.isFinite(settingsSource.badge.thresholdHours)) {
    setDataStatus("Import rejected: badge.thresholdHours must be a number.", "err");
    els.importFile.value = "";
    return;
  }
  if (settingsSource.sessions?.limit !== undefined &&
      !Number.isFinite(Number(settingsSource.sessions.limit))) {
    setDataStatus("Import rejected: sessions.limit must be a number.", "err");
    els.importFile.value = "";
    return;
  }
  // Strip plan — it is always authoritative from ExtPay, never from a file.
  // Also strip the legacy root-level apiKey so migration logic stays clean.
  const { plan, apiKey, ...rest } = settingsSource;
  try {
    if (Array.isArray(parsed.sessions)) {
      await confirmSessionImportCapacity(parsed.sessions, rest);
    }
    await saveSettings(rest);
    let sessionResult = null;
    if (Array.isArray(parsed.sessions)) {
      sessionResult = await importSessions(parsed.sessions);
    }
    const sessionText = sessionResult
      ? ` Imported ${sessionResult.imported} saved session${sessionResult.imported === 1 ? "" : "s"}${sessionResult.discarded ? `; ${sessionResult.discarded} older session${sessionResult.discarded === 1 ? "" : "s"} were outside the limit` : ""}.`
      : "";
    setDataStatus(`Imported.${sessionText} Reloading…`, "ok");
    setTimeout(() => location.reload(), 800);
  } catch (e) {
    setDataStatus(`Import failed: ${e.message ?? e}`, "err");
    els.importFile.value = "";
  }
}

async function confirmSessionImportCapacity(incomingSessions, importedSettings) {
  const preview = await previewSessionImport(incomingSessions, importedSettings);
  if (preview.wouldBlock) {
    throw new Error(`Import would exceed the saved session limit (${preview.projectedCount}/${preview.limit}). Delete older sessions or change the limit before importing this backup.`);
  }
  if (!preview.wouldDiscard) return;
  const deleted = preview.wouldDiscard === 1
    ? "the oldest saved session"
    : `${preview.wouldDiscard} oldest saved sessions`;
  const ok = confirm(`This backup contains ${preview.imported} saved sessions. Importing it will keep your newest ${preview.limit} sessions and delete ${deleted}. Continue?`);
  if (!ok) throw new Error("Import canceled before changing saved sessions.");
}

function setDataStatus(msg, cls) {
  setStatusElement(els.dataStatus, msg, cls);
}

init();
