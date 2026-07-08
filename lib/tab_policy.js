const DEFAULT_STALE_THRESHOLD_HOURS = 24;
const HTTP_URL_RE = /^https?:/;
const TRAILING_DOT_RE = /\.$/;

export function isHttpTab(tab) {
  return !!tab?.url && HTTP_URL_RE.test(tab.url);
}

export function isTriageEligibleTab(tab, options = {}) {
  return isHttpTab(tab) && !tab.pinned && !isTriageExcludedTab(tab, options);
}

export function getTriageEligibleTabs(tabs, options = {}) {
  return (tabs ?? []).filter(tab => isTriageEligibleTab(tab, options));
}

export function isTriageExcludedTab(tab, options = {}) {
  if (!isHttpTab(tab)) return false;
  const patterns = getTriageExclusionPatterns(options);
  if (!patterns.length) return false;
  let url;
  try {
    url = new URL(tab.url);
  } catch {
    return false;
  }
  return patterns.some(pattern => matchesTriageExclusionPattern(url, pattern));
}

export function getTriageExclusionPatterns(options = {}) {
  const source = options?.settings ?? options;
  return normalizeTriageExclusionPatterns(
    options?.excludedPatterns ?? source?.triage?.excludedPatterns,
  );
}

export function parseTriageExclusionText(value) {
  return normalizeTriageExclusionPatterns(String(value ?? "").split(/\r?\n/));
}

export function formatTriageExclusionText(patterns) {
  return normalizeTriageExclusionPatterns(patterns).join("\n");
}

export function normalizeTriageExclusionPatterns(value) {
  const source = Array.isArray(value)
    ? value
    : (typeof value === "string" ? value.split(/\r?\n/) : []);
  const normalized = [];
  const seen = new Set();
  for (const item of source) {
    const text = String(item ?? "").trim();
    if (!text) continue;
    const key = text.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    normalized.push(text);
  }
  return normalized;
}

export function matchesTriageExclusionPattern(urlLike, pattern) {
  const value = String(pattern ?? "").trim();
  if (!value) return false;
  const url = urlLike instanceof URL ? urlLike : safeUrl(urlLike);
  if (!url || !["http:", "https:"].includes(url.protocol)) return false;

  if (isHostOnlyPattern(value)) {
    return matchHostPattern(url, value);
  }

  if (value.includes("*")) {
    const target = value.includes("://") ? url.href : urlWithoutProtocol(url);
    return wildcardRegExp(value).test(target);
  }

  const parsed = parseUrlPattern(value);
  if (parsed) {
    if (value.includes("://") && parsed.protocol !== url.protocol) return false;
    return hostMatchesDomain(url.hostname, parsed.hostname)
      && urlPath(url).startsWith(urlPath(parsed));
  }

  return false;
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

function safeUrl(url) {
  try {
    return new URL(String(url ?? ""));
  } catch {
    return null;
  }
}

function isHostOnlyPattern(pattern) {
  return !pattern.includes("/") && !pattern.includes("://");
}

function matchHostPattern(url, pattern) {
  const value = pattern.toLowerCase().replace(TRAILING_DOT_RE, "");
  const hostTarget = value.includes(":") ? url.host.toLowerCase() : url.hostname.toLowerCase();
  if (value.includes("*")) return wildcardRegExp(value).test(hostTarget);
  const bare = value.replace(/^\*\./, "");
  return hostMatchesDomain(hostTarget, bare);
}

function hostMatchesDomain(hostname, domain) {
  const host = String(hostname ?? "").toLowerCase().replace(TRAILING_DOT_RE, "");
  const target = String(domain ?? "").toLowerCase().replace(TRAILING_DOT_RE, "");
  if (!host || !target) return false;
  return host === target || host.endsWith(`.${target}`);
}

function parseUrlPattern(pattern) {
  try {
    return new URL(pattern.includes("://") ? pattern : `https://${pattern}`);
  } catch {
    return null;
  }
}

function urlWithoutProtocol(url) {
  return `${url.host}${url.pathname}${url.search}${url.hash}`;
}

function urlPath(url) {
  return `${url.pathname || "/"}${url.search}${url.hash}`;
}

function wildcardRegExp(pattern) {
  const escaped = String(pattern)
    .toLowerCase()
    .replace(/[|\\{}()[\]^$+?.]/g, "\\$&")
    .replace(/\*/g, ".*");
  return new RegExp(`^${escaped}$`, "i");
}
