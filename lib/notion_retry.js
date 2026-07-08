const STORAGE_KEY = "tt_notion_partial_exports_v1";
const MAX_RECORDS = 20;
const memoryRecords = new Map();

export function notionExportKey(scope, payload) {
  return `${scope}:${hashString(stableStringify(payload))}`;
}

export function notionGroupsPayload(groups = []) {
  return (groups ?? []).map(group => ({
    label: group?.label ?? "",
    summary: Array.isArray(group?.summary) ? group.summary.map(String) : [],
    tabs: (group?.tabs ?? []).map(tab => ({
      title: tab?.title ?? "",
      url: tab?.url ?? "",
    })),
  }));
}

export function loadNotionPartialExport(key) {
  return readRecords()[key] ?? null;
}

export function saveNotionPartialExport(record) {
  if (!record?.key || !record?.pageId || !record?.session) return;
  const records = readRecords();
  records[record.key] = {
    ...record,
    savedAt: new Date().toISOString(),
  };
  writeRecords(pruneRecords(records));
}

export function clearNotionPartialExport(key) {
  const records = readRecords();
  if (!records[key]) return;
  delete records[key];
  writeRecords(records);
}

function readRecords() {
  const storage = localStorageHandle();
  if (!storage) return Object.fromEntries(memoryRecords);
  try {
    const parsed = JSON.parse(storage.getItem(STORAGE_KEY) || "{}");
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return Object.fromEntries(memoryRecords);
  }
}

function writeRecords(records) {
  memoryRecords.clear();
  for (const [key, record] of Object.entries(records)) memoryRecords.set(key, record);
  const storage = localStorageHandle();
  if (!storage) return;
  try {
    storage.setItem(STORAGE_KEY, JSON.stringify(records));
  } catch {
    // Keep the in-memory copy for the current popup/new-tab session.
  }
}

function pruneRecords(records) {
  return Object.fromEntries(
    Object.entries(records)
      .sort(([, a], [, b]) => String(b?.savedAt ?? "").localeCompare(String(a?.savedAt ?? "")))
      .slice(0, MAX_RECORDS),
  );
}

function localStorageHandle() {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}

function stableStringify(value) {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map(key => (
      `${JSON.stringify(key)}:${stableStringify(value[key])}`
    )).join(",")}}`;
  }
  return JSON.stringify(value);
}

function hashString(value) {
  let hash = 2166136261;
  for (let i = 0; i < value.length; i++) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36);
}
