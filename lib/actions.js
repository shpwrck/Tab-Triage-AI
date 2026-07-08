// Action layer: wraps Chrome tabs / windows / tabGroups APIs in functions
// that operate on a triage group's set of tabs. The popup calls these and
// then updates its own UI to reflect what happened.

import { saveSession } from "./storage.js";

// Order matches the cycle Chrome's tab groups use by default. We rotate
// through this list so each group in a triage gets a distinct color.
const TAB_GROUP_COLORS = [
  "blue",
  "purple",
  "green",
  "orange",
  "pink",
  "cyan",
  "yellow",
  "red",
  "grey",
];

function liveIds(tabs) {
  return tabs.map(t => t.id).filter(id => typeof id === "number");
}

function snapshotTab(tab) {
  return {
    id: tab.id,
    windowId: tab.windowId,
    title: tab.title,
    url: tab.url,
    favIconUrl: tab.favIconUrl,
  };
}

// Resolve cached URL-only tab records back to currently open Chrome tabs.
// Cache entries intentionally do not persist tab IDs, so actions must look up
// the live tab by URL right before operating on it.
export async function findLiveTabsForUrls(urls) {
  if (!urls?.length) return [];
  const wanted = new Set(urls.filter(url => typeof url === "string" && url));
  if (!wanted.size) return [];

  const all = await chrome.tabs.query({});
  const byUrl = new Map();
  for (const tab of all) {
    if (wanted.has(tab.url) && !byUrl.has(tab.url)) byUrl.set(tab.url, tab);
  }

  return urls
    .map(url => byUrl.get(url))
    .filter(Boolean)
    .map(snapshotTab);
}

export async function focusTab(tab) {
  const tabId = typeof tab?.id === "number" ? tab.id : null;
  if (tabId == null) throw new Error("No live tab to focus");

  let liveTab = tab;
  if (typeof liveTab.windowId !== "number") {
    liveTab = await chrome.tabs.get(tabId);
  }
  if (typeof liveTab?.windowId !== "number") {
    throw new Error("No live tab window to focus");
  }

  await chrome.windows.update(liveTab.windowId, { focused: true });
  await chrome.tabs.update(tabId, { active: true });
  return snapshotTab(liveTab);
}

export async function focusOrOpenTabByUrl(url) {
  if (typeof url !== "string" || !url) throw new Error("No URL to open");

  const [liveTab] = await findLiveTabsForUrls([url]);
  if (liveTab) {
    return { opened: false, tab: await focusTab(liveTab) };
  }

  const tab = await chrome.tabs.create({ url, active: true });
  return { opened: true, tab: snapshotTab(tab) };
}

// Archive = save the group as a session, then close its tabs. Recoverable
// from the Saved sessions list.
export async function archiveGroup({ group, tabs }) {
  const session = {
    id: `s_${Date.now()}`,
    createdAt: new Date().toISOString(),
    title: group.label || "Archived group",
    groups: [
      {
        label: group.label,
        emoji: group.emoji,
        summary: group.summary,
        tabs: tabs.map(t => ({ title: t.title, url: t.url, favIconUrl: t.favIconUrl })),
      },
    ],
  };
  await saveSession(session);

  const ids = liveIds(tabs);
  if (ids.length) await chrome.tabs.remove(ids);
  return { sessionId: session.id, closed: ids.length };
}

// Move the group's tabs into a brand-new focused window, preserving the
// tabs themselves (no reload, no lost form state).
export async function moveGroupToNewWindow({ tabs }) {
  const ids = liveIds(tabs);
  if (!ids.length) throw new Error("No live tabs to move");
  const win = await chrome.windows.create({ tabId: ids[0], focused: true });
  if (ids.length > 1) {
    await chrome.tabs.move(ids.slice(1), { windowId: win.id, index: -1 });
  }
  return { windowId: win.id, moved: ids.length };
}

