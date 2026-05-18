import { triageTabs, LLMError } from "../lib/llm/index.js";
import {
  getSettings,
  checkQuota,
  bumpQuota,
  tabLimit,
  listSessions,
  saveSession,
  deleteSession,
} from "../lib/storage.js";
import { refreshPlan, openCheckout, billingEnabled } from "../lib/billing.js";
import {
  archiveGroup,
  moveGroupToNewWindow,
  applyAsTabGroup,
  applyAllAsTabGroups,
  closeGroup,
  closeOneTab,
  restoreSession,
} from "../lib/actions.js";
import { saveTriageCache } from "../lib/triage_cache.js";
import { sendSessionToNotion, sendTriageToNotion, NotionError } from "../lib/notion.js";
import { fuzzyScoreMulti } from "../lib/fuzzy.js";
import { setTriageRunning } from "../lib/badge.js";

const $ = sel => document.querySelector(sel);

const els = {
  setup: $("#setup"),
  setupCta: $("#setup-cta"),
  search: $("#search"),
  searchResults: $("#search-results"),
  searchTabList: $("#search-tab-list"),
  searchSessionList: $("#search-session-list"),
  searchTabsCount: $("#search-tabs-count"),
  searchSessionsCount: $("#search-sessions-count"),
  searchEmpty: $("#search-empty"),
  picker: $("#picker"),
  result: $("#result"),
  sessions: $("#sessions"),
  tabList: $("#tab-list"),
  tabCount: $("#tab-count"),
  selectAll: $("#select-all"),
  groups: $("#groups"),
  sessionList: $("#session-list"),
  triage: $("#triage"),
  back: $("#back"),
  sessionsBack: $("#sessions-back"),
  showSessions: $("#show-sessions"),
  saveSession: $("#save-session"),
  exportMd: $("#export-md"),
  exportNotion: $("#export-notion"),
  applyAll: $("#apply-all"),
  error: $("#error"),
  quota: $("#quota"),
  openOptions: $("#open-options"),
};

const state = {
  tabs: [], // { id, title, url, favIconUrl, host, checked }
  lastResult: null, // { groups, tabsById }
};

async function init() {
  els.openOptions.addEventListener("click", () => chrome.runtime.openOptionsPage());
  els.setupCta.addEventListener("click", () => chrome.runtime.openOptionsPage());
  els.triage.addEventListener("click", onTriage);
  els.back.addEventListener("click", showPicker);
  els.sessionsBack.addEventListener("click", showPicker);
  els.showSessions.addEventListener("click", showSessions);
  els.saveSession.addEventListener("click", onSaveSession);
  els.exportMd.addEventListener("click", onExportMarkdown);
  els.exportNotion.addEventListener("click", onExportNotion);
  els.applyAll.addEventListener("click", onApplyAll);
  els.selectAll.addEventListener("change", e => {
    state.tabs.forEach(t => (t.checked = e.target.checked));
    renderTabs();
  });
  els.search.addEventListener("input", onSearchInput);
  // Auto-focus the search field — the Cmd/Ctrl+Shift+K binding opens
  // the popup, and the popup expects the search field to receive the
  // user's next keystrokes.
  setTimeout(() => els.search.focus(), 0);

  // Resolve current plan from ExtPay before rendering the quota badge so
  // paying customers don't see "Free" for a flash on every popup open.
  await refreshPlan().catch(() => {});

  await refreshQuotaBadge();
  const settings = await getSettings();
  if (!settings.llm?.apiKey) {
    els.setup.classList.remove("hidden");
    els.triage.disabled = true;
  }

  await loadCurrentWindowTabs();
}

