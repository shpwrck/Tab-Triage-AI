// Run a triage on the user's currently-focused window from any context
// (service-worker command handler, new tab page) and return the cached
// groups. Centralised here so the keyboard shortcut, the new-tab
// "Triage now" button, and the auto-triage loop don't duplicate logic.

import { getSettings } from "./storage.js";
import { triageTabs, LLMError } from "./llm/index.js";
import { applyAsTabGroup } from "./actions.js";
import { saveTriageCache } from "./triage_cache.js";

export async function runManualTriage({ windowId } = {}) {
  const settings = await getSettings();
  if (!settings.llm?.apiKey) {
    throw new LLMError("Add an API key in Settings first.");
  }

  let win;
  if (typeof windowId === "number") {
    win = await chrome.windows.get(windowId).catch(() => null);
  } else {
    win = await chrome.windows.getLastFocused().catch(() => null);
  }
  if (!win) throw new Error("No focused window to triage.");

  const tabs = await chrome.tabs.query({ windowId: win.id });
  const candidates = tabs.filter(t => t.url && /^https?:/.test(t.url) && !t.pinned);
  if (candidates.length < 2) {
    throw new Error("Need at least 2 tabs to triage.");
  }

  const raw = await triageTabs({
    settings,
    tabs: candidates.map(t => ({ id: t.id, title: t.title, url: t.url })),
  });

  const tabsById = new Map(candidates.map(t => [t.id, t]));
  const cachedGroups = [];
  for (let i = 0; i < raw.length; i++) {
    const g = raw[i];
    const ids = (g.tab_ids ?? []).filter(id => tabsById.has(id));
    if (ids.length < 2) continue;
    const groupTabs = ids.map(id => tabsById.get(id));
    cachedGroups.push({
      label: g.label,
      summary: g.summary,
      tabs: groupTabs.map(t => ({ title: t.title, url: t.url, favIconUrl: t.favIconUrl })),
    });
    try {
      await applyAsTabGroup({ group: g, tabs: groupTabs, colorIndex: i });
    } catch (e) {
      console.warn("[manual-triage] applyAsTabGroup failed", e?.message ?? e);
    }
  }

  if (cachedGroups.length > 0) {
    await saveTriageCache({ windowId: win.id, groups: cachedGroups });
  }
  return { groups: cachedGroups, candidates: candidates.length };
}
