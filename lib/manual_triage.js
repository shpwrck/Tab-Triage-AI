// Run a triage on the user's currently-focused window from the service-worker
// command handler and return the cached groups. Quota and tab-cap enforcement
// lives in triage_quota.js so every triage surface shares the same rules.

import { getSettings } from "./storage.js";
import { LLMError } from "./llm/index.js";
import { runQuotaLimitedTriage } from "./triage_quota.js";
import { applyAllAsTabGroups, summarizeApplyResults } from "./actions.js";
import { saveTriageCache } from "./triage_cache.js";
import { setTriageRunning } from "./badge.js";

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

  await setTriageRunning(true).catch(() => {});
  let result;
  try {
    ({ result } = await runQuotaLimitedTriage({
      settings,
      tabs: candidates,
      afterTriage: async ({ rawGroups, tabs: triageCandidates, originalTabs, cap }) => {
        const tabsById = new Map(triageCandidates.map(t => [t.id, t]));
        const placedIds = new Set();
        const groupsToApply = [];
        const cachedGroups = [];
        // Defer the LLM's "Unsorted" group (if any) to the end so we can merge
        // leftovers — singleton-dropped tabs, unrecognized tab_ids, tabs the LLM
        // simply omitted — into one bucket instead of letting them vanish.
        let llmUnsorted = null;
        for (let i = 0; i < rawGroups.length; i++) {
          const g = rawGroups[i];
          const ids = (g.tab_ids ?? []).filter(id => tabsById.has(id));
          if ((g.label ?? "").trim().toLowerCase() === "unsorted") {
            llmUnsorted = { group: g, ids };
            continue;
          }
          if (ids.length < 2) continue;
          const groupTabs = ids.map(id => tabsById.get(id));
          ids.forEach(id => placedIds.add(id));
          const groupForApply = {
            label: g.label,
            emoji: g.emoji,
            summary: g.summary,
            colorIndex: i,
            tabs: groupTabs.map(t => ({ id: t.id, windowId: t.windowId, title: t.title, url: t.url, favIconUrl: t.favIconUrl })),
          };
          groupsToApply.push(groupForApply);
          cachedGroups.push(cacheGroupForTriage(groupForApply));
        }

        const unsortedIds = [];
        const seen = new Set();
        for (const id of [...(llmUnsorted?.ids ?? []), ...triageCandidates.map(t => t.id)]) {
          if (placedIds.has(id) || seen.has(id)) continue;
          if (!tabsById.has(id)) continue;
          seen.add(id);
          unsortedIds.push(id);
        }
        if (unsortedIds.length > 0) {
          const unsortedTabs = unsortedIds.map(id => tabsById.get(id));
          const unsortedGroup = {
            label: "Unsorted",
            summary: llmUnsorted?.group.summary,
            colorIndex: 8,
            tabs: unsortedTabs.map(t => ({ id: t.id, windowId: t.windowId, title: t.title, url: t.url, favIconUrl: t.favIconUrl })),
          };
          groupsToApply.push(unsortedGroup);
          cachedGroups.push(cacheGroupForTriage(unsortedGroup));
        }

        const applyResults = await applyAllAsTabGroups({ groups: groupsToApply });
        const applySummary = summarizeApplyResults({ groups: groupsToApply, results: applyResults });
        for (const failure of applySummary.failures) {
          console.warn("[manual-triage] applyAsTabGroup failed", failure.label, failure.error);
        }

        if (cachedGroups.length > 0) {
          await saveTriageCache({ windowId: win.id, groups: cachedGroups });
        }
        return {
          groups: cachedGroups,
          candidates: triageCandidates.length,
          totalCandidates: originalTabs.length,
          cap,
          applySummary,
        };
      },
    }));
  } finally {
    await setTriageRunning(false).catch(() => {});
  }
  return result;
}

function cacheGroupForTriage(group) {
  return {
    label: group.label,
    emoji: group.emoji,
    summary: group.summary,
    tabs: (group.tabs ?? []).map(t => ({ title: t.title, url: t.url, favIconUrl: t.favIconUrl })),
  };
}
