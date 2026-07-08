import { checkQuota, bumpQuota, tabLimit } from "./storage.js";
import { triageTabs } from "./llm/index.js";

export class TriageQuotaError extends Error {
  constructor(message, shortLabel = "Quota reached") {
    super(message);
    this.name = "TriageQuotaError";
    this.shortLabel = shortLabel;
  }
}

export function quotaReachedMessage(quota) {
  return `Free plan: ${quota.limit} triages/week. Resets Monday. Buy lifetime for unlimited.`;
}

export function tabCapMessage(cap) {
  return `Free plan caps triage at ${cap.limit} tabs. Sending the first ${cap.sentCount}. Buy lifetime for unlimited.`;
}

export async function runQuotaLimitedTriage({
  settings,
  tabs,
  onPreflight,
  afterTriage,
} = {}) {
  const originalTabs = Array.isArray(tabs) ? tabs : [];
  const quota = await checkQuota(settings);
  if (!quota.allowed) {
    throw new TriageQuotaError(quotaReachedMessage(quota));
  }

  const limit = tabLimit(settings);
  const triageTabsForPlan = Number.isFinite(limit)
    ? originalTabs.slice(0, limit)
    : originalTabs.slice();
  const cap = {
    applied: triageTabsForPlan.length < originalTabs.length,
    limit,
    originalCount: originalTabs.length,
    sentCount: triageTabsForPlan.length,
  };
  cap.message = cap.applied ? tabCapMessage(cap) : "";

  if (onPreflight) await onPreflight({ quota, cap, tabs: triageTabsForPlan, originalTabs });

  const rawGroups = await triageTabs({
    settings,
    tabs: triageTabsForPlan.map(t => ({ id: t.id, title: t.title, url: t.url })),
  });

  const result = afterTriage
    ? await afterTriage({ rawGroups, tabs: triageTabsForPlan, originalTabs, quota, cap })
    : rawGroups;

  if (settings?.plan !== "lifetime") {
    await bumpQuota();
  }

  return { rawGroups, tabs: triageTabsForPlan, originalTabs, quota, cap, result };
}
