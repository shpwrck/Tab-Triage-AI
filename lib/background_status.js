// Shared persistence for background feature health. These records are small,
// local-only status snapshots used by Options and New Tab to surface failures
// that would otherwise only appear in the service-worker console.

export const BACKGROUND_STATUS_KEY = "tt_background_status";

export const BACKGROUND_FEATURES = Object.freeze({
  AUTO_TRIAGE: "autoTriage",
  SESSION_SYNC: "sessionSync",
});

export const STATUS_LEVELS = Object.freeze({
  INFO: "info",
  WARNING: "warning",
  ERROR: "error",
});

const DEFAULT_NOTIFICATION_COOLDOWN_MS = 6 * 60 * 60 * 1000;

export async function readBackgroundStatus() {
  const { [BACKGROUND_STATUS_KEY]: stored } = await chrome.storage.local.get(BACKGROUND_STATUS_KEY);
  return normalizeStatusMap(stored);
}

export async function getBackgroundFeatureStatus(feature) {
  const all = await readBackgroundStatus();
  return all[feature] ?? null;
}

export async function recordBackgroundFeatureStatus(feature, patch) {
  if (!feature) throw new Error("Missing background status feature.");
  const all = await readBackgroundStatus();
  const previous = all[feature] ?? null;
  const now = Date.now();
  const level = normalizeLevel(patch?.level);
  const title = cleanText(patch?.title, 90);
  const message = cleanText(patch?.message, 260);
  const guidance = cleanText(patch?.guidance, 320);
  const code = cleanText(patch?.code, 80);
  const details = cleanText(patch?.details, 1200);
  const fingerprint = cleanText(
    patch?.fingerprint ?? [level, title, message, guidance, code].join("|"),
    900,
  );
  const sameCondition = previous?.fingerprint === fingerprint;
  const next = {
    feature,
    level,
    title,
    message,
    guidance,
    code,
    details,
    fingerprint,
    firstSeenAt: sameCondition ? (previous.firstSeenAt ?? now) : now,
    updatedAt: now,
    occurrenceCount: sameCondition ? (Number(previous.occurrenceCount) || 1) + 1 : 1,
    lastNotifiedAt: sameCondition ? (Number(previous.lastNotifiedAt) || 0) : 0,
  };
  if (patch?.meta && typeof patch.meta === "object" && !Array.isArray(patch.meta)) {
    next.meta = patch.meta;
  }
  all[feature] = next;
  await chrome.storage.local.set({ [BACKGROUND_STATUS_KEY]: all });
  return next;
}

export async function clearBackgroundFeatureStatus(feature) {
  const all = await readBackgroundStatus();
  if (!all[feature]) return;
  delete all[feature];
  await chrome.storage.local.set({ [BACKGROUND_STATUS_KEY]: all });
}

export async function markBackgroundStatusNotified(feature) {
  const all = await readBackgroundStatus();
  if (!all[feature]) return null;
  all[feature] = { ...all[feature], lastNotifiedAt: Date.now() };
  await chrome.storage.local.set({ [BACKGROUND_STATUS_KEY]: all });
  return all[feature];
}

export function shouldNotifyBackgroundStatus(
  status,
  { minOccurrences = 1, cooldownMs = DEFAULT_NOTIFICATION_COOLDOWN_MS } = {},
) {
  if (!status || status.level === STATUS_LEVELS.INFO) return false;
  if ((Number(status.occurrenceCount) || 1) < minOccurrences) return false;
  const last = Number(status.lastNotifiedAt) || 0;
  return Date.now() - last >= cooldownMs;
}

export function formatBackgroundStatusMessage(status) {
  if (!status) return "";
  return [status.message, status.guidance].filter(Boolean).join(" ");
}

function normalizeStatusMap(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const out = {};
  for (const [feature, status] of Object.entries(value)) {
    if (!status || typeof status !== "object" || Array.isArray(status)) continue;
    out[feature] = {
      ...status,
      level: normalizeLevel(status.level),
      title: cleanText(status.title, 90),
      message: cleanText(status.message, 260),
      guidance: cleanText(status.guidance, 320),
      code: cleanText(status.code, 80),
      details: cleanText(status.details, 1200),
      fingerprint: cleanText(status.fingerprint, 900),
      firstSeenAt: Number(status.firstSeenAt) || 0,
      updatedAt: Number(status.updatedAt) || 0,
      occurrenceCount: Math.max(1, Number(status.occurrenceCount) || 1),
      lastNotifiedAt: Number(status.lastNotifiedAt) || 0,
    };
  }
  return out;
}

function normalizeLevel(level) {
  return Object.values(STATUS_LEVELS).includes(level) ? level : STATUS_LEVELS.INFO;
}

function cleanText(value, maxLength) {
  return String(value ?? "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, maxLength);
}
