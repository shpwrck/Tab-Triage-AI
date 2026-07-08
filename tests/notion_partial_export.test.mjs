import assert from "node:assert/strict";
import test from "node:test";

import {
  appendSessionToNotionPage,
  sendSessionToNotion,
  NotionError,
} from "../lib/notion.js";

const BASE = "https://api.notion.com/v1";
const pageId = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
const pageUrl = "https://www.notion.so/partial-page";

function largeSession(tabCount = 105) {
  return {
    id: "s_large",
    title: "Large export",
    createdAt: "2026-07-08T12:00:00.000Z",
    groups: [
      {
        label: "Research",
        summary: [],
        tabs: Array.from({ length: tabCount }, (_, index) => ({
          title: `Tab ${index + 1}`,
          url: `https://example.com/${index + 1}`,
        })),
      },
    ],
  };
}

function response(status, body) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async json() {
      return body;
    },
    async text() {
      return JSON.stringify(body);
    },
  };
}

test("sendSessionToNotion exposes a created partial page when appending fails", async () => {
  const calls = [];
  globalThis.fetch = async (url, options = {}) => {
    const path = String(url).replace(BASE, "");
    const body = options.body ? JSON.parse(options.body) : null;
    calls.push({ path, method: options.method ?? "GET", body });
    if (path === "/pages") {
      return response(200, { id: pageId, url: pageUrl });
    }
    return response(503, { message: "append failed" });
  };

  let error;
  try {
    await sendSessionToNotion({
      session: largeSession(),
      token: "secret_test",
      parentPageId: "parent",
    });
  } catch (e) {
    error = e;
  }

  assert.ok(error instanceof NotionError);
  assert.equal(error.message, "append failed");
  assert.equal(error.pageId, pageId);
  assert.equal(error.pageUrl, pageUrl);
  assert.equal(error.nextBlockIndex, 100);
  assert.equal(error.totalBlocks, 109);
  assert.equal(error.retryable, true);
  assert.equal(calls.length, 2);
  assert.equal(calls[0].path, "/pages");
  assert.equal(calls[0].body.children.length, 100);
  assert.equal(calls[1].path, `/blocks/${pageId}/children`);
  assert.equal(calls[1].body.children.length, 9);
});

test("appendSessionToNotionPage counts existing children before appending missing blocks", async () => {
  const calls = [];
  globalThis.fetch = async (url, options = {}) => {
    const parsed = new URL(String(url));
    const path = `${parsed.pathname.replace("/v1", "")}${parsed.search}`;
    const body = options.body ? JSON.parse(options.body) : null;
    calls.push({ path, method: options.method ?? "GET", body });
    if (path === `/blocks/${pageId}/children?page_size=100`) {
      return response(200, {
        results: Array.from({ length: 100 }, (_, index) => ({ id: `block-${index}` })),
        has_more: true,
        next_cursor: "cursor-2",
      });
    }
    if (path === `/blocks/${pageId}/children?page_size=100&start_cursor=cursor-2`) {
      return response(200, {
        results: [{ id: "block-100" }, { id: "block-101" }],
        has_more: false,
      });
    }
    if (path === `/blocks/${pageId}/children`) {
      return response(200, { results: [] });
    }
    throw new Error(`Unexpected Notion fetch: ${path}`);
  };

  const page = await appendSessionToNotionPage({
    session: largeSession(),
    token: "secret_test",
    pageId,
    pageUrl,
    startBlockIndex: 100,
  });

  assert.deepEqual(page, { id: pageId, url: pageUrl });
  assert.deepEqual(calls.map(call => [call.method, call.path]), [
    ["GET", `/blocks/${pageId}/children?page_size=100`],
    ["GET", `/blocks/${pageId}/children?page_size=100&start_cursor=cursor-2`],
    ["PATCH", `/blocks/${pageId}/children`],
  ]);
  assert.equal(calls[2].body.children.length, 7);
});