async function loadCurrentWindowTabs() {
  const tabs = await chrome.tabs.query({ currentWindow: true });
  // Build a map of group metadata so each tab can show what group it
  // currently belongs to (if any).
  let groupMap = new Map();
  if (chrome.tabGroups?.query) {
    try {
      const groups = await chrome.tabGroups.query({ windowId: tabs[0]?.windowId });
      groupMap = new Map(groups.map(g => [g.id, g]));
    } catch {
      // tabGroups API not available — fall back to no group info.
    }
  }
  state.tabs = tabs
    .filter(t => t.url && !t.url.startsWith("chrome://") && !t.url.startsWith("chrome-extension://"))
    .map(t => {
      const grouped = typeof t.groupId === "number" && t.groupId !== -1;
      const grp = grouped ? groupMap.get(t.groupId) : null;
      return {
        id: t.id,
        windowId: t.windowId,
        title: t.title || t.url,
        url: t.url,
        favIconUrl: t.favIconUrl,
        host: safeHost(t.url),
        groupId: grouped ? t.groupId : null,
        groupTitle: grp?.title ?? null,
        groupColor: grp?.color ?? null,
        // Already-grouped tabs are unchecked by default to preserve the
        // user's manual organization; they can opt them in case by case.
        checked: !grouped,
      };
    });
  renderTabs();
}

function renderTabs() {
  els.tabList.innerHTML = "";
  for (const t of state.tabs) {
    const li = document.createElement("li");
    const groupChip = t.groupId
      ? `<span class="group-chip" data-color="${escapeAttr(t.groupColor || "grey")}" title="In Chrome tab group: ${escapeAttr(t.groupTitle || "Untitled")}">${escape(t.groupTitle || "in group")}</span>`
      : "";
    li.innerHTML = `
      <input type="checkbox" ${t.checked ? "checked" : ""} data-id="${t.id}" />
      <img class="favicon" src="${escapeAttr(t.favIconUrl || "")}" />
      <span class="title" title="${escapeAttr(t.title)}">${escape(t.title)}</span>
      ${groupChip}
      <span class="host">${escape(t.host)}</span>
    `;
    li.querySelector("input").addEventListener("change", e => {
      const id = Number(e.target.dataset.id);
      const tab = state.tabs.find(x => x.id === id);
      if (tab) tab.checked = e.target.checked;
      syncSelectAll();
    });
    els.tabList.appendChild(li);
  }
  hideBrokenFavicons(els.tabList);
  const grouped = state.tabs.filter(t => t.groupId).length;
  els.tabCount.textContent = grouped > 0
    ? `${state.tabs.length} tabs · ${grouped} already grouped`
    : `${state.tabs.length} tabs`;
  syncSelectAll();
}

// MV3 CSP forbids inline event handlers, so we wire favicon error handling
// programmatically after the elements are in the DOM. We also check
// img.complete + naturalWidth in case the error fired before we attached.
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

function syncSelectAll() {
  const selected = state.tabs.filter(t => t.checked).length;
  els.selectAll.checked = selected === state.tabs.length && state.tabs.length > 0;
  els.selectAll.indeterminate = selected > 0 && selected < state.tabs.length;
}

async function refreshQuotaBadge() {
  const settings = await getSettings();
  const q = await checkQuota(settings);
  els.quota.innerHTML = "";
  if (settings.plan === "lifetime") {
    els.quota.textContent = "Lifetime · unlimited";
  } else {
    const label = document.createElement("span");
    label.textContent = `Free · ${q.remaining}/${q.limit} this week`;
    els.quota.appendChild(label);
    const upgrade = document.createElement("button");
    upgrade.className = "ghost small upgrade-pill";
    upgrade.textContent = billingEnabled() ? "Buy lifetime" : "Lifetime soon";
    upgrade.addEventListener("click", () => openCheckout());
    els.quota.appendChild(upgrade);
  }
}

