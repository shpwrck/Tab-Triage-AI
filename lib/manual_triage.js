// Run a triage on the user's currently-focused window from the service-worker
// command handler and return the cached groups. Quota and tab-cap enforcement
// lives in triage_quota.js so every triage surface shares the same rules.

import { getSettings } from "./storage.js";
import { LLMError } from "./llm/index.js";
import { runQuotaLimitedTriage } from "./triage_quota.js";
import { applyAllAsTabGroups, summarizeApplyResults } from "./actions.js";
import { saveTriageCache } from "./triage_cache.js";
import { setTriageRunning } from "./badge.js";
import { isTriageEligibleTab } from "./tab_policy.js";
import { normalizeTriageGroups } from "./triage_normalize.js";

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
  const candidates = tabs.filter(isTriageEligibleTab);
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
        const groupsToApply = normalizeTriageGroups({ rawGroups, tabs: triageCandidates });

        const applyResults = await applyAllAsTabGroups({ groups: groupsToApply });
        const applySummary = summarizeApplyResults({ groups: groupsToApply, results: applyResults });
        for (const failure of applySummary.failures) {
          console.warn("[manual-triage] applyAsTabGroup failed", failure.label, failure.error);
        }

        if (groupsToApply.length > 0) {
          await saveTriageCache({ windowId: win.id, groups: groupsToApply });
        }
        return {
          groups: groupsToApply,
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
