// Thin wrappers over chrome.storage.

const SETTINGS_KEY = "tt_settings";
const QUOTA_KEY = "tt_quota";
const SESSIONS_KEY = "tt_sessions";
const DEFAULT_SESSION_LIMIT = 100;
const DEFAULT_SNAPSHOT_LIMIT = 10;
const DEFAULT_SNAPSHOT_INTERVAL_MINUTES = 10;

export const SESSION_LIMIT_CHOICES = [25, 50, 100];
export const SESSION_OVERFLOW_DISCARD_OLDEST = "discard-oldest";
export const SESSION_OVERFLOW_BLOCK_NEW = "block-new";
export const SNAPSHOT_LIMIT_CHOICES = [5, 10, 25];
export const SNAPSHOT_INTERVAL_CHOICES = [5, 10, 30, 60];

export class SessionLimitError extends Error {
  constructor({ limit, count }) {
    super(`Saved session limit reached (${count}/${limit}). Delete older sessions or change the limit in Settings before saving another session.`);
    this.name = "SessionLimitError";
    this.code = "session_limit_reached";
    this.shortLabel = "Limit reached";
    this.limit = limit;
    this.count = count;
  }
}

const DEFAULT_SETTINGS = {
  // Legacy: apiKey was an Anthropic key. Kept here only so the migration
  // below can read it. New code should never write apiKey at the root —
  // use settings.llm.apiKey.
  apiKey: "",
  plan: "free", // "free" | "lifetime" (one-time purchase)
  llm: {
    provider: "anthropic",
    apiKey: "",
    model: "claude-haiku-4-5-20251001",
    baseUrl: "",
    // Free-form rules appended to the system prompt. Examples:
    // "Always keep work email separate from personal."
    // "Group all dev docs under a single 'Docs' label."
    customInstructions: "",
  },
  deepMode: false, // reserved for future content extraction; currently unused
  newtab: {
    enabled: true,
  },
  autoTriage: {
    enabled: false,
    debounceSeconds: 10, // quiet period after the last new-tab event
    throttleSeconds: 90, // minimum gap between auto-triages per window
    minTabs: 6, // need at least this many ungrouped tabs before firing
    notify: true, // show a system notification when auto-triage runs
    pausedUntil: 0, // epoch ms; 0 means not paused
    lastRunAt: 0, // epoch ms of the last successful auto-triage (any window)
  },
  triage: {
    // Domains or simple URL wildcard patterns that should never be sent
    // to the AI provider during full-window triage.
    excludedPatterns: [],
  },
  badge: {
    enabled: true,
    thresholdHours: 24, // tabs not accessed in >= this many hours count as stale
  },
  // When enabled, tabs past the badge threshold also get chrome.tabs.discard()ed
  // to free memory. The tab stays in the strip; navigating back reloads it.
  sleep: {
    enabled: false,
  },
  sync: {
    // Mirror saved sessions to chrome.storage.sync so they appear on
    // every Chrome you're signed into. Off by default; opt-in.
    enabled: false,
  },
  sessions: {
    // Keep storage bounded. The default preserves the previous behavior
    // but the UI now explains it before the oldest sessions are removed.
    limit: DEFAULT_SESSION_LIMIT,
    overflow: SESSION_OVERFLOW_DISCARD_OLDEST,
  },
  snapshots: {
    // Automatic local-only session snapshots. Lifetime-gated and opt-in.
    enabled: false,
    limit: DEFAULT_SNAPSHOT_LIMIT,
    intervalMinutes: DEFAULT_SNAPSHOT_INTERVAL_MINUTES,
  },
  notion: {
    // Personal Notion integration token (secret_xxx or ntn_xxx).
    token: "",
    // Raw page URL or ID as entered, kept so settings reopen readably.
    parentPageInput: "",
    // Page that exports become children of. Stored as the bare 32-char id
    // so export calls stay URL-shape-agnostic.
    parentPageId: "",
  },
  display: {
    // "system" follows prefers-color-scheme; "light"/"dark" force the choice.
    theme: "system",
  },
};

const FREE_TRIAGES_PER_WEEK = 5;
const FREE_TABS_PER_TRIAGE = 10;

