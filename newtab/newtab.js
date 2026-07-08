import { getSettings, listSessions, deleteSession, saveSession, updateSession } from "../lib/storage.js";
import { readTriageCache, saveTriageCache, clearTriageCache } from "../lib/triage_cache.js";
import { LLMError } from "../lib/llm/index.js";
import { applyAllAsTabGroups, formatApplyFailureMessage, restoreSession, summarizeApplyResults } from "../lib/actions.js";
import { sendSessionToNotion, sendTriageToNotion, NotionError } from "../lib/notion.js";
import { setTriageRunning, formatThresholdLabel } from "../lib/badge.js";
import { applyStoredTheme, watchThemeChanges } from "../lib/theme.js";
import { runQuotaLimitedTriage, TriageQuotaError } from "../lib/triage_quota.js";
import { getStaleTabs, isTriageEligibleTab, splitStaleBulkActionTabs, staleThresholdMs } from "../lib/tab_policy.js";

const $ = sel => document.querySelector(sel);

const state = {
  cache: null,
  staleTabs: [],
  pendingNoteSaves: new Map(),
  noteSaveTimers: new Map(),
};

const NOTE_SAVE_ACK_GRACE_MS = 10000;

const els = {
  statOpen: $("#stat-open"),
  statStale: $("#stat-stale"),
  statStaleLabel: $("#stat-stale-label"),
  statDupes: $("#stat-dupes"),
  statSessions: $("#stat-sessions"),
  triageNow: $("#triage-now"),
  clearHistory: $("#clear-history"),
  openSettings: $("#open-settings"),
  heroStatus: $("#hero-status"),
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
};

async function init() {
  await applyStoredTheme();
  watchThemeChanges();
  els.openSettings.addEventListener("click", () => chrome.runtime.openOptionsPage());
  els.triageNow.addEventListener("click", onTriageNow);
  els.clearHistory.addEventListener("click", onClearHistory);
  els.closeAllDupes.addEventListener("click", onCloseAllDuplicates);
  els.archiveAllStale.addEventListener("click", onArchiveAllStale);
  els.closeAllStale.addEventListener("click", onCloseAllStale);
  await Promise.all([renderStats(), renderLatest(), renderStale(), renderDuplicates(), renderSessions()]);
  // Live-update when the auto-triage or popup writes a new cache.
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "local") return;
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
}

function debounce(fn, ms) {
  let t = null;
  return (...args) => {
    if (t) clearTimeout(t);
    t = setTimeout(() => fn(...args), ms);
  };
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
    });
  }
  duplicates.sort((a, b) => b.closeIds.length - a.closeIds.length);
  return { duplicates, totalRedundant };
}

async function renderDuplicates() {
  const tabs = await chrome.tabs.query({ url: ["http://*/*", "https://*/*"] });
  const { duplicates, totalRedundant } = computeDuplicates(tabs);

  els.dupesCount.textContent = totalRedundant === 0
    ? ""
    : `${totalRedundant} redundant`;

  if (!duplicates.length) {
    els.dupesList.innerHTML = "";
    els.dupesEmpty.classList.remove("hidden");
    els.dupesFooter.classList.add("hidden");
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
      btn.addEventListener("click", () => onDupeAction(btn.dataset.action, btn.dataset));
    });
    els.dupesList.appendChild(li);
  }
  hideBrokenFavicons(els.dupesList);
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

async function renderStale() {
  const { staleTabs: stale, actionTabs, protectedTabs, hours, now } = await loadStaleTabs();

  state.staleTabs = stale;
  els.staleHelp.textContent = `Tabs you haven't activated in ${formatThresholdLabel(hours)}. Pinned tabs are excluded.`;
  els.staleCount.textContent = stale.length === 0 ? "" : `${stale.length} tab${stale.length === 1 ? "" : "s"}`;

  if (!stale.length) {
    els.staleList.innerHTML = "";
    els.staleEmpty.classList.remove("hidden");
    els.staleFooter.classList.add("hidden");
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
        await renderStale();
        await renderStats();
      } catch (e) {
        setHeroStatus(`Couldn't close: ${e.message ?? e}`, "err");
      }
    });
    els.staleList.appendChild(li);
  }
  hideBrokenFavicons(els.staleList);
}

