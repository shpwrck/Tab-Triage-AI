import assert from "node:assert/strict";

const calls = {
  windowsCreate: [],
  windowsUpdate: [],
  tabsCreate: [],
  tabsGroup: [],
  tabGroupsUpdate: [],
};

let nextTabId = 100;
let nextGroupId = 200;

globalThis.chrome = {
  windows: {
    async create(options) {
      calls.windowsCreate.push(options);
      return {
        id: 77,
        tabs: [{ id: nextTabId++, windowId: 77, url: options.url }],
      };
    },
    async update(windowId, options) {
      calls.windowsUpdate.push({ windowId, options });
    },
  },
  tabs: {
    async create(options) {
      calls.tabsCreate.push(options);
      return { id: nextTabId++, windowId: options.windowId, url: options.url };
    },
    async group(options) {
      calls.tabsGroup.push(options);
      return nextGroupId++;
    },
    async query() {
      return [];
    },
  },
  tabGroups: {
    async update(groupId, options) {
      calls.tabGroupsUpdate.push({ groupId, options });
    },
  },
};

const { restoreSession } = await import("../lib/actions.js");

function reset() {
  for (const values of Object.values(calls)) values.length = 0;
  nextTabId = 100;
  nextGroupId = 200;
}

reset();
const newWindowResult = await restoreSession({
  groups: [
    {
      label: "Research",
      color: "red",
      tabs: [
        { title: "A", url: "https://example.com/a" },
        { title: "B", url: "https://example.com/b" },
      ],
    },
    {
      label: "Writing",
      colorIndex: 2,
      tabs: [{ title: "C", url: "https://example.com/c" }],
    },
  ],
});

assert.equal(newWindowResult.windowId, 77);
assert.deepEqual(calls.windowsCreate, [{ url: "https://example.com/a", focused: true }]);
assert.deepEqual(calls.tabsCreate, [
  { windowId: 77, url: "https://example.com/b", active: false },
  { windowId: 77, url: "https://example.com/c", active: false },
]);
assert.deepEqual(calls.tabsGroup, [
  { tabIds: [100, 101], createProperties: { windowId: 77 } },
  { tabIds: [102], createProperties: { windowId: 77 } },
]);
assert.deepEqual(calls.tabGroupsUpdate, [
  { groupId: 200, options: { title: "Research", color: "red", collapsed: false } },
  { groupId: 201, options: { title: "Writing", color: "green", collapsed: false } },
]);

reset();
const currentWindowResult = await restoreSession({
  windowId: 42,
  groups: [
    {
      label: "Build",
      tabs: [
        { title: "D", url: "https://example.com/d" },
        { title: "E", url: "https://example.com/e" },
      ],
    },
    {
      label: "Review",
      tabs: [{ title: "F", url: "https://example.com/f" }],
    },
  ],
});

assert.equal(currentWindowResult.windowId, 42);
assert.deepEqual(calls.windowsCreate, []);
assert.deepEqual(calls.tabsCreate, [
  { windowId: 42, url: "https://example.com/d", active: true },
  { windowId: 42, url: "https://example.com/e", active: false },
  { windowId: 42, url: "https://example.com/f", active: false },
]);
assert.deepEqual(calls.tabsGroup, [
  { tabIds: [100, 101], createProperties: { windowId: 42 } },
  { tabIds: [102], createProperties: { windowId: 42 } },
]);
assert.deepEqual(calls.tabGroupsUpdate, [
  { groupId: 200, options: { title: "Build", color: "blue", collapsed: false } },
  { groupId: 201, options: { title: "Review", color: "purple", collapsed: false } },
]);

reset();
await restoreSession({ windowId: 42, urls: ["https://example.com/flat"] });
assert.deepEqual(calls.tabsCreate, [
  { windowId: 42, url: "https://example.com/flat", active: true },
]);
assert.deepEqual(calls.tabsGroup, []);

console.log("restore_session_group_structure.test.mjs passed");