export async function getSettings() {
  const { [SETTINGS_KEY]: s } = await chrome.storage.local.get(SETTINGS_KEY);
  const stored = s ?? {};
  const merged = {
    ...DEFAULT_SETTINGS,
    ...stored,
    llm: { ...DEFAULT_SETTINGS.llm, ...(stored.llm ?? {}) },
    newtab: { ...DEFAULT_SETTINGS.newtab, ...(stored.newtab ?? {}) },
    autoTriage: { ...DEFAULT_SETTINGS.autoTriage, ...(stored.autoTriage ?? {}) },
    triage: normalizeTriageSettings({ ...DEFAULT_SETTINGS.triage, ...(stored.triage ?? {}) }),
    badge: { ...DEFAULT_SETTINGS.badge, ...(stored.badge ?? {}) },
    sleep: { ...DEFAULT_SETTINGS.sleep, ...(stored.sleep ?? {}) },
    sync: { ...DEFAULT_SETTINGS.sync, ...(stored.sync ?? {}) },
    sessions: normalizeSessionSettings({ ...DEFAULT_SETTINGS.sessions, ...(stored.sessions ?? {}) }),
    snapshots: normalizeSnapshotSettings({ ...DEFAULT_SETTINGS.snapshots, ...(stored.snapshots ?? {}) }),
    notion: { ...DEFAULT_SETTINGS.notion, ...(stored.notion ?? {}) },
    display: { ...DEFAULT_SETTINGS.display, ...(stored.display ?? {}) },
  };
  // One-time migration: legacy root-level apiKey was always an Anthropic
  // key. Move it into llm.apiKey if the user hasn't already configured a
  // provider key.
  if (stored.apiKey && !merged.llm.apiKey) {
    merged.llm = { ...merged.llm, apiKey: stored.apiKey, provider: "anthropic" };
    await chrome.storage.local.set({ [SETTINGS_KEY]: { ...merged, apiKey: "" } });
  }
  return merged;
}

export async function saveSettings(patch) {
  const current = await getSettings();
  const next = {
    ...current,
    ...patch,
    llm: { ...current.llm, ...(patch.llm ?? {}) },
    newtab: { ...current.newtab, ...(patch.newtab ?? {}) },
    autoTriage: { ...current.autoTriage, ...(patch.autoTriage ?? {}) },
    triage: normalizeTriageSettings({ ...current.triage, ...(patch.triage ?? {}) }),
    badge: { ...current.badge, ...(patch.badge ?? {}) },
    sleep: { ...current.sleep, ...(patch.sleep ?? {}) },
    sync: { ...current.sync, ...(patch.sync ?? {}) },
    sessions: normalizeSessionSettings({ ...current.sessions, ...(patch.sessions ?? {}) }),
    snapshots: normalizeSnapshotSettings({ ...current.snapshots, ...(patch.snapshots ?? {}) }),
    notion: { ...current.notion, ...(patch.notion ?? {}) },
    display: { ...current.display, ...(patch.display ?? {}) },
  };
  await chrome.storage.local.set({ [SETTINGS_KEY]: next });
  return next;
}

export async function getQuota() {
  const { [QUOTA_KEY]: q } = await chrome.storage.local.get(QUOTA_KEY);
  return q ?? { weekStart: weekStart(), used: 0 };
}

export async function bumpQuota() {
  const q = await getQuota();
  const current = weekStart();
  const next = q.weekStart === current ? { ...q, used: q.used + 1 } : { weekStart: current, used: 1 };
  await chrome.storage.local.set({ [QUOTA_KEY]: next });
  return next;
}

export async function checkQuota(settings) {
  if (settings.plan === "lifetime") return { allowed: true, remaining: Infinity, limit: Infinity };
  const q = await getQuota();
  const current = weekStart();
  const used = q.weekStart === current ? q.used : 0;
  const remaining = Math.max(0, FREE_TRIAGES_PER_WEEK - used);
  return { allowed: remaining > 0, remaining, limit: FREE_TRIAGES_PER_WEEK };
}

export function tabLimit(settings) {
  return settings.plan === "lifetime" ? Infinity : FREE_TABS_PER_TRIAGE;
}

export async function listSessions() {
  const { [SESSIONS_KEY]: s } = await chrome.storage.local.get(SESSIONS_KEY);
  return Array.isArray(s) ? s : [];
}

export async function saveSession(session) {
  const result = await saveSessionWithResult(session);
  return result.session;
}

