import { getSettings, saveSettings } from "../lib/storage.js";
import { refreshPlan, openCheckout, openLogin, billingEnabled, lifetimePriceUsd } from "../lib/billing.js";
import { pauseAutoTriage, resumeAutoTriage } from "../lib/auto_triage.js";
import { updateBadge } from "../lib/badge.js";
import { PROVIDERS, pingProvider, LLMError } from "../lib/llm/index.js";
import { onSyncEnabledChange } from "../lib/session_sync.js";
import { pingNotion, extractPageId, NotionError } from "../lib/notion.js";

const $ = sel => document.querySelector(sel);

const els = {
  provider: $("#llm-provider"),
  providerHelp: $("#llm-key-help"),
  key: $("#api-key"),
  model: $("#llm-model"),
  baseUrlField: $("#llm-baseurl-field"),
  baseUrl: $("#llm-baseurl"),
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
  badgeConfig: $("#badge-config"),
  badgeThreshold: $("#badge-threshold"),
  badgeStatus: $("#badge-status"),
  sleepEnabled: $("#sleep-enabled"),
  syncEnabled: $("#sync-enabled"),
  syncStatus: $("#sync-status"),
  notionToken: $("#notion-token"),
  notionParent: $("#notion-parent"),
  notionToggle: $("#notion-toggle"),
  notionSave: $("#notion-save"),
  notionTest: $("#notion-test"),
  notionStatus: $("#notion-status"),
};