async function onCloseAllStale() {
  const { staleTabs, actionTabs, protectedTabs } = await loadStaleTabs();
  if (!staleTabs.length) return;
  if (!actionTabs.length) {
    setHeroStatus("Active or audible stale tabs need to be closed one at a time.", "err");
    await renderStale();
    await renderStats();
    return;
  }
  if (!confirm(`Close ${actionTabs.length} stale tab${actionTabs.length === 1 ? "" : "s"} without saving?${protectedStaleNote(protectedTabs.length)}`)) return;
  try {
    await chrome.tabs.remove(actionTabs.map(t => t.id));
    setHeroStatus(`Closed ${actionTabs.length} stale tab${actionTabs.length === 1 ? "" : "s"}.`, "ok");
    await renderStale();
    await renderStats();
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
          `${actionTabs.length} tab${actionTabs.length === 1 ? "" : "s"} not activated in ${label}`,
          "Captured from the new-tab dashboard",
          "Restore via Saved sessions to revisit",
        ],
        tabs: actionTabs.map(t => ({ title: t.title, url: t.url, favIconUrl: t.favIconUrl })),
      },
    ],
  };
  await saveSession(session);
  try {
    await chrome.tabs.remove(actionTabs.map(t => t.id));
    const note = protectedTabs.length ? ` ${protectedStaleNote(protectedTabs.length).trim()}` : "";
    setHeroStatus(`Archived ${actionTabs.length} stale tab${actionTabs.length === 1 ? "" : "s"} — recoverable from Saved sessions.${note}`, "ok");
    await renderStale();
    await renderStats();
    await renderSessions();
  } catch (e) {
    setHeroStatus(`Couldn't archive stale tabs: ${e.message ?? e}`, "err");
  }
}

async function onDupeAction(action, dataset) {
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
      await chrome.tabs.remove(ids);
      setHeroStatus(`Closed ${ids.length} duplicate${ids.length === 1 ? "" : "s"}.`, "ok");
      await renderDuplicates();
      await renderStats();
    } catch (e) {
      setHeroStatus(`Couldn't close duplicates: ${e.message ?? e}`, "err");
    }
  }
}

async function onCloseAllDuplicates() {
  const tabs = await chrome.tabs.query({ url: ["http://*/*", "https://*/*"] });
  const { duplicates, totalRedundant } = computeDuplicates(tabs);
  if (!totalRedundant) return;
  if (!confirm(`Close ${totalRedundant} duplicate tab${totalRedundant === 1 ? "" : "s"} across ${duplicates.length} URL${duplicates.length === 1 ? "" : "s"}? The most recently used copy of each will be kept.`)) return;
  const ids = duplicates.flatMap(d => d.closeIds);
  try {
    await chrome.tabs.remove(ids);
    setHeroStatus(`Closed ${ids.length} duplicate tab${ids.length === 1 ? "" : "s"}.`, "ok");
    await renderDuplicates();
    await renderStats();
  } catch (e) {
    setHeroStatus(`Couldn't close duplicates: ${e.message ?? e}`, "err");
  }
}

async function renderLatest() {
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
    return;
  }

  const ago = humanAgo(Date.now() - cached.createdAt);
  els.latestMeta.textContent = `${cached.groups.length} groups · ${ago} ago`;

  els.latestBody.innerHTML = `<div class="groups"></div>`;
  const container = els.latestBody.querySelector(".groups");
  cached.groups.forEach((g, idx) => {
    container.appendChild(buildGroupNode(g, idx));
  });
  hideBrokenFavicons(els.latestBody);
}