export async function saveSessionWithResult(session) {
  const settings = await getSettings();
  const policy = normalizeSessionSettings(settings.sessions);
  const sessions = await listSessions();
  const normalized = normalizeSession(session);
  const replacing = sessions.some(s => s?.id === normalized.id);
  if (policy.overflow === SESSION_OVERFLOW_BLOCK_NEW && !replacing && sessions.length >= policy.limit) {
    throw new SessionLimitError({ limit: policy.limit, count: sessions.length });
  }
  const next = [normalized, ...sessions.filter(s => s?.id !== normalized.id)];
  const result = capSessions(next, policy);
  await chrome.storage.local.set({ [SESSIONS_KEY]: result.sessions });
  return {
    session: result.sessions.find(s => s.id === normalized.id) ?? normalized,
    limit: policy.limit,
    overflow: policy.overflow,
    discarded: result.discarded,
    count: result.sessions.length,
  };
}

export async function getSessionLimitState(additionalSessions = 1) {
  const settings = await getSettings();
  const policy = normalizeSessionSettings(settings.sessions);
  const sessions = await listSessions();
  const incoming = Math.max(0, Number(additionalSessions) || 0);
  const projected = sessions.length + incoming;
  return {
    count: sessions.length,
    limit: policy.limit,
    overflow: policy.overflow,
    remaining: Math.max(0, policy.limit - sessions.length),
    wouldBlock: policy.overflow === SESSION_OVERFLOW_BLOCK_NEW && projected > policy.limit,
    wouldDiscard: policy.overflow === SESSION_OVERFLOW_DISCARD_OLDEST
      ? Math.max(0, projected - policy.limit)
      : 0,
  };
}

export async function importSessions(incomingSessions) {
  const settings = await getSettings();
  const policy = normalizeSessionSettings(settings.sessions);
  const current = await listSessions();
  const plan = planSessionImport(incomingSessions, current, policy);
  if (plan.wouldBlock) {
    throw new SessionLimitError({ limit: plan.limit, count: plan.projectedCount });
  }
  await chrome.storage.local.set({ [SESSIONS_KEY]: plan.result.sessions });
  return {
    imported: plan.importedCount,
    limit: plan.limit,
    overflow: plan.overflow,
    discarded: plan.wouldDiscard,
    count: plan.result.sessions.length,
  };
}

export async function previewSessionImport(incomingSessions, settingsPatch = {}) {
  const settings = await getSettings();
  const policy = normalizeSessionSettings({
    ...settings.sessions,
    ...(settingsPatch.sessions ?? {}),
  });
  const current = await listSessions();
  const plan = planSessionImport(incomingSessions, current, policy);
  return {
    imported: plan.importedCount,
    current: current.length,
    projectedCount: plan.projectedCount,
    limit: plan.limit,
    overflow: plan.overflow,
    wouldBlock: plan.wouldBlock,
    wouldDiscard: plan.wouldDiscard,
    count: plan.result.sessions.length,
  };
}

export async function replaceSessionsWithLimit(nextSessions) {
  const settings = await getSettings();
  const policy = normalizeSessionSettings(settings.sessions);
  const normalized = normalizeSessionList(nextSessions);
  if (policy.overflow === SESSION_OVERFLOW_BLOCK_NEW && normalized.length > policy.limit) {
    throw new SessionLimitError({ limit: policy.limit, count: normalized.length });
  }
  const result = capSessions(normalized, policy);
  await chrome.storage.local.set({ [SESSIONS_KEY]: result.sessions });
  return {
    limit: policy.limit,
    overflow: policy.overflow,
    discarded: result.discarded,
    count: result.sessions.length,
  };
}

function normalizeTriageSettings(settings) {
  return {
    ...settings,
    excludedPatterns: normalizeStringList(settings?.excludedPatterns),
  };
}