async function onTriage() {
  hideError();
  const settings = await getSettings();
  if (!settings.llm?.apiKey) {
    showError("Add an API key in Settings first.");
    return;
  }
  const quota = await checkQuota(settings);
  if (!quota.allowed) {
    showError(`Free plan: ${quota.limit} triages/week. Resets Monday. Buy lifetime for unlimited.`);
    return;
  }

  const selected = state.tabs.filter(t => t.checked);
  if (selected.length < 2) {
    showError("Select at least 2 tabs to triage.");
    return;
  }

  const limit = tabLimit(settings);
  const toSend = selected.slice(0, limit);
  if (selected.length > limit) {
    showError(`Free plan caps triage at ${limit} tabs. Sending the first ${limit}. Buy lifetime for unlimited.`);
  }

  setBusy(true);
  await setTriageRunning(true).catch(() => {});
  try {
    const rawGroups = await triageTabs({
      settings,
      tabs: toSend.map(t => ({ id: t.id, title: t.title, url: t.url })),
    });
    await bumpQuota();
    await refreshQuotaBadge();
    const tabsById = indexBy(toSend, "id");
    state.lastResult = {
      groups: rawGroups.map(g => ({
        label: g.label,
        emoji: g.emoji,
        summary: g.summary,
        tabs: (g.tab_ids ?? [])
          .map(id => tabsById.get(id))
          .filter(Boolean)
          .map(t => ({ id: t.id, windowId: t.windowId, title: t.title, url: t.url, favIconUrl: t.favIconUrl })),
        status: null,
      })),
    };
    const win = await chrome.windows.getCurrent().catch(() => null);
    await saveTriageCache({
      windowId: win?.id ?? null,
      groups: state.lastResult.groups,
    }).catch(() => {});
    showResult();
  } catch (e) {
    showError(e instanceof LLMError ? e.message : `Unexpected error: ${e.message ?? e}`);
  } finally {
    await setTriageRunning(false).catch(() => {});
    setBusy(false);
  }
}

function showResult() {
  els.picker.classList.add("hidden");
  els.sessions.classList.add("hidden");
  els.result.classList.remove("hidden");
  renderGroups();
}

function showPicker() {
  els.result.classList.add("hidden");
  els.sessions.classList.add("hidden");
  els.picker.classList.remove("hidden");
}

async function showSessions() {
  els.result.classList.add("hidden");
  els.picker.classList.add("hidden");
  els.sessions.classList.remove("hidden");
  await renderSessions();
}

function renderGroups() {
  els.groups.innerHTML = "";
  if (!state.lastResult) return;
  state.lastResult.groups.forEach((g, idx) => {
    els.groups.appendChild(buildGroupNode(g, idx));
  });
}

function buildGroupNode(g, idx) {
  const div = document.createElement("div");
  div.className = "group";
  div.dataset.idx = String(idx);
  if (g.status) div.classList.add(`group-status-${g.status}`);

  const summary = (g.summary ?? []).map(b => `<li>${escape(b)}</li>`).join("");
  const tabsHtml = (g.tabs ?? [])
    .map(
      t => `
      <li data-tab-id="${t.id}">
        <img class="favicon" src="${escapeAttr(t.favIconUrl || "")}" />
        <a href="${escapeAttr(t.url)}" target="_blank" rel="noopener noreferrer" title="${escapeAttr(t.title)}">${escape(t.title)}</a>
        <button class="tab-close" title="Close this tab" data-action="close-tab" data-tab-id="${t.id}">×</button>
      </li>
    `,
    )
    .join("");

  const statusBadge = g.status
    ? `<span class="group-status-badge">${escape(statusLabel(g.status, g))}</span>`
    : "";

  div.innerHTML = `
    <div class="group-head">
      <div class="group-label">${escape(g.label || "Group")}</div>
      <div class="group-meta">
        ${statusBadge}
        <span class="group-tab-count">${g.tabs.length} tabs</span>
      </div>
    </div>
    <ul class="group-summary">${summary}</ul>
    <ul class="group-tabs">${tabsHtml}</ul>
    <div class="group-actions">
      <button data-action="archive" class="primary small" title="Save as a session and close these tabs">Archive</button>
      <button data-action="new-window" class="small" title="Move these tabs to a new window">New window</button>
      <button data-action="group" class="small" title="Apply as a Chrome tab group in the current window">Tab group</button>
      <button data-action="notion" class="small" title="Send this group to Notion">Send to Notion</button>
      <button data-action="close" class="small danger-subtle" title="Close these tabs (no save)">Close all</button>
    </div>
  `;

  div.querySelectorAll("button[data-action]").forEach(btn => {
    btn.addEventListener("click", e => {
      e.stopPropagation();
      onGroupAction(idx, btn.dataset.action, btn.dataset.tabId);
    });
  });

  if (g.status) {
    div.querySelectorAll(".group-actions button").forEach(b => (b.disabled = true));
  }

  hideBrokenFavicons(div);
  return div;
}