function buildGroupNode(g, idx) {
  const article = document.createElement("article");
  article.className = "group";
  article.dataset.idx = String(idx);

  const tabsHtml = (g.tabs ?? [])
    .map(
      t => `
      <li data-url="${escapeAttr(t.url)}">
        <img class="favicon" src="${escapeAttr(t.favIconUrl || "")}" />
        <a href="${escapeAttr(t.url)}" target="_blank" rel="noopener noreferrer" title="${escapeAttr(t.title)}">${escape(t.title)}</a>
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
      <button data-action="close" class="small danger-subtle" title="Close these tabs (no save)">Close all</button>
    </div>
  `;

  article.querySelectorAll("button[data-action]").forEach(btn => {
    btn.addEventListener("click", e => {
      e.stopPropagation();
      onGroupAction(idx, btn.dataset.action, btn.dataset.tabUrl);
    });
  });

  return article;
}

// Resolve the cached group's URL list back to live Chrome tabs. The cache
// only stores titles/URLs — IDs would be stale across reloads — so we
// look the tabs up by URL each time we want to act on them.
async function findLiveTabsForUrls(urls) {
  if (!urls?.length) return [];
  const wanted = new Set(urls);
  const all = await chrome.tabs.query({});
  const byUrl = new Map();
  for (const t of all) {
    if (wanted.has(t.url) && !byUrl.has(t.url)) byUrl.set(t.url, t);
  }
  // Preserve the original group order so e.g. New window opens the first
  // tab as the focused one.
  return urls
    .map(u => byUrl.get(u))
    .filter(Boolean)
    .map(t => ({ id: t.id, title: t.title, url: t.url, favIconUrl: t.favIconUrl }));
}

async function onGroupAction(idx, action, tabUrlAttr) {
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
    await persistCacheAndRefresh(cache);
    setHeroStatus(`Closed 1 tab from "${g.label}".`, "ok");
    return;
  }

  if (action === "notion") {
    const btn = document.querySelector(
      `#latest-body .group[data-idx="${idx}"] button[data-action="notion"]`,
    );
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
      // Title attribute on the button carries the detailed error.
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
      await saveSession(session);
      if (liveTabs.length) await chrome.tabs.remove(liveTabs.map(t => t.id));
      cache.groups.splice(idx, 1);
      await persistCacheAndRefresh(cache);
      await renderSessions();
      await renderStats();
      setHeroStatus(`Archived "${g.label}" — ${liveTabs.length} tab${liveTabs.length === 1 ? "" : "s"} closed, recoverable from Saved sessions.`, "ok");
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
      await persistCacheAndRefresh(cache);
      setHeroStatus(`Moved ${liveTabs.length} tab${liveTabs.length === 1 ? "" : "s"} to a new window.`, "ok");
    } else if (action === "close") {
      if (!confirm(`Close ${g.tabs.length} tabs in "${g.label}" without saving?`)) return;
      if (liveTabs.length) await chrome.tabs.remove(liveTabs.map(t => t.id));
      cache.groups.splice(idx, 1);
      await persistCacheAndRefresh(cache);
      setHeroStatus(`Closed ${liveTabs.length} tab${liveTabs.length === 1 ? "" : "s"} from "${g.label}".`, "ok");
    }
  } catch (e) {
    setHeroStatus(`Action failed: ${e.message ?? e}`, "err");
  }
}

async function persistCacheAndRefresh(cache) {
  // Preserve the original triage timestamp — these mutations are not a
  // fresh triage, just edits to an existing one.
  await saveTriageCache({
    windowId: cache.windowId,
    groups: cache.groups,
    createdAt: cache.createdAt,
  });
  await renderLatest();
  await renderStats();
}

