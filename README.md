# Tab Triage AI

A Chrome extension that groups your open tabs by **what you're trying to do** — research project, buying decision, rabbit hole, active task — summarizes each group in three bullets, and helps you clean up stale and duplicate tabs.

Bring-your-own-key. Works with Anthropic (Claude), OpenAI / any OpenAI-compatible endpoint (OpenRouter, Groq, Together, Ollama, LM Studio, vLLM, etc.), or Google (Gemini). Your key stays on your device and is sent directly to the AI provider's API. No proxy, no analytics, no backend.

## Product terminology

| Concept | Use | Avoid |
|---|---|---|
| Product name | Tab Triage AI | Tab Triage as a product name |
| Triage output | groups; Chrome tab groups when referring to native browser groups | clusters |
| Setup | AI provider; API key | LLM provider; LLM key |
| Stale tabs | stale tabs; tabs you haven't used recently | untouched; not activated |

## Install

Coming soon to the Chrome Web Store.

Until then, install from source:

1. Download or clone this repo.
2. Open `chrome://extensions`, toggle **Developer mode** on, click **Load unpacked**, and choose the folder.
3. Click the new toolbar icon and open **Settings** to set up an AI provider (see below).

## Pick an AI provider

Open Settings, pick an AI provider, paste an API key, click **Test connection**.

- **Anthropic (Claude)** — get a key at [console.anthropic.com/settings/keys](https://console.anthropic.com/settings/keys).
- **OpenAI** — get a key at [platform.openai.com/api-keys](https://platform.openai.com/api-keys).
- **Google (Gemini)** — get a key at [aistudio.google.com/app/apikey](https://aistudio.google.com/app/apikey).
- **OpenAI-compatible** (OpenRouter, Groq, Together, Ollama, LM Studio, vLLM, etc.) — paste your key and set the Base URL for that provider.

### Don't want to pay for an AI model?

OpenRouter offers several models for free with no credit card required.

1. Sign up at [openrouter.ai](https://openrouter.ai).
2. Create a key at [openrouter.ai/keys](https://openrouter.ai/keys).
3. In the extension Settings:
   - AI provider: **OpenAI-compatible**
   - API key: paste your OpenRouter key
   - Base URL: `https://openrouter.ai/api/v1`
   - Model: any with the `:free` suffix from [the free model list](https://openrouter.ai/models?max_price=0) (e.g. `deepseek/deepseek-chat-v3-0324:free`, `google/gemini-2.0-flash-exp:free`, `meta-llama/llama-3.3-70b-instruct:free`).
4. Click **Test connection**.

Free models have per-day limits and can be slower than paid ones. If a triage fails, swap in a different `:free` model.

## What it does

- **Triage tabs** — groups the tabs in the current window by intent, with three-bullet summaries and one-click "Apply as Chrome tab groups." Keyboard shortcut: `Cmd/Ctrl+Shift+U`.
- **Auto-triage (opt-in)** — quietly regroups your window into native Chrome tab groups as you browse. Tunable debounce, throttle, and minimum-tab threshold. Off by default.
- **Stale-tab badge** — count of tabs you haven't used in a configurable threshold (default 24h) shown on the toolbar icon.
- **Sleep stale tabs** — optional auto-discard at the stale threshold to free memory; tabs stay in the tab strip and reload on click.
- **New-tab dashboard** — stats, latest triage, stale tabs, and duplicate URLs in one view.
- **Saved sessions** — close a group of tabs without losing the work; restore later into the current window or a new one. Optional notes per session.
- **Cross-Chrome sync (opt-in)** — saved sessions mirror via `chrome.storage.sync` to every Chrome you're signed into.
- **Notion export** — send a triage result, a single group, or a saved session straight into a Notion page.
- **Global search** — `Cmd/Ctrl+Shift+K` opens the popup with a fuzzy search across every open tab in every window plus every saved session.
- **Custom grouping rules** — free-form preferences appended to the triage prompt (e.g. "Keep work email separate from personal").

## Keyboard shortcuts

- `Cmd/Ctrl+Shift+Y` — open the popup
- `Cmd/Ctrl+Shift+U` — triage the current window now
- `Cmd/Ctrl+Shift+K` — open the popup with the global search focused

## Pricing

- **Free** — 5 triages per week, 10 tabs per triage.
- **Lifetime — $9.99 one-time** — unlimited triages, no tab cap, Notion export.

The AI provider cost is separate and goes to whichever provider's key you pasted (or zero if you use a `:free` model on OpenRouter).

## Privacy

- API keys, settings, saved sessions, and the triage cache live only in `chrome.storage.local` on your device.
- When you trigger a triage, the **titles and URLs** of the selected tabs are sent directly from your browser to the AI provider you configured. Nothing else is sent. No page content is read.
- Notion export and Chrome sync are opt-in; the data only leaves your device when you turn them on or click the export button.
- We don't run any servers, don't collect telemetry, and don't have analytics.

Full policy: [privacy.html](https://shpwrck.github.io/Tab-Triage-AI/privacy.html).

## Support

Bug reports and feature requests: [jankoszy@gmail.com](mailto:jankoszy@gmail.com).