function statusLabel(status, g) {
  switch (status) {
    case "archived": return `Archived`;
    case "moved": return `Moved to new window`;
    case "grouped": return `Grouped`;
    case "closed": return `Closed`;
    case "empty": return `Empty`;
    default: return status;
  }
}

async function onGroupAction(idx, action, tabIdAttr) {
  const g = state.lastResult?.groups?.[idx];
  if (!g) return;

  if (action === "close-tab") {
    const tabId = Number(tabIdAttr);
    try {
      await closeOneTab({ tabId });
      g.tabs = g.tabs.filter(t => t.id !== tabId);
      if (g.tabs.length === 0) g.status = "empty";
      replaceGroupNode(idx);
    } catch (e) {
      showError(`Couldn't close tab: ${e.message ?? e}`);
    }
    return;
  }

  if (action === "notion") {
    const btn = els.groups
      .querySelector(`.group[data-idx="${idx}"] button[data-action="notion"]`);
    try {
      await flashAsyncButton(btn, async () => {
        const { token, parentPageId, provider } = await assertNotionReady();
        await sendTriageToNotion({
          title: g.label || "Tab group",
          groups: [g],
          token,
          parentPageId,
          provider,
        });
      });
    } catch {
      // Detail lives on the button's title attribute.
    }
    return;
  }

  if (g.status) return; // group already acted on

  if (action === "close") {
    if (!confirm(`Close ${g.tabs.length} tabs in "${g.label}" without saving?`)) return;
  }

  setGroupBusy(idx, true);
  try {
    if (action === "archive") {
      await archiveGroup({ group: g, tabs: g.tabs });
      g.status = "archived";
    } else if (action === "new-window") {
      await moveGroupToNewWindow({ tabs: g.tabs });
      g.status = "moved";
    } else if (action === "group") {
      await applyAsTabGroup({ group: g, tabs: g.tabs, colorIndex: idx });
      g.status = "grouped";
    } else if (action === "close") {
      await closeGroup({ tabs: g.tabs });
      g.status = "closed";
    }
    replaceGroupNode(idx);
  } catch (e) {
    showError(`Action failed: ${e.message ?? e}`);
    setGroupBusy(idx, false);
  }
}

function replaceGroupNode(idx) {
  const node = els.groups.querySelector(`.group[data-idx="${idx}"]`);
  if (!node) return;
  const next = buildGroupNode(state.lastResult.groups[idx], idx);
  node.replaceWith(next);
}

function setGroupBusy(idx, busy) {
  const node = els.groups.querySelector(`.group[data-idx="${idx}"]`);
  if (!node) return;
  node.classList.toggle("group-busy", busy);
  node.querySelectorAll(".group-actions button").forEach(b => (b.disabled = busy));
}

async function onApplyAll() {
  const groups = state.lastResult?.groups?.filter(g => !g.status && g.tabs.length > 0);
  if (!groups?.length) return;
  els.applyAll.disabled = true;
  const original = els.applyAll.textContent;
  els.applyAll.textContent = "Applying…";
  try {
    await applyAllAsTabGroups({ groups });
    for (const g of groups) g.status = "grouped";
    renderGroups();
  } catch (e) {
    showError(`Couldn't apply all: ${e.message ?? e}`);
  } finally {
    els.applyAll.disabled = false;
    els.applyAll.textContent = original;
  }
}

