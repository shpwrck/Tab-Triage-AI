// Notion API client. Browser-direct fetches work because the extension
// holds host_permissions for api.notion.com; CORS is bypassed.
//
// Setup the user does once at https://www.notion.so/my-integrations:
//   1. Create an internal integration → copy the token (starts with "secret_" or "ntn_")
//   2. Open the Notion page where exports should live → ⋯ menu → "Connections" → invite the integration
//   3. Paste the token + the page URL into Settings here
//
// The extension creates one child page per export under that parent.

const BASE = "https://api.notion.com/v1";
const VERSION = "2022-06-28";

export class NotionError extends Error {
  constructor(message, {
    status = 0,
    pageId = "",
    pageUrl = "",
    nextBlockIndex = null,
    totalBlocks = null,
    retryable = false,
  } = {}) {
    super(message);
    this.name = "NotionError";
    this.status = status;
    this.pageId = pageId;
    this.pageUrl = pageUrl || (pageId ? notionPageUrl(pageId) : "");
    this.nextBlockIndex = Number.isInteger(nextBlockIndex) ? nextBlockIndex : null;
    this.totalBlocks = Number.isInteger(totalBlocks) ? totalBlocks : null;
    this.retryable = Boolean(retryable);
    this.partialPage = pageId
      ? {
        id: pageId,
        url: this.pageUrl,
        nextBlockIndex: this.nextBlockIndex,
        totalBlocks: this.totalBlocks,
      }
      : null;
  }
}

// Notion accepts a hyphenated UUID or a 32-char hex blob; URLs end with the
// latter glued to a slugified title.
export function extractPageId(input) {
  if (!input) return "";
  const trimmed = String(input).trim();
  const uuid = trimmed.match(/[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}/i);
  if (uuid) return uuid[0].replace(/-/g, "");
  const hex = trimmed.match(/[a-f0-9]{32}/i);
  if (hex) return hex[0];
  return trimmed; // hope caller passed a raw id
}

async function notionFetch(path, { method = "GET", token, body } = {}) {
  let res;
  try {
    res = await fetch(`${BASE}${path}`, {
      method,
      headers: {
        "content-type": "application/json",
        Authorization: `Bearer ${token}`,
        "Notion-Version": VERSION,
      },
      body: body ? JSON.stringify(body) : undefined,
    });
  } catch (e) {
    throw new NotionError(`Network error: ${e.message}`);
  }
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    // Pull the human-readable message out of Notion's error envelope.
    let msg = `Notion ${res.status}`;
    try {
      const parsed = JSON.parse(text);
      if (parsed?.message) msg = parsed.message;
    } catch {
      if (text) msg = `${msg}: ${text.slice(0, 200)}`;
    }
    throw new NotionError(msg, { status: res.status });
  }
  return res.json();
}

export async function pingNotion({ token, parentPageId }) {
  if (!token) throw new NotionError("Missing Notion integration token.");
  if (!parentPageId) throw new NotionError("Missing parent page ID.");
  await notionFetch(`/pages/${parentPageId}`, { token });
}

// Create one child page under the parent. The page title is set from
// the session title; the body is one heading_2 per group, followed by
// summary bullets and tab bullets with proper hyperlinks.
export async function sendSessionToNotion({ session, token, parentPageId }) {
  const blocks = sessionToBlocks(session);
  const body = {
    parent: { page_id: parentPageId },
    properties: {
      title: { title: [{ text: { content: truncate(session.title, 200) } }] },
    },
    children: blocks.slice(0, 100), // /pages limit is 100 blocks; append the rest
  };
  const page = await notionFetch("/pages", { method: "POST", token, body });
  await appendBlocksToPage({
    pageId: page.id,
    pageUrl: page.url,
    token,
    blocks,
    startBlockIndex: 100,
  });
  return page;
}

export async function appendSessionToNotionPage({
  session,
  token,
  pageId,
  pageUrl = "",
  startBlockIndex = 0,
}) {
  if (!pageId) throw new NotionError("Missing Notion page ID for retry.");
  const blocks = sessionToBlocks(session);
  const plannedStart = clampBlockIndex(startBlockIndex, blocks.length);
  let appendStart = plannedStart;
  try {
    const existingCount = await countPageChildren({ pageId, token });
    appendStart = Math.max(plannedStart, Math.min(existingCount, blocks.length));
  } catch (e) {
    throw partialPageError(e, {
      pageId,
      pageUrl,
      nextBlockIndex: plannedStart,
      totalBlocks: blocks.length,
    });
  }
  await appendBlocksToPage({
    pageId,
    pageUrl,
    token,
    blocks,
    startBlockIndex: appendStart,
  });
  return { id: pageId, url: pageUrl || notionPageUrl(pageId) };
}

// Create a child page from an in-progress triage result (popup result view).
// Caller passes plain {label, summary, tabs} groups — no session wrapper.
export async function sendTriageToNotion({ title, groups, token, parentPageId, provider }) {
  const session = triageToNotionSession({ title, groups, provider });
  return sendSessionToNotion({ session, token, parentPageId });
}

