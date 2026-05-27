# Tab Triage AI — Agent Context

This file is auto-loaded by Claude Code sessions for this repo. Keep it concise; update it as the project moves.

## What this is

A Chrome extension (Manifest V3) that clusters open tabs by intent using a user-provided LLM, summarizes each cluster, and helps clean up stale and duplicate tabs. Bring-your-own-key model — the extension calls Anthropic, OpenAI / any OpenAI-compatible endpoint, or Google Gemini directly from the browser. No backend.

Monetization: $9.99 one-time lifetime via ExtensionPay. Free tier is 5 triages/week, 10 tabs per triage. Slug is `tab-triage-ai` (`lib/config.js`).

## Repo layout

```
manifest.json            MV3 manifest
background/              service worker (auto-triage, badge, sleep, sync, commands)
popup/                   toolbar UI: search, picker, triage results, saved sessions
options/                 settings: LLM provider, Notion, badge, auto-triage, sync
newtab/                  new-tab dashboard: stats, latest triage, stale, dupes, sessions
lib/llm/                 provider-agnostic triage entry point + Anthropic/OpenAI/Gemini adapters
lib/notion.js            Notion API client + markdown-to-blocks converter
lib/{actions,storage,    cross-feature helpers (chrome.tabs ops, storage, billing, etc.)
     billing,badge,
     auto_triage,
     manual_triage,
     sleep_stale,
     session_sync,
     triage_cache,
     fuzzy}.js
lib/config.js            EXTPAY_EXTENSION_ID, BILLING_ENABLED, LIFETIME_PRICE_USD
lib/ExtPay.js            vendored ExtensionPay (IIFE, used as content script)
lib/extpay.module.js     same bundle with ESM export for popup/SW imports
icons/                   16/32/48/128 medical-cross PNGs + build_icons.py source
docs/                    submission assets (privacy policy md + html, store listing copy)
scripts/package.sh       whitelist zip builder, verifies manifest references
```

## Conventions (please honor these)

- **New features default to Lifetime-gated.** Any new feature added to this extension is a licensed (paid) feature unless the user explicitly says it should be free. Gate it behind the ExtensionPay license check (see `lib/billing.js`) and throw `GateError("Lifetime only", ...)` from precondition guards so the inline button feedback reads correctly. Don't add the feature to the free-tier surface unless asked.
- **No emojis or decorative icons in the UI.** Plain text labels only. The toolbar PNG icon stays; everything inside the popup / options / new-tab is wordmark-only.
- **No analytics, no telemetry, no error reporting, no proxy.** Privacy story is load-bearing for the brand. Don't add a fetch to any host the user didn't configure.
- **Always fast-forward `main` after pushing the feature branch.** Sequence is: commit on `claude/marketplace-product-builder-cT0ip` → push → `git checkout main && git merge --ff-only && git push origin main → git checkout` back. (In this sandbox the harness proxy 503s on main pushes; the user pushes main from their own machine.)
- **Settings live in nested subtrees in `chrome.storage.local`**: `llm`, `notion`, `autoTriage`, `badge`, `sleep`, `sync`. `getSettings()` and `saveSettings()` deep-merge the subtrees — don't overwrite siblings on a partial save.
- **Triage result schema**: `{label, summary: [string, string, string], tabs: [{title, url, favIconUrl}], tab_ids?}`. Older code carried an `emoji` field; ignore on render.
- **Notion blocks**: avoid emoji-decorated callouts (Notion forces an icon). Use `paragraph` for metadata, `quote` for notes, `heading_2` + `bulleted_list_item` for groups.
- **Button feedback inline**, not at the top of the page. Use `flashAsyncButton(btn, fn)` (popup and newtab each have a copy). Throw `GateError(message, shortLabel)` for precondition failures so the button reads "Lifetime only" / "Set up first" instead of a generic "Failed."
- **Settings sections must clear the nav trigger line.** `initSectionNav()` in `options/options.js` highlights the section that straddles a trigger line at `scroll-margin-top + 8` (~72px). A section shorter than that would have both its top and bottom above the trigger and be skipped, so any new `<section class="card" id="section-…">` in `options.html` should render taller than ~80px. If a section is genuinely tiny (e.g. a single toggle), pad it with helper copy (`<p class="muted">…</p>`) until it clears the line — don't shrink the trigger.
- **Pricing is `$9.99` lifetime**, stored in `lib/config.js` for UI copy only; authoritative on the ExtensionPay dashboard.

## Build & verify

```bash
# Syntax-check everything important
for f in lib/*.js lib/llm/*.js popup/popup.js options/options.js \
         background/service_worker.js newtab/newtab.js; do node --check "$f"; done
python3 -c "import json; json.load(open('manifest.json'))"

# Regenerate icons (Pillow required)
python3 icons/build_icons.py

# Preview what the store zip would contain
./scripts/package.sh --check

# Build the store zip → dist/tab-triage-ai-<version>.zip
./scripts/package.sh
```

No bundler, no transpile step — files load directly into Chrome.

