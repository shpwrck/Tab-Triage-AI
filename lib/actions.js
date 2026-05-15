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

// Turn the group into a native Chrome tab group (colored, named, collapsible)
// inside the current window. Tabs stay put. The emoji is intentionally
// omitted from the tab-strip title — Chrome's collapsed groups only show
// the first ~12 characters, so every glyph of label matters. The emoji
// still shows up wherever else we render the group (popup, new tab page).
export async function applyAsTabGroup({ group, tabs, colorIndex = 0 }) {
  const ids = liveIds(tabs);
  if (!ids.length) throw new Error("No live tabs to group");
  const groupId = await chrome.tabs.group({ tabIds: ids });
  const color = TAB_GROUP_COLORS[colorIndex % TAB_GROUP_COLORS.length];
  const title = (group.label ?? "").trim().slice(0, 50);
  await chrome.tabGroups.update(groupId, {
    title,
    color,
    collapsed: false,
  });
  return { groupId, color };
}

// Apply ALL triage groups at once. Returns per-group results so the UI can
// show success/failure inline.
export async function applyAllAsTabGroups({ groups }) {
  const results = [];
  for (let i = 0; i < groups.length; i++) {
    const g = groups[i];
    try {
      const r = await applyAsTabGroup({ group: g, tabs: g.tabs, colorIndex: i });
      results.push({ ok: true, ...r });
    } catch (e) {
      results.push({ ok: false, error: String(e?.message ?? e) });
    }
  }
  return results;
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