async function onSaveSession() {
  if (!state.lastResult) return;
  const { groups } = state.lastResult;
  const session = {
    id: `s_${Date.now()}`,
    createdAt: new Date().toISOString(),
    title: defaultSessionTitle(groups),
    groups: groups.map(g => ({
      label: g.label,
      emoji: g.emoji,
      summary: g.summary,
      tabs: g.tabs.map(t => ({ title: t.title, url: t.url, favIconUrl: t.favIconUrl })),
    })),
  };
  await saveSession(session);
  flashButton(els.saveSession, "Saved");
}

function defaultSessionTitle(groups) {
  const top = groups
    .slice()
    .sort((a, b) => (b.tabs?.length ?? 0) - (a.tabs?.length ?? 0))[0];
  if (!top) return `Session · ${new Date().toLocaleDateString()}`;
  return top.label;
}

async function renderSessions() {
  const sessions = await listSessions();
  if (!sessions.length) {
    els.sessionList.innerHTML = `<li class="muted" style="border:none;background:none;padding:8px 0;">No saved sessions yet.</li>`;
    return;
  }
  els.sessionList.innerHTML = "";
  for (const s of sessions) {
    const totalTabs = s.groups.reduce((n, g) => n + g.tabs.length, 0);
    const li = document.createElement("li");
    li.innerHTML = `
      <div class="session-meta">
        <span>${new Date(s.createdAt).toLocaleString()}</span>
        <span>${s.groups.length} groups · ${totalTabs} tabs</span>
      </div>
      <div class="session-title">${escape(s.title)}</div>
      <div class="session-actions">
        <button data-action="restore-here" data-id="${s.id}" class="primary">Open here</button>
        <button data-action="restore-new" data-id="${s.id}">New window</button>
        <button data-action="copy" data-id="${s.id}">Copy Markdown</button>
        <button data-action="notion" data-id="${s.id}">Send to Notion</button>
        <button data-action="delete" data-id="${s.id}">Delete</button>
      </div>
    `;
    els.sessionList.appendChild(li);
  }
  els.sessionList.querySelectorAll("button[data-action]").forEach(btn => {
    btn.addEventListener("click", () => onSessionAction(btn.dataset.action, btn.dataset.id));
  });
}

async function onSessionAction(action, id) {
  const sessions = await listSessions();
  const s = sessions.find(x => x.id === id);
  if (!s) return;
  if (action === "restore-here" || action === "restore-new") {
    const urls = s.groups.flatMap(g => g.tabs.map(t => t.url));
    try {
      if (action === "restore-here") {
        const win = await chrome.windows.getCurrent();
        await restoreSession({ urls, windowId: win.id });
        window.close();
      } else {
        await restoreSession({ urls });
      }
    } catch (e) {
      showError(`Restore failed: ${e.message ?? e}`);
    }
  } else if (action === "delete") {
    if (confirm("Delete this session?")) {
      await deleteSession(id);
      await renderSessions();
    }
  } else if (action === "copy") {
    await navigator.clipboard.writeText(sessionToMarkdown(s));
  } else if (action === "notion") {
    const btn = els.sessionList
      .querySelector(`button[data-action="notion"][data-id="${id}"]`);
    try {
      await flashAsyncButton(btn, async () => {
        const { token, parentPageId } = await assertNotionReady();
        await sendSessionToNotion({ session: s, token, parentPageId });
      });
    } catch {
      // Title attribute on the button now carries the detailed error.
    }
  }
}

function onExportMarkdown() {
  if (!state.lastResult) return;
  const md = groupsToMarkdown(state.lastResult.groups);
  navigator.clipboard.writeText(md).then(() => flashButton(els.exportMd, "Copied"));
}

