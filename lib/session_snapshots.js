import {
  getSettings,
  SNAPSHOT_LIMIT_CHOICES,
  SNAPSHOT_INTERVAL_CHOICES,
} from "./storage.js";
import { isHttpTab } from "./tab_policy.js";

export const SESSION_SNAPSHOTS_KEY = "tt_session_snapshots";

const SNAPSHOT_STATE_KEY = "tt_session_snapshot_state";
const PERIODIC_ALARM = "tt-session-snapshot:periodic";
const DEBOUNCE_ALARM = "tt-session-snapshot:debounce";
const EVENT_DEBOUNCE_MS = 45_000;
const DEFAULT_SNAPSHOT_LIMIT = 10;
const DEFAULT_SNAPSHOT_INTERVAL_MINUTES = 10;

let _installed = false;
let pendingReason = "automatic update";

export function installSessionSnapshots() {
  if (_installed) return;
  _installed = true;

  const scheduleFromEvent = reason => {
    scheduleSnapshotCapture(reason).catch(e => console.warn("[session-snapshots] schedule failed", e));
  };

  chrome.tabs.onCreated.addListener(() => scheduleFromEvent("tab opened"));
  chrome.tabs.onRemoved.addListener(() => scheduleFromEvent("tab closed"));
  chrome.tabs.onUpdated.addListener((_tabId, changeInfo) => {
    if (changeInfo.url || changeInfo.title || changeInfo.pinned !== undefined || changeInfo.status === "complete") {
      scheduleFromEvent("tab updated");
    }
  });
  chrome.tabs.onMoved?.addListener(() => scheduleFromEvent("tab moved"));
  chrome.tabs.onAttached?.addListener(() => scheduleFromEvent("tab attached"));
  chrome.tabs.onDetached?.addListener(() => scheduleFromEvent("tab detached"));
  chrome.tabs.onReplaced?.addListener(() => scheduleFromEvent("tab replaced"));
  chrome.tabGroups?.onUpdated?.addListener(() => scheduleFromEvent("tab group updated"));
  chrome.tabGroups?.onMoved?.addListener(() => scheduleFromEvent("tab group moved"));
  chrome.windows.onRemoved.addListener(() => scheduleFromEvent("window closed"));

  chrome.alarms.onAlarm.addListener(alarm => {
    if (alarm.name === DEBOUNCE_ALARM) {
      captureSessionSnapshot({ reason: pendingReason }).catch(e => console.warn("[session-snapshots] capture failed", e));
      return;
    }
    if (alarm.name === PERIODIC_ALARM) {
      captureSessionSnapshot({ reason: "periodic check" }).catch(e => console.warn("[session-snapshots] periodic capture failed", e));
    }
  });

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === "local" && changes.tt_settings) {
      configureSnapshotAlarms().catch(e => console.warn("[session-snapshots] settings refresh failed", e));
    }
  });

  configureSnapshotAlarms().catch(e => console.warn("[session-snapshots] install failed", e));
}

export async function configureSnapshotAlarms() {
  const settings = await getSettings();
  const cfg = settings.snapshots ?? {};
  const active = settings.plan === "lifetime" && cfg.enabled;
  if (!active) {
    await chrome.alarms.clear(PERIODIC_ALARM).catch(() => {});
    await chrome.alarms.clear(DEBOUNCE_ALARM).catch(() => {});
    return { enabled: false };
  }

  const intervalMinutes = normalizeSnapshotInterval(cfg.intervalMinutes);
  await chrome.alarms.create(PERIODIC_ALARM, {
    periodInMinutes: intervalMinutes,
    when: Date.now() + Math.min(intervalMinutes * 60_000, 60_000),
  });
  await scheduleSnapshotCapture("startup or settings change");
  return { enabled: true, intervalMinutes };
}

async function scheduleSnapshotCapture(reason) {
  const settings = await getSettings();
  if (settings.plan !== "lifetime" || !settings.snapshots?.enabled) return;
  pendingReason = reason || "automatic update";
  await chrome.alarms.create(DEBOUNCE_ALARM, { when: Date.now() + EVENT_DEBOUNCE_MS });
}