async function renderSessions() {
  const sessions = await listSessions();
  els.sessionsCount.textContent = `${sessions.length}`;
  if (!sessions.length) {
    els.sessionList.innerHTML = "";
    els.sessionsEmpty.classList.remove("hidden");
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
      } catch (e) {
        clearTrackedNoteAutosave(id, notes);
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
}

async function onSessionAction(action, id, sessions) {
  const s = sessions.find(x => x.id === id);
  if (!s) return;
  if (action === "restore-here" || action === "restore-new") {
    const urls = s.groups.flatMap(g => g.tabs.map(t => t.url));
    if (!urls.length) return;
    try {
      if (action === "restore-here") {
        const win = await chrome.windows.getCurrent();
        await restoreSession({ urls, windowId: win.id });
        setHeroStatus(`Opened "${s.title}" in this window (${urls.length} tabs).`, "ok");
      } else {
        await restoreSession({ urls });
        setHeroStatus(`Opened "${s.title}" in a new window (${urls.length} tabs).`, "ok");
      }
    } catch (e) {
      setHeroStatus(`Restore failed: ${e.message ?? e}`, "err");
    }
  } else if (action === "delete") {
    if (confirm("Delete this session?")) {
      await deleteSession(id);
      await renderSessions();
      await renderStats();
    }
  } else if (action === "copy") {
    await navigator.clipboard.writeText(sessionToMarkdown(s));
    setHeroStatus(`Copied "${s.title}" as Markdown.`, "ok");
  } else if (action === "notion") {
    const btn = els.sessionList.querySelector(`button[data-action="notion"][data-id="${id}"]`);
    try {
      await flashAsyncButton(btn, async () => {
        const { token, parentPageId } = await assertNotionReady();
        await sendSessionToNotion({ session: s, token, parentPageId });
      });
    } catch {
      // Title attribute on the button carries the detailed error.
    }
  }
}

async function onTriageNow() {
  setHeroStatus("");
  const settings = await getSettings();
  if (!settings.llm?.apiKey) {
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
  const candidates = tabs.filter(isTriageEligibleTab);
  if (candidates.length < 2) {
    setHeroStatus("Need at least 2 tabs to triage.", "err");
    return;
  }

  els.triageNow.disabled = true;
  els.triageNow.textContent = "Triaging…";
  await setTriageRunning(true).catch(() => {});
  try {
    const { result } = await runQuotaLimitedTriage({
      settings,
      tabs: candidates,
      onPreflight: ({ cap }) => {
        if (cap.applied) setHeroStatus(cap.message);
      },
      afterTriage: async ({ rawGroups, tabs: triageCandidates, cap }) => {
        const tabsById = new Map(triageCandidates.map(t => [t.id, t]));
        const groups = rawGroups.map(g => {
          const groupTabs = (g.tab_ids ?? [])
            .map(id => tabsById.get(id))
            .filter(Boolean);
          return {
            label: g.label,
            emoji: g.emoji,
            summary: g.summary,
            tabs: groupTabs.map(t => ({ id: t.id, windowId: t.windowId, title: t.title, url: t.url, favIconUrl: t.favIconUrl })),
          };
        });
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
      setHeroStatus(`Triage failed: ${msg}`, "err");
    }
  } finally {
    await setTriageRunning(false).catch(() => {});
    els.triageNow.disabled = false;
    els.triageNow.textContent = "Triage now";
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

function setHeroStatus(msg, cls = "") {
  els.heroStatus.textContent = msg;
  els.heroStatus.className = `status muted ${cls}`;
}

function formatApplyStatus(summary, cap) {
  const scopedCount = cap?.applied
    ? `${summary.groupedTabCount} of ${cap.originalCount}`
    : String(summary.groupedTabCount);
  const clusterWord = summary.groupedGroupCount === 1 ? "cluster" : "clusters";
  if (summary.failedGroupCount) {
    const successPrefix = summary.groupedGroupCount
      ? `Grouped ${scopedCount} tabs into ${summary.groupedGroupCount} ${clusterWord}. `
      : "No tab groups were applied. ";
    return `${successPrefix}${formatApplyFailureMessage(summary)}`;
  }
  if (!summary.groupedGroupCount) return "Triage finished, but no tab groups were applied.";
  return `Grouped ${scopedCount} tabs into ${summary.groupedGroupCount} ${clusterWord}.`;
}

// Wrap an async action with a button's inline "Sending… / Sent / Failed"
// states so feedback lives next to the cause instead of at the top of
// the page. Failure puts the message in the button's title attribute.
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