async function onExportNotion() {
  if (!state.lastResult) return;
  try {
    await flashAsyncButton(els.exportNotion, async () => {
      const { token, parentPageId, provider } = await assertNotionReady();
      await sendTriageToNotion({
        title: `Tab triage · ${new Date().toLocaleString()}`,
        groups: state.lastResult.groups,
        token,
        parentPageId,
        provider,
      });
    });
  } catch {
    // Detail lives on the button's title attribute.
  }
}

// Returns the live Notion config or throws a GateError tagged with a
// short label appropriate for the button. Keeps the precondition checks
// in one place so popup result, per-group, and saved-session handlers
// all surface failures the same way.
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

function groupsToMarkdown(groups) {
  let out = `# Tab triage · ${new Date().toLocaleString()}\n\n`;
  for (const g of groups) {
    out += `## ${g.label}\n\n`;
    for (const b of g.summary ?? []) out += `- ${b}\n`;
    out += `\n`;
    for (const t of g.tabs ?? []) out += `- [${t.title}](${t.url})\n`;
    out += `\n`;
  }
  return out;
}

function sessionToMarkdown(s) {
  return groupsToMarkdown(s.groups);
}

function setBusy(busy) {
  els.triage.disabled = busy;
  els.triage.innerHTML = busy ? `<span class="spinner"></span>Triaging…` : `Triage tabs`;
}

function showError(msg) {
  els.error.textContent = msg;
  els.error.classList.remove("hidden");
}
function hideError() {
  els.error.classList.add("hidden");
  els.error.textContent = "";
}

function flashButton(btn, text) {
  const original = btn.textContent;
  btn.textContent = text;
  setTimeout(() => (btn.textContent = original), 1400);
}