export async function captureSessionSnapshot({ force = false, reason = "automatic update", now = Date.now(), tabs, tabGroupsById } = {}) {
  const settings = await getSettings();
  const cfg = settings.snapshots ?? {};
  if (settings.plan !== "lifetime") {
    return { status: "skipped", reason: "plan" };
  }
  if (!cfg.enabled && !force) {
    return { status: "skipped", reason: "disabled" };
  }

  const nowMs = toEpochMs(now);
  const intervalMs = normalizeSnapshotInterval(cfg.intervalMinutes) * 60_000;
  const state = await readSnapshotState();
  if (!force && state.lastCheckedAt && nowMs - state.lastCheckedAt < intervalMs) {
    return { status: "skipped", reason: "throttled", nextAt: state.lastCheckedAt + intervalMs };
  }

  const sourceTabs = tabs ?? await querySnapshotTabs();
  const sourceGroups = tabGroupsById ?? await readTabGroupsById(sourceTabs);
  const snapshot = buildSnapshotFromTabs(sourceTabs, { tabGroupsById: sourceGroups, now: nowMs, reason });
  if (!snapshot.tabCount) {
    await writeSnapshotState({ ...state, lastCheckedAt: nowMs, lastError: "" });
    return { status: "skipped", reason: "empty" };
  }

  const existing = await listSessionSnapshots();
  if (!force && existing[0]?.signature === snapshot.signature) {
    await writeSnapshotState({
      ...state,
      lastCheckedAt: nowMs,
      lastSnapshotId: existing[0].id,
      lastError: "",
    });
    return { status: "skipped", reason: "unchanged", snapshot: existing[0], count: existing.length };
  }

  const retention = capSnapshotList([snapshot, ...existing], cfg.limit);
  await chrome.storage.local.set({ [SESSION_SNAPSHOTS_KEY]: retention.snapshots });
  await writeSnapshotState({
    lastCheckedAt: nowMs,
    lastSavedAt: nowMs,
    lastSnapshotId: snapshot.id,
    lastReason: reason,
    lastError: "",
  });
  return {
    status: "saved",
    snapshot,
    count: retention.snapshots.length,
    discarded: retention.discarded,
  };
}

export async function listSessionSnapshots() {
  const { [SESSION_SNAPSHOTS_KEY]: raw } = await chrome.storage.local.get(SESSION_SNAPSHOTS_KEY);
  return normalizeSnapshotList(raw);
}

export async function deleteSessionSnapshot(id) {
  const snapshots = await listSessionSnapshots();
  await chrome.storage.local.set({
    [SESSION_SNAPSHOTS_KEY]: snapshots.filter(snapshot => snapshot.id !== id),
  });
}

export async function clearSessionSnapshots() {
  await chrome.storage.local.set({ [SESSION_SNAPSHOTS_KEY]: [] });
  await writeSnapshotState({});
}

export async function getSessionSnapshotStatus() {
  const [settings, snapshots, state] = await Promise.all([
    getSettings(),
    listSessionSnapshots(),
    readSnapshotState(),
  ]);
  return {
    enabled: settings.plan === "lifetime" && !!settings.snapshots?.enabled,
    plan: settings.plan === "lifetime" ? "lifetime" : "free",
    settings: settings.snapshots,
    snapshots,
    state,
  };
}

