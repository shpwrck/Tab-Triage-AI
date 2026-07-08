import assert from "node:assert/strict";
import test from "node:test";

const localStore = new Map();

globalThis.chrome = {
  storage: {
    local: {
      async get(key) {
        if (Array.isArray(key)) {
          return Object.fromEntries(key.map(k => [k, localStore.get(k)]));
        }
        if (typeof key === "string") return { [key]: localStore.get(key) };
        if (key && typeof key === "object") {
          return Object.fromEntries(Object.entries(key).map(([k, fallback]) => [
            k,
            localStore.get(k) ?? fallback,
          ]));
        }
        return Object.fromEntries(localStore.entries());
      },
      async set(values) {
        for (const [key, value] of Object.entries(values)) localStore.set(key, value);
      },
    },
  },
};

const storage = await import("../lib/storage.js");
const snapshots = await import("../lib/session_snapshots.js");

function tab(id, overrides = {}) {
  return {
    id,
    windowId: 1,
    index: id,
    title: `Tab ${id}`,
    url: `https://example.com/${id}`,
    favIconUrl: "",
    groupId: -1,
    ...overrides,
  };
}

async function seedLifetimeSnapshots(settings = {}) {
  localStore.clear();
  await storage.saveSettings({
    plan: "lifetime",
    snapshots: {
      enabled: true,
      limit: 5,
      intervalMinutes: 5,
      ...settings,
    },
  });
}

test("buildSnapshotFromTabs filters unsafe tabs and preserves window/group buckets", () => {
  const snapshot = snapshots.buildSnapshotFromTabs([
    tab(1, { windowId: 4, index: 0, groupId: 7, title: "Grouped A" }),
    tab(2, { windowId: 4, index: 1, groupId: 7, title: "Grouped B" }),
    tab(3, { windowId: 8, index: 0, title: "Ungrouped" }),
    tab(4, { url: "chrome://settings" }),
    tab(5, { incognito: true }),
  ], {
    now: Date.UTC(2026, 0, 1, 12),
    tabGroupsById: { 7: { title: "Research", color: "red" } },
  });

  assert.equal(snapshot.kind, "snapshot");
  assert.equal(snapshot.windowCount, 2);
  assert.equal(snapshot.tabCount, 3);
  assert.deepEqual(snapshot.groups.map(group => group.label), [
    "Window 1 - Research",
    "Window 2 - Ungrouped tabs",
  ]);
  assert.deepEqual(snapshots.snapshotUrls(snapshot), [
    "https://example.com/1",
    "https://example.com/2",
    "https://example.com/3",
  ]);
});

test("captureSessionSnapshot keeps only the configured number of newest snapshots", async () => {
  await seedLifetimeSnapshots();

  for (let i = 0; i < 6; i++) {
    const result = await snapshots.captureSessionSnapshot({
      force: true,
      now: Date.UTC(2026, 0, 1, 12, i),
      tabs: [tab(i + 1, { url: `https://example.com/run-${i}` })],
    });
    assert.equal(result.status, "saved");
  }

  const saved = await snapshots.listSessionSnapshots();
  assert.equal(saved.length, 5);
  assert.deepEqual(saved.map(snapshot => snapshots.snapshotUrls(snapshot)[0]), [
    "https://example.com/run-5",
    "https://example.com/run-4",
    "https://example.com/run-3",
    "https://example.com/run-2",
    "https://example.com/run-1",
  ]);
});

test("captureSessionSnapshot throttles automatic checks and skips unchanged tab sets", async () => {
  await seedLifetimeSnapshots();
  const first = await snapshots.captureSessionSnapshot({
    now: Date.UTC(2026, 0, 1, 12),
    tabs: [tab(1)],
  });
  assert.equal(first.status, "saved");

  const throttled = await snapshots.captureSessionSnapshot({
    now: Date.UTC(2026, 0, 1, 12, 1),
    tabs: [tab(2)],
  });
  assert.equal(throttled.status, "skipped");
  assert.equal(throttled.reason, "throttled");

  const unchanged = await snapshots.captureSessionSnapshot({
    now: Date.UTC(2026, 0, 1, 12, 6),
    tabs: [tab(1)],
  });
  assert.equal(unchanged.status, "skipped");
  assert.equal(unchanged.reason, "unchanged");
  assert.equal((await snapshots.listSessionSnapshots()).length, 1);
});

test("captureSessionSnapshot is Lifetime-gated", async () => {
  localStore.clear();
  await storage.saveSettings({ snapshots: { enabled: true } });

  const result = await snapshots.captureSessionSnapshot({
    force: true,
    tabs: [tab(1)],
  });

  assert.equal(result.status, "skipped");
  assert.equal(result.reason, "plan");
  assert.equal((await snapshots.listSessionSnapshots()).length, 0);
});
