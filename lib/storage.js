// Thin wrappers over chrome.storage.

const SETTINGS_KEY = "tt_settings";
const QUOTA_KEY = "tt_quota";
const SESSIONS_KEY = "tt_sessions";

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
  deepMode: false, // pro only: fetch page text for richer summaries
  autoTriage: {
    enabled: false,
    debounceSeconds: 10, // quiet period after the last new-tab event
    throttleSeconds: 90, // minimum gap between auto-triages per window
    minTabs: 6, // need at least this many ungrouped tabs before firing
    notify: true, // show a system notification when auto-triage runs
    pausedUntil: 0, // epoch ms; 0 means not paused
    lastRunAt: 0, // epoch ms of the last successful auto-triage (any window)
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
  notion: {
    // Personal Notion integration token (secret_xxx or ntn_xxx).
    token: "",
    // Page that exports become children of. Stored as the bare 32-char id
    // so it's URL-shape-agnostic.
    parentPageId: "",
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
    autoTriage: { ...DEFAULT_SETTINGS.autoTriage, ...(stored.autoTriage ?? {}) },
    badge: { ...DEFAULT_SETTINGS.badge, ...(stored.badge ?? {}) },
    sleep: { ...DEFAULT_SETTINGS.sleep, ...(stored.sleep ?? {}) },
    sync: { ...DEFAULT_SETTINGS.sync, ...(stored.sync ?? {}) },
    notion: { ...DEFAULT_SETTINGS.notion, ...(stored.notion ?? {}) },
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
    autoTriage: { ...current.autoTriage, ...(patch.autoTriage ?? {}) },
    badge: { ...current.badge, ...(patch.badge ?? {}) },
    sleep: { ...current.sleep, ...(patch.sleep ?? {}) },
    sync: { ...current.sync, ...(patch.sync ?? {}) },
    notion: { ...current.notion, ...(patch.notion ?? {}) },
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
  return s ?? [];
}

export async function saveSession(session) {
  const sessions = await listSessions();
  sessions.unshift(session);
  // Cap to 100 most recent to keep storage healthy.
  const trimmed = sessions.slice(0, 100);
  await chrome.storage.local.set({ [SESSIONS_KEY]: trimmed });
  return session;
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

function weekStart() {
  const d = new Date();
  const day = d.getUTCDay(); // 0 = Sun
  const offset = (day + 6) % 7; // make Mon = 0
  d.setUTCDate(d.getUTCDate() - offset);
  d.setUTCHours(0, 0, 0, 0);
  return d.toISOString().slice(0, 10);
}