export function buildSnapshotFromTabs(tabs, { tabGroupsById = {}, now = Date.now(), reason = "automatic update" } = {}) {
  const nowMs = toEpochMs(now);
  const candidates = (tabs ?? [])
    .filter(isSnapshotTab)
    .slice()
    .sort(compareTabsForSnapshot);

  const windowIds = [...new Set(candidates.map(tab => tab.windowId).filter(Number.isFinite))];
  const windowOrder = new Map(windowIds.map((windowId, index) => [windowId, index + 1]));
  const buckets = new Map();

  for (const tab of candidates) {
    const windowLabel = windowOrder.get(tab.windowId) ?? 1;
    const groupId = Number.isInteger(tab.groupId) && tab.groupId >= 0 ? tab.groupId : -1;
    const key = `${tab.windowId ?? "unknown"}:${groupId}`;
    if (!buckets.has(key)) {
      const groupInfo = groupId >= 0 ? readGroupInfo(tabGroupsById, groupId) : null;
      buckets.set(key, {
        windowId: tab.windowId,
        groupId,
        color: groupInfo?.color,
        label: snapshotGroupLabel({ windowLabel, groupInfo, groupId, windowCount: windowIds.length }),
        tabs: [],
      });
    }
    buckets.get(key).tabs.push(snapshotTab(tab));
  }

  const groups = [...buckets.values()]
    .filter(group => group.tabs.length)
    .map(group => ({
      label: group.label,
      color: group.color,
      sourceWindowId: group.windowId,
      sourceGroupId: group.groupId,
      summary: [
        "Automatic local snapshot. Titles and URLs stay in this browser's local storage.",
        `Captured ${group.tabs.length} tab${group.tabs.length === 1 ? "" : "s"} from ${group.label}.`,
      ],
      tabs: group.tabs,
    }));
  const tabCount = groups.reduce((sum, group) => sum + group.tabs.length, 0);
  const snapshot = {
    id: `snap_${nowMs}_${Math.random().toString(36).slice(2, 8)}`,
    kind: "snapshot",
    createdAt: new Date(nowMs).toISOString(),
    title: "Automatic snapshot",
    reason,
    windowCount: tabCount ? Math.max(1, windowIds.length) : 0,
    tabCount,
    groups,
  };
  return { ...snapshot, signature: snapshotSignature(snapshot) };
}

export function normalizeSnapshotList(snapshots) {
  if (!Array.isArray(snapshots)) return [];
  return snapshots
    .map(normalizeSnapshot)
    .filter(snapshot => snapshot.groups.length)
    .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
}

export function capSnapshotList(snapshots, limit = DEFAULT_SNAPSHOT_LIMIT) {
  const normalizedLimit = normalizeSnapshotLimit(limit);
  const normalized = normalizeSnapshotList(snapshots);
  const seen = new Set();
  const deduped = [];
  for (const snapshot of normalized) {
    if (seen.has(snapshot.id)) continue;
    seen.add(snapshot.id);
    deduped.push(snapshot);
  }
  return {
    snapshots: deduped.slice(0, normalizedLimit),
    discarded: Math.max(0, deduped.length - normalizedLimit),
  };
}

export function snapshotUrls(snapshot) {
  return (snapshot?.groups ?? [])
    .flatMap(group => group?.tabs ?? [])
    .map(tab => String(tab?.url || "").trim())
    .filter(url => /^https?:/i.test(url))
    .filter(Boolean);
}

function isSnapshotTab(tab) {
  return isHttpTab(tab) && !tab.incognito;
}

async function querySnapshotTabs() {
  if (chrome.windows?.getAll) {
    const windows = await chrome.windows.getAll({ populate: true, windowTypes: ["normal"] }).catch(() => null);
    if (Array.isArray(windows)) {
      return windows.flatMap(win => (win.tabs ?? []).map(tab => ({ ...tab, windowId: tab.windowId ?? win.id })));
    }
  }
  return chrome.tabs.query({});
}

async function readTabGroupsById(tabs) {
  const ids = [...new Set((tabs ?? [])
    .map(tab => tab?.groupId)
    .filter(id => Number.isInteger(id) && id >= 0))];
  if (!ids.length || !chrome.tabGroups?.get) return {};

  const entries = await Promise.all(ids.map(async id => {
    try {
      const group = await chrome.tabGroups.get(id);
      return [id, group];
    } catch {
      return [id, null];
    }
  }));
  return Object.fromEntries(entries.filter(([, group]) => group));
}

function normalizeSnapshot(snapshot) {
  const source = snapshot && typeof snapshot === "object" ? snapshot : {};
  const createdAt = Number.isFinite(Date.parse(source.createdAt))
    ? source.createdAt
    : new Date().toISOString();
  const groups = normalizeSnapshotGroups(source.groups);
  const tabCount = groups.reduce((sum, group) => sum + group.tabs.length, 0);
  const normalized = {
    ...source,
    id: String(source.id || `snap_${Date.parse(createdAt) || Date.now()}`),
    kind: "snapshot",
    createdAt,
    title: String(source.title || "Automatic snapshot").trim() || "Automatic snapshot",
    reason: String(source.reason || "automatic update"),
    windowCount: Math.max(1, Number(source.windowCount) || 1),
    tabCount,
    groups,
  };
  return {
    ...normalized,
    signature: source.signature || snapshotSignature(normalized),
  };
}

