import assert from "node:assert/strict";
import test from "node:test";

import { sessionToMarkdown } from "../lib/session_markdown.js";

test("formats saved-session markdown from stable session metadata", () => {
  const session = {
    id: "s_55",
    title: "Review batch",
    createdAt: "2026-07-08T12:34:00.000Z",
    groups: [
      {
        label: "Research",
        summary: ["Compare popup and new-tab copy behavior", ""],
        tabs: [
          { title: "Issue 55", url: "https://github.com/shpwrck/Tab-Triage-AI/issues/55" },
          { title: "", url: "https://example.com/fallback" },
        ],
      },
      {
        label: "Notes",
        summary: [],
        tabs: [
          { title: "Spec", url: "https://example.com/spec" },
        ],
      },
    ],
  };

  assert.equal(sessionToMarkdown(session), [
    "# Review batch",
    "",
    `_${new Date(session.createdAt).toLocaleString()}_`,
    "",
    "## Research",
    "",
    "- Compare popup and new-tab copy behavior",
    "",
    "- [Issue 55](https://github.com/shpwrck/Tab-Triage-AI/issues/55)",
    "- [https://example.com/fallback](https://example.com/fallback)",
    "",
    "## Notes",
    "",
    "",
    "- [Spec](https://example.com/spec)",
    "",
    "",
  ].join("\n"));
});

test("falls back for incomplete saved-session data", () => {
  assert.equal(sessionToMarkdown({ groups: [{ tabs: [{ url: "https://example.com" }] }] }), [
    "# Saved session",
    "",
    "_Unknown date_",
    "",
    "## Saved tabs",
    "",
    "",
    "- [https://example.com](https://example.com)",
    "",
    "",
  ].join("\n"));
});