async function init() {
  const settings = await getSettings();

  populateProviderOptions();
  setProviderUi(settings.llm.provider);
  els.key.value = settings.llm.apiKey ?? "";
  els.model.value = settings.llm.model ?? "";
  els.baseUrl.value = settings.llm.baseUrl ?? "";
  els.instructions.value = settings.llm.customInstructions ?? "";

  els.provider.addEventListener("change", () => {
    const provider = els.provider.value;
    setProviderUi(provider);
    // Preselect the provider's default model if the field is empty so
    // users don't have to know model names by heart.
    if (!els.model.value.trim()) {
      els.model.value = PROVIDERS[provider]?.defaultModel ?? "";
    }
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
  await initAutoTriage(settings);
  await initBadge(settings);
  await initSync(settings);
  await initNotion(settings);
}

async function initNotion(settings) {
  els.notionToken.value = settings.notion?.token ?? "";
  els.notionParent.value = settings.notion?.parentPageId ?? "";

  els.notionToggle.addEventListener("click", () => {
    const showing = els.notionToken.type === "text";
    els.notionToken.type = showing ? "password" : "text";
    els.notionToggle.textContent = showing ? "Show" : "Hide";
  });

  els.notionSave.addEventListener("click", async () => {
    const token = els.notionToken.value.trim();
    const parentRaw = els.notionParent.value.trim();
    const parentPageId = extractPageId(parentRaw);
    if (!token || !parentPageId) {
      setNotionStatus("Enter both a token and a parent page.", "err");
      return;
    }
    await saveSettings({ notion: { token, parentPageId } });
    setNotionStatus("Saved.", "ok");
  });

  els.notionTest.addEventListener("click", async () => {
    const token = els.notionToken.value.trim();
    const parentPageId = extractPageId(els.notionParent.value.trim());
    if (!token || !parentPageId) {
      setNotionStatus("Enter both a token and a parent page.", "err");
      return;
    }
    setNotionStatus("Testing…", "");
    try {
      await pingNotion({ token, parentPageId });
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

function setNotionStatus(msg, cls) {
  els.notionStatus.textContent = msg;
  els.notionStatus.className = `status ${cls}`;
}

async function initSync(settings) {
  els.syncEnabled.checked = !!settings.sync?.enabled;
  els.syncEnabled.addEventListener("change", async () => {
    const enabled = els.syncEnabled.checked;
    await saveSettings({ sync: { enabled } });
    els.syncStatus.textContent = enabled ? "Syncing…" : "Sync disabled. Sync silo cleared.";
    els.syncStatus.className = "status";
    try {
      await onSyncEnabledChange(enabled);
      els.syncStatus.textContent = enabled
        ? "Sync enabled. Saved sessions will appear on other Chromes signed in to this account."
        : "Sync disabled. Sessions stay local-only on this device.";
      els.syncStatus.className = "status ok";
    } catch (e) {
      els.syncStatus.textContent = `Sync error: ${e.message ?? e}`;
      els.syncStatus.className = "status err";
    }
  });
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
  els.providerHelp.textContent = p.keyHelp;
  els.baseUrlField.classList.toggle("hidden", !p.supportsBaseUrl);
  els.model.placeholder = p.defaultModel;
}

async function initBadge(settings) {
  const cfg = settings.badge;
  els.badgeEnabled.checked = !!cfg.enabled;
  els.badgeThreshold.value = String(cfg.thresholdHours);
  els.badgeConfig.classList.toggle("hidden", !cfg.enabled);
  els.sleepEnabled.checked = !!settings.sleep?.enabled;
  await refreshBadgeStatus();

  els.badgeEnabled.addEventListener("change", async () => {
    const enabled = els.badgeEnabled.checked;
    await saveSettings({ badge: { enabled } });
    els.badgeConfig.classList.toggle("hidden", !enabled);
    await refreshBadgeStatus();
  });
  els.badgeThreshold.addEventListener("change", async () => {
    await saveSettings({ badge: { thresholdHours: Number(els.badgeThreshold.value) } });
    await refreshBadgeStatus();
  });
  els.sleepEnabled.addEventListener("change", async () => {
    await saveSettings({ sleep: { enabled: els.sleepEnabled.checked } });
  });
}

async function refreshBadgeStatus() {
  try {
    const { count } = await updateBadge();
    els.badgeStatus.textContent = count === 0
      ? "Currently 0 stale tabs."
      : `Currently ${count} stale tab${count === 1 ? "" : "s"}.`;
    els.badgeStatus.className = "status ok";
  } catch (e) {
    els.badgeStatus.textContent = `Could not read tabs: ${e.message ?? e}`;
    els.badgeStatus.className = "status err";
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
  refreshAutoStatus(at);

  els.autoEnabled.addEventListener("change", async () => {
    const enabled = els.autoEnabled.checked;
    await saveSettings({ autoTriage: { enabled } });
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
    refreshAutoStatus(fresh);
  });
  els.pauseTilTomorrow.addEventListener("click", async () => {
    const tomorrow = new Date();
    tomorrow.setHours(9, 0, 0, 0);
    if (tomorrow <= new Date()) tomorrow.setDate(tomorrow.getDate() + 1);
    const minutes = Math.ceil((tomorrow.getTime() - Date.now()) / 60_000);
    await pauseAutoTriage(minutes);
    const fresh = (await getSettings()).autoTriage;
    refreshAutoStatus(fresh);
  });
  els.resume.addEventListener("click", async () => {
    await resumeAutoTriage();
    const fresh = (await getSettings()).autoTriage;
    refreshAutoStatus(fresh);
  });
}

function refreshAutoStatus(at) {
  if (at.pausedUntil && Date.now() < at.pausedUntil) {
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

function setAutoStatus(msg, cls) {
  els.autoStatus.textContent = msg;
  els.autoStatus.className = `status ${cls}`;
}

async function renderPlan() {
  els.planActions.innerHTML = "";
  const price = lifetimePriceUsd();

  if (!billingEnabled()) {
    els.planStatus.innerHTML = `You're on <strong>Free</strong>. Lifetime checkout isn't live yet — we're polishing it before launch.`;
    els.waitlistWrap.classList.remove("hidden");
    els.waitlistRow.classList.remove("hidden");
    return;
  }

  const plan = await refreshPlan();
  if (plan === "lifetime") {
    els.planStatus.innerHTML = `You own <strong>Lifetime</strong>. Thanks for supporting the project.`;
    addAction("Restore on another browser", openLogin);
    els.waitlistWrap.classList.add("hidden");
    els.waitlistRow.classList.add("hidden");
    return;
  }

  els.planStatus.innerHTML = `You're on <strong>Free</strong>.`;
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

async function onSave() {
  const provider = els.provider.value;
  const key = els.key.value.trim();
  const model = els.model.value.trim() || PROVIDERS[provider]?.defaultModel || "";
  const baseUrl = els.baseUrl.value.trim();
  const expectedPrefix = PROVIDERS[provider]?.keyPrefix;

  if (!key) return setStatus("Enter a key first.", "err");
  if (expectedPrefix && !key.startsWith(expectedPrefix)) {
    return setStatus(`That doesn't look like a ${PROVIDERS[provider].label} key (expected prefix "${expectedPrefix}").`, "err");
  }
  const customInstructions = els.instructions.value.trim();
  await saveSettings({ llm: { provider, apiKey: key, model, baseUrl, customInstructions } });
  setStatus("Saved.", "ok");
}

async function onTest() {
  const provider = els.provider.value;
  const key = els.key.value.trim();
  const model = els.model.value.trim() || PROVIDERS[provider]?.defaultModel;
  const baseUrl = els.baseUrl.value.trim();
  if (!key) return setStatus("Enter a key first.", "err");
  setStatus("Testing…", "");
  try {
    await pingProvider({
      settings: { llm: { provider, apiKey: key, model, baseUrl } },
    });
    setStatus("Connection works. You're good to triage.", "ok");
  } catch (e) {
    const msg = e instanceof LLMError ? e.message : `Network error: ${e.message ?? e}`;
    setStatus(`Failed: ${msg}`, "err");
  }
}

async function onWaitlist() {
  const email = els.waitlistEmail.value.trim();
  if (!/.+@.+\..+/.test(email)) {
    els.waitlistStatus.textContent = "Enter a valid email.";
    els.waitlistStatus.className = "status err";
    return;
  }
  await chrome.storage.local.set({ tt_waitlist_email: email });
  els.waitlistStatus.textContent = "Saved locally. Email hello@tabtriage.ai to lock in the launch discount.";
  els.waitlistStatus.className = "status ok";
}

function setStatus(msg, cls) {
  els.status.textContent = msg;
  els.status.className = `status ${cls}`;
}

init();
