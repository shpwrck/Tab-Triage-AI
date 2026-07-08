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

function session(index, title = `Session ${index}`) {
  return {
    id: `s_${index}`,
    createdAt: new Date(Date.UTC(2026, 0, index + 1)).toISOString(),
    title,
    groups: [
      {
        label: "Group",
        summary: [],
        tabs: [
          {
            title: "Tab",
            url: `https://example.com/${index}`,
            favIconUrl: "",
          },
        ],
      },
    ],
  };
}

async function seed({ sessions, overflow }) {
  localStore.clear();
  await storage.saveSettings({ sessions: { limit: 25, overflow } });
  await chrome.storage.local.set({ tt_sessions: sessions });
}

test("session import preview does not block same-id restore in block-new mode", async () => {
  const existing = Array.from({ length: 25 }, (_, index) => session(index));
  const backup = existing.map((s, index) => ({ ...s, title: `Restored ${index}` }));
  await seed({ sessions: existing, overflow: storage.SESSION_OVERFLOW_BLOCK_NEW });

  const preview = await storage.previewSessionImport(backup, {
    sessions: { limit: 25, overflow: storage.SESSION_OVERFLOW_BLOCK_NEW },
  });

  assert.equal(preview.imported, 25);
  assert.equal(preview.projectedCount, 25);
  assert.equal(preview.wouldBlock, false);
  assert.equal(preview.wouldDiscard, 0);

  const result = await storage.importSessions(backup);
  assert.equal(result.count, 25);
  assert.equal(result.discarded, 0);
  assert.equal((await storage.listSessions())[0].title, "Restored 0");
});

test("session import preview does not warn for same-id restore in discard-oldest mode", async () => {
  const existing = Array.from({ length: 25 }, (_, index) => session(index));
  const backup = existing.map((s, index) => ({ ...s, title: `Restored ${index}` }));
  await seed({ sessions: existing, overflow: storage.SESSION_OVERFLOW_DISCARD_OLDEST });

  const preview = await storage.previewSessionImport(backup, {
    sessions: { limit: 25, overflow: storage.SESSION_OVERFLOW_DISCARD_OLDEST },
  });

  assert.equal(preview.imported, 25);
  assert.equal(preview.projectedCount, 25);
  assert.equal(preview.wouldBlock, false);
  assert.equal(preview.wouldDiscard, 0);

  const result = await storage.importSessions(backup);
  assert.equal(result.count, 25);
  assert.equal(result.discarded, 0);
});

test("session import preview still reports real over-limit imported sessions", async () => {
  const existing = Array.from({ length: 25 }, (_, index) => session(index));
  const backup = [
    ...existing.map((s, index) => ({ ...s, title: `Restored ${index}` })),
    session(99, "New session"),
  ];
  await seed({ sessions: existing, overflow: storage.SESSION_OVERFLOW_BLOCK_NEW });

  const blockedPreview = await storage.previewSessionImport(backup, {
    sessions: { limit: 25, overflow: storage.SESSION_OVERFLOW_BLOCK_NEW },
  });
  assert.equal(blockedPreview.projectedCount, 26);
  assert.equal(blockedPreview.wouldBlock, true);

  const discardPreview = await storage.previewSessionImport(backup, {
    sessions: { limit: 25, overflow: storage.SESSION_OVERFLOW_DISCARD_OLDEST },
  });
  assert.equal(discardPreview.projectedCount, 26);
  assert.equal(discardPreview.wouldDiscard, 1);
});
