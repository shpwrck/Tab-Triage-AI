import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const popup = readFileSync(new URL("../popup/popup.js", import.meta.url), "utf8");
const html = readFileSync(new URL("../popup/popup.html", import.meta.url), "utf8");
const newtab = readFileSync(new URL("../newtab/newtab.js", import.meta.url), "utf8");
const newtabHtml = readFileSync(new URL("../newtab/newtab.html", import.meta.url), "utf8");
const options = readFileSync(new URL("../options/options.js", import.meta.url), "utf8");
const optionsHtml = readFileSync(new URL("../options/options.html", import.meta.url), "utf8");

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

const liveRegionSnippets = [
  {
    label: "popup has polite screen-reader status region",
    source: html,
    snippet: 'id="sr-status" class="sr-only" role="status" aria-live="polite" aria-atomic="true"',
  },
  {
    label: "popup has assertive screen-reader alert region",
    source: html,
    snippet: 'id="sr-alert" class="sr-only" role="alert" aria-live="assertive" aria-atomic="true"',
  },
  {
    label: "popup visible errors are assertive alerts",
    source: html,
    snippet: 'id="error" class="error hidden" role="alert" aria-live="assertive" aria-atomic="true"',
  },
  {
    label: "new-tab hero status is live",
    source: newtabHtml,
    snippet: 'id="hero-status" class="status muted" role="status" aria-live="polite" aria-atomic="true"',
  },
  {
    label: "options AI status is live",
    source: optionsHtml,
    snippet: 'id="status" class="status" role="status" aria-live="polite" aria-atomic="true"',
  },
];

for (const { label, source, snippet } of liveRegionSnippets) {
  assert.ok(source.includes(snippet), label);
}

const behaviorSnippets = [
  {
    label: "popup announces async status updates",
    source: popup,
    snippet: "function announceStatus(msg)",
  },
  {
    label: "popup restores focus into rebuilt saved-session lists",
    source: popup,
    snippet: "focusSelectors",
  },
  {
    label: "popup restores focus into rebuilt group nodes",
    source: popup,
    snippet: "function replaceGroupNode(idx, { focusSelectors = [] } = {})",
  },
  {
    label: "new-tab restores note textarea focus after session rerenders",
    source: newtab,
    snippet: 'type: "session-notes"',
  },
  {
    label: "new-tab announces note autosave",
    source: newtab,
    snippet: 'announceStatus("Note saved.")',
  },
  {
    label: "options promotes error statuses to assertive alerts",
    source: options,
    snippet: 'el.setAttribute("role", cls === "err" ? "alert" : "status")',
  },
];

for (const { label, source, snippet } of behaviorSnippets) {
  assert.ok(source.includes(snippet), label);
}

console.log("Popup accessibility assertions passed.");
