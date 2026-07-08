// Caches the most recent triage result so the new tab page can show
// summaries without calling the AI provider again. Whoever runs a triage
// (manual from the popup, or auto-triage from the service worker)
// writes here; the new tab page reads.

const KEY = "tt_last_triage";

export async function saveTriageCache({ windowId, groups, createdAt }) {
  // Drop the live Chrome tab id — it goes stale fast — but keep the
  // human-meaningful fields the new tab page needs to render. `createdAt`
  // is optional; pass the original value when you're just mutating the
  // cached groups (closing tabs, archiving) so the "X ago" timestamp
  // doesn't reset on every action.
  const sanitized = (groups ?? []).map(g => ({
    label: g.label,
    emoji: g.emoji,
    summary: g.summary,
    tabs: (g.tabs ?? []).map(t => ({
      title: t.title,
      url: t.url,
      favIconUrl: t.favIconUrl,
    })),
  }));
  await chrome.storage.local.set({
    [KEY]: {
      windowId: windowId ?? null,
      groups: sanitized,
      createdAt: createdAt ?? Date.now(),
    },
  });
}

export async function readTriageCache() {
  const { [KEY]: cached } = await chrome.storage.local.get(KEY);
  return cached ?? null;
}

export async function clearTriageCache() {
  await chrome.storage.local.remove(KEY);
}
