import assert from "node:assert/strict";
import test from "node:test";

import {
  formatTriageExclusionText,
  getTriageEligibleTabs,
  isTriageExcludedTab,
  matchesTriageExclusionPattern,
  parseTriageExclusionText,
} from "../lib/tab_policy.js";

test("parses exclusion text into a stable unique list", () => {
  const patterns = parseTriageExclusionText("\nExample.com\nexample.com\n  docs.example.com/path/*  \n");

  assert.deepEqual(patterns, ["Example.com", "docs.example.com/path/*"]);
  assert.equal(formatTriageExclusionText(patterns), "Example.com\ndocs.example.com/path/*");
});

test("domain exclusions match the domain and subdomains only", () => {
  assert.equal(matchesTriageExclusionPattern("https://example.com/inbox", "example.com"), true);
  assert.equal(matchesTriageExclusionPattern("https://mail.example.com/inbox", "example.com"), true);
  assert.equal(matchesTriageExclusionPattern("https://notexample.com/inbox", "example.com"), false);
});

test("URL wildcard exclusions match path-scoped tabs", () => {
  assert.equal(matchesTriageExclusionPattern("https://example.com/private/a", "example.com/private/*"), true);
  assert.equal(matchesTriageExclusionPattern("http://example.com/private/a", "example.com/private/*"), true);
  assert.equal(matchesTriageExclusionPattern("https://example.com/public/a", "example.com/private/*"), false);
  assert.equal(matchesTriageExclusionPattern("http://example.com/private/a", "https://example.com/private/*"), false);
});

test("eligible triage candidates exclude pinned and configured patterns", () => {
  const tabs = [
    { id: 1, title: "Pinned", url: "https://news.example.com", pinned: true },
    { id: 2, title: "Mail", url: "https://mail.example.com/inbox", pinned: false },
    { id: 3, title: "Docs", url: "https://docs.example.com/private/a", pinned: false },
    { id: 4, title: "Work", url: "https://work.example.net", pinned: false },
    { id: 5, title: "Settings", url: "chrome://settings", pinned: false },
  ];

  const eligible = getTriageEligibleTabs(tabs, {
    triage: {
      excludedPatterns: ["mail.example.com", "docs.example.com/private/*"],
    },
  });

  assert.deepEqual(eligible.map(tab => tab.id), [4]);
  assert.equal(isTriageExcludedTab(tabs[1], { triage: { excludedPatterns: ["example.com"] } }), true);
});
