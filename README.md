# Tab Triage AI

A Chrome extension that groups your open tabs by **intent** (research project, buying decision, rabbit hole), summarizes each cluster in three bullets, and lets you save resumable research sessions.

Bring-your-own-key. Works with Anthropic (Claude), OpenAI / OpenAI-compatible (OpenRouter, Groq, Together, Ollama, LM Studio, vLLM), or Google (Gemini). Your key stays on this device and is sent directly to the provider's API — no proxy in between.

## Install (developer mode)

1. Clone this repo.
2. (Optional) regenerate icons: `python3 icons/build_icons.py` — Pillow required.
3. Open `chrome://extensions`, toggle **Developer mode** on, click **Load unpacked**, and choose this folder.
4. Click the new toolbar icon → **Settings** → paste your Anthropic API key. Get one at [console.anthropic.com](https://console.anthropic.com/settings/keys).
5. Hit **Test connection** to verify, then close settings and click **Triage tabs** in the popup.

Keyboard shortcut: `Ctrl+Shift+Y` (`Cmd+Shift+Y` on macOS).

## How it works

- The popup lists tabs in the current window. You pick which to include (default: all).
- "Triage" sends `{id, title, url}` for each selected tab to Claude with a system prompt asking it to cluster by intent and write three-bullet summaries.
- Result is shown grouped, with a tab list under each group. Save as a session (stored in `chrome.storage.local`), restore later as a new window, or copy to Markdown.

## Auto-triage (opt-in)

Enable from Settings → Auto-triage to have the extension silently re-group **untouched** (non-grouped) tabs in a window into native Chrome tab groups as you browse. Defaults:

- 10s debounce after the last new tab
- 90s minimum gap between runs per window
- 6+ ungrouped tabs required before firing
- Your manual Chrome tab groups are never modified
- One Claude API call per run (Haiku); see Settings for "Pause for 1 hour" / "Pause until tomorrow" kill switches

State is durable across service-worker eviction: the debounce uses `chrome.alarms`, throttle and pause are persisted to `chrome.storage.local`.

## Enabling Lifetime billing

The repo ships with ExtensionPay wired in but disabled. To turn it on:

1. Sign up at [extensionpay.com](https://extensionpay.com) and create a new extension. The slug you choose becomes part of your checkout URL.
2. Configure the product as a **one-time purchase** (lifetime). Set the price you want.
3. Open `lib/config.js`:
   - Replace `EXTPAY_EXTENSION_ID` with your slug.
   - Set `LIFETIME_PRICE_USD` to match what you set on ExtensionPay (for UI copy only — the authoritative price lives on their side).
   - Flip `BILLING_ENABLED` to `true`.
4. Reload the unpacked extension in `chrome://extensions`.

Lifetime status is read from ExtPay on every popup/options open and cached in `chrome.storage.local`. The service worker's `startBackground()` keeps the cache fresh and refreshes it the moment the user completes checkout (via the content script that runs on `extensionpay.com`).

## Project layout

```
manifest.json          # MV3 manifest
background/            # service worker (window restore + hotkey)
popup/                 # main UI shown when you click the toolbar
options/               # API key + waitlist + privacy
lib/claude.js          # direct fetch to api.anthropic.com
lib/storage.js         # chrome.storage helpers + free quota
lib/billing.js         # ExtPay wrapper (plan refresh, checkout, login)
lib/config.js          # EXTPAY_EXTENSION_ID + BILLING_ENABLED flag
lib/ExtPay.js          # vendored IIFE bundle (used as content script)
lib/extpay.module.js   # same bundle re-exported as an ES module
icons/                 # toolbar icons + build script
```

## Free tier limits

- 5 triages per week (resets Monday UTC)
- 10 tabs per triage

Lifetime (one-time purchase) lifts both limits, adds deep mode (sends page text, not just titles), and ships Notion export.

## Privacy

- The API key is stored in this browser only (`chrome.storage.local`).
- Tab titles + URLs go to Anthropic on triage. Nothing else leaves your machine.
- No analytics, telemetry, or third-party servers.