// Wrap an async action with a button's "Sending… / Sent / Failed" inline
// states. Keeps feedback next to the cause rather than at the top of the
// screen. Failure leaves the message in the button's title attribute so
// the user can hover for details. If the thrown error carries a
// `shortLabel`, that string is used as the button text instead of the
// generic failure label — used to surface "Lifetime only" or
// "Set up first" precondition failures right on the button.
async function flashAsyncButton(btn, action, { sendingLabel = "Sending…", okLabel = "Sent", failLabel = "Failed" } = {}) {
  if (!btn) return action();
  const originalText = btn.textContent;
  const originalTitle = btn.title;
  btn.disabled = true;
  btn.textContent = sendingLabel;
  try {
    await action();
    btn.textContent = okLabel;
    setTimeout(() => {
      btn.textContent = originalText;
      btn.title = originalTitle;
      btn.disabled = false;
    }, 1800);
  } catch (e) {
    btn.textContent = e?.shortLabel || failLabel;
    btn.title = e?.message ?? String(e);
    setTimeout(() => {
      btn.textContent = originalText;
      btn.title = originalTitle;
      btn.disabled = false;
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

let _searchDebounce = null;
function onSearchInput(e) {
  if (_searchDebounce) clearTimeout(_searchDebounce);
  const q = e.target.value;
  _searchDebounce = setTimeout(() => runSearch(q), 90);
}

async function runSearch(q) {
  const query = (q ?? "").trim();
  if (!query) {
    els.searchResults.classList.add("hidden");
    els.picker.classList.remove("hidden");
    return;
  }
  els.picker.classList.add("hidden");
  els.result.classList.add("hidden");
  els.sessions.classList.add("hidden");
  els.searchResults.classList.remove("hidden");

  // Tabs: across every window. Fuzzy-scored against "title url".
  const allTabs = await chrome.tabs.query({ url: ["http://*/*", "https://*/*"] });
  const tabHits = allTabs
    .map(t => ({
      tab: t,
      score: fuzzyScoreMulti(query, `${t.title ?? ""} ${t.url ?? ""}`),
    }))
    .filter(({ score }) => score > 0)
    .sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      return (b.tab.lastAccessed ?? 0) - (a.tab.lastAccessed ?? 0);
    })
    .slice(0, 30)
    .map(({ tab }) => tab);

  // Sessions: match against session title, group labels, notes, and tab titles.
  const sessions = await listSessions();
  const sessionHits = sessions
    .map(s => {
      const hay = [
        s.title,
        s.notes ?? "",
        ...s.groups.flatMap(g => [g.label, ...(g.summary ?? []), ...g.tabs.map(t => t.title)]),
      ].join(" ");
      return { session: s, score: fuzzyScoreMulti(query, hay) };
    })
    .filter(({ score }) => score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, 10)
    .map(({ session }) => session);

  renderSearchTabs(tabHits);
  renderSearchSessions(sessionHits);
  els.searchEmpty.classList.toggle("hidden", tabHits.length + sessionHits.length > 0);
}

function renderSearchTabs(tabs) {
  els.searchTabsCount.textContent = tabs.length ? `(${tabs.length})` : "";
  if (!tabs.length) {
    els.searchTabList.innerHTML = `<li class="muted" style="cursor:default; border:none;">No matching tabs.</li>`;
    return;
  }
  els.searchTabList.innerHTML = "";
  for (const t of tabs) {
    const li = document.createElement("li");
    li.innerHTML = `
      <img class="favicon" src="${escapeAttr(t.favIconUrl || "")}" />
      <span class="title" title="${escapeAttr(t.title || t.url)}">${escape(t.title || t.url)}</span>
      <span class="host">${escape(safeHost(t.url))}</span>
    `;
    li.addEventListener("click", () => switchToTab(t));
    els.searchTabList.appendChild(li);
  }
  hideBrokenFavicons(els.searchTabList);
}

function renderSearchSessions(sessions) {
  els.searchSessionsCount.textContent = sessions.length ? `(${sessions.length})` : "";
  if (!sessions.length) {
    els.searchSessionList.innerHTML = `<li class="muted" style="cursor:default; border:none;">No matching sessions.</li>`;
    return;
  }
  els.searchSessionList.innerHTML = "";
  for (const s of sessions) {
    const totalTabs = s.groups.reduce((n, g) => n + g.tabs.length, 0);
    const li = document.createElement("li");
    li.innerHTML = `
      <span class="title" title="${escapeAttr(s.title)}">${escape(s.title)}</span>
      <span class="badge">${totalTabs} tabs</span>
      <span class="host">${escape(new Date(s.createdAt).toLocaleDateString())}</span>
      <button class="search-aux" title="Open in a new window">↗</button>
    `;
    const urls = s.groups.flatMap(g => g.tabs.map(t => t.url));
    li.addEventListener("click", async ev => {
      if (ev.target.classList.contains("search-aux")) return; // handled below
      if (!urls.length) return;
      try {
        const win = await chrome.windows.getCurrent();
        await restoreSession({ urls, windowId: win.id });
        window.close();
      } catch (e) {
        showError(`Restore failed: ${e.message ?? e}`);
      }
    });
    li.querySelector(".search-aux").addEventListener("click", async ev => {
      ev.stopPropagation();
      if (!urls.length) return;
      try {
        await restoreSession({ urls });
        window.close();
      } catch (e) {
        showError(`Restore failed: ${e.message ?? e}`);
      }
    });
    els.searchSessionList.appendChild(li);
  }
}

async function switchToTab(tab) {
  try {
    await chrome.windows.update(tab.windowId, { focused: true });
    await chrome.tabs.update(tab.id, { active: true });
    window.close();
  } catch (e) {
    showError(`Tab unavailable: ${e.message ?? e}`);
  }
}

function indexBy(arr, key) {
  const m = new Map();
  for (const x of arr) m.set(x[key], x);
  return m;
}

function safeHost(url) {
  try { return new URL(url).hostname.replace(/^www\./, ""); } catch { return ""; }
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

init().catch(e => showError(`Init error: ${e.message ?? e}`));
