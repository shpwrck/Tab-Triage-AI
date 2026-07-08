const UNSORTED_LABEL = "Unsorted";
const DEFAULT_UNSORTED_COLOR_INDEX = 8;

export function normalizeTriageGroups({ rawGroups, tabs, minGroupTabs = 2 } = {}) {
  const tabList = Array.isArray(tabs) ? tabs : [];
  const tabsById = new Map();
  for (const tab of tabList) {
    if (!Number.isFinite(tab?.id) || tabsById.has(tab.id)) continue;
    tabsById.set(tab.id, tab);
  }

  const placedIds = new Set();
  const normalized = [];
  const llmUnsortedIds = [];
  let llmUnsortedGroup = null;
  const groups = Array.isArray(rawGroups) ? rawGroups : [];

  for (let i = 0; i < groups.length; i++) {
    const group = groups[i];
    if (!group || typeof group !== "object") continue;

    const ids = validGroupIds(group, tabsById, placedIds);
    if (isUnsortedGroup(group)) {
      llmUnsortedGroup = llmUnsortedGroup ?? group;
      llmUnsortedIds.push(...ids);
      continue;
    }

    if (ids.length < minGroupTabs) continue;

    ids.forEach(id => placedIds.add(id));
    normalized.push(formatGroup(group, ids.map(id => tabsById.get(id)), i));
  }

  const unsortedIds = [];
  const seenUnsorted = new Set();
  for (const id of [...llmUnsortedIds, ...tabsById.keys()]) {
    if (!tabsById.has(id) || placedIds.has(id) || seenUnsorted.has(id)) continue;
    seenUnsorted.add(id);
    unsortedIds.push(id);
  }

  if (unsortedIds.length) {
    normalized.push(formatGroup(
      {
        label: UNSORTED_LABEL,
        emoji: llmUnsortedGroup?.emoji,
        summary: llmUnsortedGroup?.summary,
      },
      unsortedIds.map(id => tabsById.get(id)),
      DEFAULT_UNSORTED_COLOR_INDEX,
    ));
  }

  return normalized;
}

function validGroupIds(group, tabsById, placedIds) {
  const seen = new Set();
  const ids = [];
  const rawIds = Array.isArray(group.tab_ids) ? group.tab_ids : [];
  for (const id of rawIds) {
    if (!tabsById.has(id) || placedIds.has(id) || seen.has(id)) continue;
    seen.add(id);
    ids.push(id);
  }
  return ids;
}

function isUnsortedGroup(group) {
  return String(group.label ?? "").trim().toLowerCase() === "unsorted";
}

function formatGroup(group, tabs, colorIndex) {
  return {
    label: group.label,
    emoji: group.emoji,
    summary: group.summary,
    colorIndex,
    tabs: tabs.map(formatTab),
  };
}

function formatTab(tab) {
  return {
    id: tab.id,
    windowId: tab.windowId,
    title: tab.title,
    url: tab.url,
    favIconUrl: tab.favIconUrl,
  };
}
