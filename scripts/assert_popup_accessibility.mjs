import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const popup = readFileSync(new URL("../popup/popup.js", import.meta.url), "utf8");
const html = readFileSync(new URL("../popup/popup.html", import.meta.url), "utf8");

const requiredSnippets = [
  {
    label: "tab picker checkboxes have tab-title accessible names",
    snippet: 'aria-label="Select tab: ${escapeAttr(t.title)}"',
  },
  {
    label: "tab picker titles are labels for the checkbox",
    snippet: '<label class="title" for="${checkboxId}"',
  },
  {
    label: "tab search results are real buttons",
    snippet: '<button type="button" class="search-result-button" aria-label="Switch to tab: ${escapeAttr(t.title || t.url)}">',
  },
  {
    label: "session search primary action names the session",
    snippet: '<button type="button" class="search-result-button" aria-label="Open saved session here: ${escapeAttr(s.title)}">',
  },
  {
    label: "session search new-window action names the session",
    snippet: '<button type="button" class="search-aux" title="Open in a new window" aria-label="Open saved session in a new window: ${escapeAttr(s.title)}">',
  },
  {
    label: "saved-session restore-here action names the session",
    snippet: 'aria-label="Open saved session here: ${escapeAttr(s.title)}"',
  },
  {
    label: "saved-session restore-new action names the session",
    snippet: 'aria-label="Open saved session in a new window: ${escapeAttr(s.title)}"',
  },
  {
    label: "saved-session copy action names the session",
    snippet: 'aria-label="Copy saved session as Markdown: ${escapeAttr(s.title)}"',
  },
  {
    label: "saved-session Notion action names the session",
    snippet: 'aria-label="Send saved session to Notion: ${escapeAttr(s.title)}"',
  },
  {
    label: "saved-session delete action names the session",
    snippet: 'aria-label="Delete saved session: ${escapeAttr(s.title)}"',
  },
];

for (const { label, snippet } of requiredSnippets) {
  assert.ok(popup.includes(snippet), label);
}

assert.ok(
  html.includes('id="select-all" checked aria-label="Select all tabs in this window"'),
  "select-all checkbox has a purpose-specific accessible name",
);

assert.equal(
  (popup.match(/class="search-result-button"/g) ?? []).length,
  2,
  "search tabs and search sessions should each render one primary button template",
);

console.log("Popup accessibility assertions passed.");