function normalizeStringList(value) {
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

export async function deleteSession(id) {
  const sessions = await listSessions();
  await chrome.storage.local.set({ [SESSIONS_KEY]: sessions.filter(s => s.id !== id) });
}

// Update specific fields on a saved session (e.g. notes, title). No-op
// if the session has been deleted in the meantime.
export async function updateSession(id, patch) {
  const sessions = await listSessions();
  const next = sessions.map(s => (s.id === id ? { ...s, ...patch } : s));
  await chrome.storage.local.set({ [SESSIONS_KEY]: next });
  return next.find(s => s.id === id) ?? null;
}

function normalizeSessionSettings(settings = {}) {
  const rawLimit = Number(settings.limit);
  const roundedLimit = Number.isFinite(rawLimit) ? Math.round(rawLimit) : DEFAULT_SESSION_LIMIT;
  const limit = SESSION_LIMIT_CHOICES.includes(roundedLimit)
    ? roundedLimit
    : DEFAULT_SESSION_LIMIT;
  const overflow = settings.overflow === SESSION_OVERFLOW_BLOCK_NEW
    ? SESSION_OVERFLOW_BLOCK_NEW
    : SESSION_OVERFLOW_DISCARD_OLDEST;
  return { limit, overflow };
}

function normalizeSnapshotSettings(settings = {}) {
  const rawLimit = Number(settings.limit);
  const roundedLimit = Number.isFinite(rawLimit) ? Math.round(rawLimit) : DEFAULT_SNAPSHOT_LIMIT;
  const limit = SNAPSHOT_LIMIT_CHOICES.includes(roundedLimit)
    ? roundedLimit
    : DEFAULT_SNAPSHOT_LIMIT;
  const rawInterval = Number(settings.intervalMinutes);
  const roundedInterval = Number.isFinite(rawInterval) ? Math.round(rawInterval) : DEFAULT_SNAPSHOT_INTERVAL_MINUTES;
  const intervalMinutes = SNAPSHOT_INTERVAL_CHOICES.includes(roundedInterval)
    ? roundedInterval
    : DEFAULT_SNAPSHOT_INTERVAL_MINUTES;
  return {
    enabled: !!settings.enabled,
    limit,
    intervalMinutes,
  };
}

function normalizeSessionList(sessions) {
  return sessions
    .map(normalizeSession)
    .filter(session => session.groups.length);
}

function planSessionImport(incomingSessions, current, policy) {
  if (!Array.isArray(incomingSessions)) {
    throw new Error("Expected sessions to be an array.");
  }
  const imported = normalizeSessionList(incomingSessions);
  const importedIds = new Set(imported.map(s => s.id));
  const merged = [
    ...imported,
    ...current.filter(s => !importedIds.has(s?.id)),
  ];
  const result = capSessions(merged, policy);
  return {
    importedCount: imported.length,
    projectedCount: merged.length,
    limit: policy.limit,
    overflow: policy.overflow,
    wouldBlock: policy.overflow === SESSION_OVERFLOW_BLOCK_NEW && merged.length > policy.limit,
    wouldDiscard: policy.overflow === SESSION_OVERFLOW_DISCARD_OLDEST
      ? result.discarded
      : 0,
    result,
  };
}

function normalizeSession(session) {
  const source = session && typeof session === "object" ? session : {};
  const groups = normalizeSessionGroups(source.groups);
  const id = String(source.id || `s_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`);
  const title = String(source.title || "Saved session").trim() || "Saved session";
  const createdAt = Number.isFinite(Date.parse(source.createdAt))
    ? source.createdAt
    : new Date().toISOString();
  return { ...source, id, title, createdAt, groups };
}

function normalizeSessionGroups(groups) {
  if (!Array.isArray(groups)) return [];
  return groups
    .map(group => {
      const source = group && typeof group === "object" ? group : {};
      const tabs = normalizeSessionTabs(source.tabs);
      if (!tabs.length) return null;
      const label = String(source.label || "Saved tabs").trim() || "Saved tabs";
      const summary = Array.isArray(source.summary)
        ? source.summary.map(line => String(line || "").trim()).filter(Boolean)
        : [];
      return { ...source, label, summary, tabs };
    })
    .filter(Boolean);
}

function normalizeSessionTabs(tabs) {
  if (!Array.isArray(tabs)) return [];
  return tabs
    .map(tab => {
      const source = tab && typeof tab === "object" ? tab : {};
      const url = String(source.url || "").trim();
      if (!url) return null;
      return {
        ...source,
        title: String(source.title || url),
        url,
        favIconUrl: String(source.favIconUrl || ""),
      };
    })
    .filter(Boolean);
}

function capSessions(sessions, policy) {
  const limit = policy.limit;
  if (sessions.length <= limit) return { sessions, discarded: 0 };
  return {
    sessions: sessions.slice(0, limit),
    discarded: sessions.length - limit,
  };
}

function weekStart() {
  const d = new Date();
  const day = d.getUTCDay(); // 0 = Sun
  const offset = (day + 6) % 7; // make Mon = 0
  d.setUTCDate(d.getUTCDate() - offset);
  d.setUTCHours(0, 0, 0, 0);
  return d.toISOString().slice(0, 10);
}