function normalizeSnapshotGroups(groups) {
  if (!Array.isArray(groups)) return [];
  return groups
    .map(group => {
      const source = group && typeof group === "object" ? group : {};
      const tabs = normalizeSnapshotTabs(source.tabs);
      if (!tabs.length) return null;
      const label = String(source.label || "Open tabs").trim() || "Open tabs";
      const summary = Array.isArray(source.summary)
        ? source.summary.map(line => String(line || "").trim()).filter(Boolean)
        : [];
      return { ...source, label, summary, tabs };
    })
    .filter(Boolean);
}

function normalizeSnapshotTabs(tabs) {
  if (!Array.isArray(tabs)) return [];
  return tabs
    .map(tab => {
      const source = tab && typeof tab === "object" ? tab : {};
      const url = String(source.url || "").trim();
      if (!/^https?:/i.test(url)) return null;
      return {
        title: String(source.title || url),
        url,
        favIconUrl: String(source.favIconUrl || ""),
      };
    })
    .filter(Boolean);
}

function snapshotTab(tab) {
  return {
    title: tab.title || tab.url,
    url: tab.url,
    favIconUrl: tab.favIconUrl || "",
  };
}

function snapshotGroupLabel({ windowLabel, groupInfo, groupId, windowCount }) {
  const prefix = windowCount > 1 ? `Window ${windowLabel} - ` : "";
  if (groupId >= 0) {
    const title = String(groupInfo?.title || "").trim();
    return `${prefix}${title || "Tab group"}`;
  }
  return windowCount > 1 ? `Window ${windowLabel} - Ungrouped tabs` : "Open tabs";
}

function readGroupInfo(tabGroupsById, id) {
  if (tabGroupsById instanceof Map) return tabGroupsById.get(id) ?? tabGroupsById.get(String(id));
  return tabGroupsById?.[id] ?? tabGroupsById?.[String(id)] ?? null;
}

function compareTabsForSnapshot(a, b) {
  const aw = Number.isFinite(a.windowId) ? a.windowId : 0;
  const bw = Number.isFinite(b.windowId) ? b.windowId : 0;
  if (aw !== bw) return aw - bw;
  const ai = Number.isFinite(a.index) ? a.index : 0;
  const bi = Number.isFinite(b.index) ? b.index : 0;
  if (ai !== bi) return ai - bi;
  return (a.id ?? 0) - (b.id ?? 0);
}

function snapshotSignature(snapshot) {
  return (snapshot.groups ?? [])
    .map(group => [
      group.sourceWindowId ?? "",
      group.sourceGroupId ?? "",
      group.label ?? "",
      (group.tabs ?? []).map(tab => tab.url).join(","),
    ].join(":"))
    .join("|");
}

function normalizeSnapshotLimit(limit) {
  const rounded = Math.round(Number(limit));
  return SNAPSHOT_LIMIT_CHOICES.includes(rounded) ? rounded : DEFAULT_SNAPSHOT_LIMIT;
}

function normalizeSnapshotInterval(minutes) {
  const rounded = Math.round(Number(minutes));
  return SNAPSHOT_INTERVAL_CHOICES.includes(rounded) ? rounded : DEFAULT_SNAPSHOT_INTERVAL_MINUTES;
}

async function readSnapshotState() {
  const { [SNAPSHOT_STATE_KEY]: state } = await chrome.storage.local.get(SNAPSHOT_STATE_KEY);
  return state && typeof state === "object" ? state : {};
}

async function writeSnapshotState(state) {
  await chrome.storage.local.set({ [SNAPSHOT_STATE_KEY]: state && typeof state === "object" ? state : {} });
}

function toEpochMs(value) {
  if (value instanceof Date) return value.getTime();
  const number = Number(value);
  return Number.isFinite(number) ? number : Date.now();
}
