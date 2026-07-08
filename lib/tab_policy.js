const DEFAULT_STALE_THRESHOLD_HOURS = 24;
const HTTP_URL_RE = /^https?:/;

export function isHttpTab(tab) {
  return !!tab?.url && HTTP_URL_RE.test(tab.url);
}

export function isTriageEligibleTab(tab) {
  return isHttpTab(tab) && !tab.pinned;
}

export function staleThresholdMs(hours = DEFAULT_STALE_THRESHOLD_HOURS) {
  const h = Number(hours);
  const safeHours = Number.isFinite(h) && h > 0 ? h : DEFAULT_STALE_THRESHOLD_HOURS;
  return safeHours * 60 * 60 * 1000;
}

export function isStaleTab(tab, { now = Date.now(), thresholdMs = staleThresholdMs() } = {}) {
  return isTriageEligibleTab(tab)
    && typeof tab.lastAccessed === "number"
    && now - tab.lastAccessed >= thresholdMs;
}

export function getStaleTabs(tabs, options) {
  return (tabs ?? [])
    .filter(tab => isStaleTab(tab, options))
    .sort((a, b) => (a.lastAccessed ?? 0) - (b.lastAccessed ?? 0));
}

export function isDestructiveStaleActionEligibleTab(tab, options) {
  return isStaleTab(tab, options) && !tab.active && !tab.audible;
}

export function splitStaleBulkActionTabs(tabs, options) {
  const staleTabs = getStaleTabs(tabs, options);
  const actionTabs = [];
  const protectedTabs = [];
  for (const tab of staleTabs) {
    if (isDestructiveStaleActionEligibleTab(tab, options)) actionTabs.push(tab);
    else protectedTabs.push(tab);
  }
  return { staleTabs, actionTabs, protectedTabs };
}

export function isSleepStaleEligibleTab(tab, options) {
  return isDestructiveStaleActionEligibleTab(tab, options) && !tab.discarded;
}