export function triageToNotionSession({ title, groups, provider, createdAt = new Date().toISOString() }) {
  const session = {
    title: title || `Tab triage · ${new Date().toLocaleString()}`,
    createdAt,
    kind: "triage",
    provider,
    notes: "",
    groups: (groups ?? []).map(g => ({
      label: g.label,
      summary: g.summary ?? [],
      tabs: (g.tabs ?? []).map(t => ({ title: t.title, url: t.url })),
    })),
  };
  return session;
}

function sessionToBlocks(session) {
  const blocks = [];
  blocks.push(metadataParagraph(session));
  if (session.notes && session.notes.trim()) {
    blocks.push(quote(session.notes.trim()));
  }
  blocks.push(divider());
  for (const g of session.groups ?? []) {
    blocks.push(heading2(g.label || "Group"));
    for (const b of g.summary ?? []) blocks.push(bullet(b));
    if ((g.tabs ?? []).length) blocks.push(divider());
    for (const t of g.tabs ?? []) blocks.push(linkBullet(t.title || t.url, t.url));
  }
  return blocks;
}

// Plain paragraph at the top with key facts in bold. No emoji icon —
// Notion's callout block forces one, and the user prefers no decoration.
function metadataParagraph(session) {
  const created = session.createdAt ? new Date(session.createdAt) : new Date();
  const dateText = isNaN(created.getTime())
    ? "(unknown date)"
    : created.toLocaleString(undefined, { dateStyle: "long", timeStyle: "short" });
  const tabCount = (session.groups ?? []).reduce((n, g) => n + (g.tabs?.length ?? 0), 0);
  const groupCount = (session.groups ?? []).length;
  const verb = session.kind === "triage" ? "Triaged " : "Archived ";
  const rich = [
    plain(verb),
    bold(dateText),
    plain(" · "),
    bold(String(tabCount)),
    plain(tabCount === 1 ? " tab · " : " tabs · "),
    bold(String(groupCount)),
    plain(groupCount === 1 ? " group" : " groups"),
  ];
  if (session.provider) {
    rich.push(plain(" · via "));
    rich.push(bold(session.provider));
  }
  return { object: "block", type: "paragraph", paragraph: { rich_text: rich } };
}

const richTextLimit = 2000;

function plain(text) {
  return { text: { content: truncate(text, richTextLimit) } };
}
function bold(text) {
  return {
    text: { content: truncate(text, richTextLimit) },
    annotations: { bold: true },
  };
}
function rich(text, link) {
  const content = truncate(text, richTextLimit);
  const node = { text: { content } };
  if (link) node.text.link = { url: link };
  return node;
}
function heading2(text) {
  return { object: "block", type: "heading_2", heading_2: { rich_text: [rich(text)] } };
}
function bullet(text) {
  return {
    object: "block",
    type: "bulleted_list_item",
    bulleted_list_item: { rich_text: [rich(text)] },
  };
}
function linkBullet(text, url) {
  return {
    object: "block",
    type: "bulleted_list_item",
    bulleted_list_item: { rich_text: [rich(text, url)] },
  };
}
function quote(text) {
  return { object: "block", type: "quote", quote: { rich_text: [rich(text)] } };
}
function divider() {
  return { object: "block", type: "divider", divider: {} };
}
function truncate(s, n) {
  const str = String(s ?? "");
  return str.length > n ? str.slice(0, n - 1) + "…" : str;
}

async function appendBlocksToPage({ pageId, pageUrl = "", token, blocks, startBlockIndex = 0 }) {
  const start = clampBlockIndex(startBlockIndex, blocks.length);
  for (let i = start; i < blocks.length; i += 100) {
    try {
      await notionFetch(`/blocks/${pageId}/children`, {
        method: "PATCH",
        token,
        body: { children: blocks.slice(i, i + 100) },
      });
    } catch (e) {
      throw partialPageError(e, {
        pageId,
        pageUrl,
        nextBlockIndex: i,
        totalBlocks: blocks.length,
      });
    }
  }
}

async function countPageChildren({ pageId, token }) {
  let count = 0;
  let cursor = "";
  do {
    const params = new URLSearchParams({ page_size: "100" });
    if (cursor) params.set("start_cursor", cursor);
    const data = await notionFetch(`/blocks/${pageId}/children?${params}`, { token });
    count += Array.isArray(data.results) ? data.results.length : 0;
    cursor = data.has_more && data.next_cursor ? data.next_cursor : "";
  } while (cursor);
  return count;
}

function partialPageError(error, { pageId, pageUrl = "", nextBlockIndex, totalBlocks }) {
  const message = error instanceof NotionError ? error.message : (error?.message ?? String(error));
  const status = error instanceof NotionError ? error.status : 0;
  return new NotionError(message, {
    status,
    pageId,
    pageUrl,
    nextBlockIndex,
    totalBlocks,
    retryable: true,
  });
}

function clampBlockIndex(value, total) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(Math.floor(n), total));
}

function notionPageUrl(pageId) {
  return pageId ? `https://www.notion.so/${String(pageId).replace(/-/g, "")}` : "";
}