// Turn the group into a native Chrome tab group (colored, named, collapsible).
//
// Tabs stay in the windows they belong to. chrome.tabs.group() without an
// explicit createProperties.windowId places the new group in whichever
// window happens to be focused at call time, dragging the tabs across to
// land there — surprising when the user has multiple windows open. We
// resolve each tab's actual windowId (falling back to chrome.tabs.get when
// the caller didn't pass it through) and bucket by windowId so each window
// gets its own native tab group with the same label and color.
export async function applyAsTabGroup({ group, tabs, colorIndex = 0 }) {
  const live = (tabs ?? []).filter(t => typeof t?.id === "number");
  if (!live.length) throw new Error("No live tabs to group");

  // Bucket tab IDs by the window they live in.
  const byWindow = new Map();
  for (const t of live) {
    let wid = typeof t.windowId === "number" ? t.windowId : null;
    if (wid == null) {
      try { wid = (await chrome.tabs.get(t.id))?.windowId ?? null; } catch {}
    }
    if (wid == null) continue;
    if (!byWindow.has(wid)) byWindow.set(wid, []);
    byWindow.get(wid).push(t.id);
  }
  if (!byWindow.size) throw new Error("No live tabs to group");

  const color = TAB_GROUP_COLORS[colorIndex % TAB_GROUP_COLORS.length];
  const title = (group.label ?? "").trim().slice(0, 50);

  const subGroups = [];
  for (const [windowId, ids] of byWindow) {
    const groupId = await chrome.tabs.group({
      tabIds: ids,
      createProperties: { windowId },
    });
    await chrome.tabGroups.update(groupId, { title, color, collapsed: false });
    subGroups.push({ groupId, windowId });
  }
  return { groupId: subGroups[0].groupId, color, subGroups };
}

// Apply ALL triage groups at once. Returns per-group results so the UI can
// show success/failure inline.
export async function applyAllAsTabGroups({ groups }) {
  const results = [];
  for (let i = 0; i < groups.length; i++) {
    const g = groups[i];
    try {
      const colorIndex = typeof g.colorIndex === "number" ? g.colorIndex : i;
      const r = await applyAsTabGroup({ group: g, tabs: g.tabs, colorIndex });
      results.push({ ok: true, label: groupLabel(g, i), tabCount: liveIds(g.tabs ?? []).length, ...r });
    } catch (e) {
      results.push({ ok: false, label: groupLabel(g, i), tabCount: liveIds(g.tabs ?? []).length, error: String(e?.message ?? e) });
    }
  }
  return results;
}

export function summarizeApplyResults({ groups, results }) {
  const entries = (groups ?? []).map((group, index) => {
    const result = results?.[index] ?? null;
    const tabs = group?.tabs ?? [];
    return {
      group,
      index,
      label: groupLabel(group, index),
      tabCount: liveIds(tabs).length,
      ok: !!result?.ok,
      error: result?.ok ? "" : String(result?.error || "Could not group tabs"),
    };
  });
  const successes = entries.filter(entry => entry.ok);
  const failures = entries.filter(entry => !entry.ok);
  return {
    entries,
    successes,
    failures,
    attemptedGroupCount: entries.length,
    groupedGroupCount: successes.length,
    failedGroupCount: failures.length,
    groupedTabCount: successes.reduce((sum, entry) => sum + entry.tabCount, 0),
    failedTabCount: failures.reduce((sum, entry) => sum + entry.tabCount, 0),
  };
}

export function formatApplyFailureMessage(summary) {
  const failures = summary?.failures ?? [];
  if (!failures.length) return "";
  const labels = formatGroupLabelList(failures.map(f => f.label));
  const pronoun = failures.length === 1 ? "it" : "them";
  return `Couldn't group ${labels}. Refresh tabs, then retry or group ${pronoun} manually.`;
}

function groupLabel(group, index) {
  const label = (group?.label ?? "").trim();
  return label || `Group ${index + 1}`;
}

function formatGroupLabelList(labels, max = 3) {
  const visible = labels.slice(0, max).map(label => `"${label}"`);
  const extra = labels.length - visible.length;
  if (!extra) return visible.join(", ");
  return `${visible.join(", ")} and ${extra} more`;
}

export async function closeGroup({ tabs }) {
  const ids = liveIds(tabs);
  if (!ids.length) return { closed: 0 };
  await chrome.tabs.remove(ids);
  return { closed: ids.length };
}

export async function closeOneTab({ tabId }) {
  if (typeof tabId !== "number") return;
  await chrome.tabs.remove(tabId);
}

// Restore a saved session.
//
//   restoreSession({ urls })                    → opens in a new focused window
//   restoreSession({ urls, windowId: 123 })     → appends the session's tabs to
//                                                  the given window, focuses it,
//                                                  and activates the first one
export async function restoreSession({ urls, windowId }) {
  if (!urls?.length) throw new Error("No URLs to restore");
  if (typeof windowId === "number") {
    let firstId = null;
    for (let i = 0; i < urls.length; i++) {
      const tab = await chrome.tabs.create({
        windowId,
        url: urls[i],
        active: i === 0,
      });
      if (i === 0) firstId = tab.id;
    }
    await chrome.windows.update(windowId, { focused: true }).catch(() => {});
    return { windowId, firstId };
  }
  const win = await chrome.windows.create({ url: urls, focused: true });
  return { windowId: win.id, firstId: null };
}