## Releasing

GitHub Actions (`.github/workflows/`) handles automation:

- `ci.yml` runs on every push and PR: validates `manifest.json`, syntax-checks every JS file in `background/`, `popup/`, `options/`, `newtab/`, `lib/`, and dry-runs `package.sh --check`.
- `release.yml` runs on push of a `v*` tag: verifies the tag matches `manifest.json`'s `version`, builds `dist/tab-triage-ai-<version>.zip`, and creates a GitHub Release with the zip attached and auto-generated release notes.

To cut a release: bump `manifest.json` `version`, commit, then `git tag v<version> && git push origin v<version>`. The workflow handles the rest. Download the zip from the Release page and upload at <https://chrome.google.com/webstore/devconsole/>.

## Live billing

- ExtensionPay slug: `tab-triage-ai`
- `BILLING_ENABLED = true` in `lib/config.js`
- Set the matching `$9.99` price on the ExtensionPay dashboard before shipping
- License flow has been verified end-to-end as of [last session]

## Publishing pipeline state

Done:
- Multi-LLM provider support + per-group custom rules
- Auto-triage + badge + sleep stale tabs + duplicate detection + new-tab dashboard
- Saved sessions with restore (here / new window), notes, Markdown export, Notion export, cross-Chrome sync
- Global fuzzy search (Cmd/Ctrl-Shift-K), keyboard shortcuts for popup and Triage now
- ExtensionPay billing flag is live
- Privacy policy drafted: `docs/PRIVACY.md` + `docs/privacy.html`
- Store listing copy + per-permission justifications drafted: `docs/STORE_LISTING.md`
- `manifest.json` has `description`, `homepage_url` (= GitHub repo URL), `author`
- Packaging script: `scripts/package.sh` (whitelist-based, validates manifest references)
- Support email locked in as `jankoszy@gmail.com` across `manifest.json`, `docs/PRIVACY.md`, `docs/privacy.html`, `docs/STORE_LISTING.md`, `options/options.js` waitlist string

Pending (user-side):
- Capture screenshots per the shot list in `docs/STORE_LISTING.md`
- Set the `$9.99` lifetime price on the ExtensionPay dashboard (slug `tab-triage-ai`)
- Run `./scripts/package.sh`, upload the zip
- Submit and answer review questions using the per-permission justifications in `STORE_LISTING.md`

Done (verified 2026-05-16):
- Repo is public at `https://github.com/shpwrck/Tab-Triage-AI`
- GitHub Pages is live: privacy at `https://shpwrck.github.io/Tab-Triage-AI/privacy.html`, landing at `https://shpwrck.github.io/Tab-Triage-AI/`

User has:
- Chrome Web Store developer account

Site files:
- `docs/index.html` — minimal landing page
- `docs/privacy.html` — privacy policy (effective 2026-05-15)
- `docs/.nojekyll` — disable Jekyll processing, serve raw HTML

Not yet built (deferred):
- Landing page at the domain
- Launch-day post drafts (Reddit / HN / Product Hunt / X)
- Per-tab AI summaries (Lifetime perk; expensive on tokens)
- "Deep mode" — content-script page text extraction. Would need `scripting` + `<all_urls>` (optional). These were removed from the manifest in 0.3.1 because the Chrome Web Store rejected them as "requesting but not using" (unused future-proofing). If deep mode is ever built, re-add them as `optional_permissions`/`optional_host_permissions` *in the same release that ships the feature*, never ahead of it.
- Vertical-tabs sidebar (Chrome ships native equivalents; not the wedge)
- Mobile sync / team sharing (would require a backend, breaks the privacy story)

## Remote / branches

- GitHub repo was renamed to `shpwrck/Tab-Triage-AI`. The harness's git proxy is allowlisted at the original path `shpwrck/claude-app`; GitHub follows the redirect for fetches and feature-branch pushes but persistently 503s on main pushes. **User has been running `main` fast-forwards from their own machine** (`https://github.com/shpwrck/Tab-Triage-AI.git`).
- History was collapsed to a single root commit `ce6c812 "Tab Triage AI v1"` then resumed. New work is committed on the feature branch as usual.

## Notable design decisions to remember

- LLM prompt is in `lib/llm/prompt.js`. It explicitly forbids generic prefixes ("Active task:", "Research:") and caps labels at 22 chars so collapsed Chrome tab groups remain distinguishable. Don't lengthen.
- Auto-triage reassesses every tab in the window (including already-grouped). This was an explicit user decision — the previous "only ungrouped" filter is gone. Pinned tabs are always excluded.
- The `chrome.tabs.lastAccessed` field powers the stale-tab badge, the new-tab "stale" section, and the sleep-stale feature — all share `settings.badge.thresholdHours`.
- The triage cache (`lib/triage_cache.js`) is what powers the new-tab dashboard's "Latest triage" card. Auto-triage and manual triage both write to it; the new-tab page reads.
- Session sync via `chrome.storage.sync` uses one item per session (`tt_session_<id>`); items >8KB stay local-only.
