import assert from "node:assert/strict";
import test from "node:test";

import { normalizeTriageGroups } from "../lib/triage_normalize.js";

const tabs = [
  { id: 1, windowId: 10, title: "Alpha", url: "https://a.example", favIconUrl: "a.png" },
  { id: 2, windowId: 10, title: "Beta", url: "https://b.example", favIconUrl: "b.png" },
  { id: 3, windowId: 10, title: "Gamma", url: "https://c.example", favIconUrl: "c.png" },
  { id: 4, windowId: 10, title: "Delta", url: "https://d.example", favIconUrl: "d.png" },
  { id: 5, windowId: 10, title: "Epsilon", url: "https://e.example", favIconUrl: "e.png" },
];

test("normalizes omitted and singleton tabs into Unsorted", () => {
  const groups = normalizeTriageGroups({
    rawGroups: [
      { label: "Work", summary: ["two tabs"], tab_ids: [1, 2] },
      { label: "Singleton", summary: ["not actionable"], tab_ids: [3] },
    ],
    tabs,
  });

  assert.deepEqual(groups.map(g => [g.label, g.tabs.map(t => t.id)]), [
    ["Work", [1, 2]],
    ["Unsorted", [3, 4, 5]],
  ]);
});

test("drops empty and invalid groups without losing candidate tabs", () => {
  const groups = normalizeTriageGroups({
    rawGroups: [
      null,
      { label: "Malformed", tab_ids: 1 },
      { label: "Empty", tab_ids: [999] },
      { label: "Research", tab_ids: [1, 2, 999] },
    ],
    tabs: tabs.slice(0, 3),
  });

  assert.deepEqual(groups.map(g => [g.label, g.tabs.map(t => t.id)]), [
    ["Research", [1, 2]],
    ["Unsorted", [3]],
  ]);
});

test("keeps each tab in one visible group when ids are duplicated", () => {
  const groups = normalizeTriageGroups({
    rawGroups: [
      { label: "First", tab_ids: [1, 2] },
      { label: "Second", tab_ids: [2, 3] },
      { label: "Unsorted", summary: ["from model"], tab_ids: [4] },
    ],
    tabs,
  });

  assert.deepEqual(groups.map(g => [g.label, g.summary, g.tabs.map(t => t.id)]), [
    ["First", undefined, [1, 2]],
    ["Unsorted", ["from model"], [4, 3, 5]],
  ]);
});
