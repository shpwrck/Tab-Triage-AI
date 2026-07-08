# Privacy Policy — Tab Triage AI

**Effective date:** 2026-05-15

Tab Triage AI ("the extension") is a Chrome extension that groups your open tabs by intent, summarizes each group, and surfaces stale and duplicate tabs for cleanup. It is published by **Tab Triage AI** ("we"). This policy explains what data the extension handles, where it goes, and what stays on your device.

## Short version

- The extension does **not** operate any backend or proxy. We do not run servers that handle your data.
- It does **not** collect analytics, telemetry, error reports, or any usage data of any kind.
- Your AI provider API key, your settings, your saved sessions, your Notion integration token, and the cache of recent triage results live in your own browser's local storage.
- When you actively trigger a triage, the **titles and URLs** of the tabs you select are sent **directly from your browser** to the AI provider you configured (Anthropic, OpenAI, Google, or an OpenAI-compatible endpoint of your choice). Nothing else is sent.
- When you actively click "Send to Notion," the contents of that session or triage are sent **directly from your browser** to Notion using the integration token you configured. Nothing is sent to Notion unless you click the button.
- When you opt in to cross-device sync, your saved sessions are mirrored through Chrome's built-in `chrome.storage.sync` channel (the same channel that syncs bookmarks and history). We never see this data; it travels between your Chromes via Google.
- When you purchase a lifetime license, payment is processed by ExtensionPay and Stripe; we receive only the confirmation that you paid. We do not receive your card details.

## What the extension stores on your device

The following live in `chrome.storage.local` (your browser, this device):

| Data | Why it exists |
|---|---|
| AI provider, model, API key, optional base URL, optional custom grouping rules | Required to run triages |
| Notion integration token + parent page URL or ID (only if you set them up) | Required for "Send to Notion" |
| Saved sessions (titles, URLs, group labels, summaries, optional notes) | The session list you can restore from |
| Most recent triage cache (groups + tab titles/URLs + timestamp) | Powers the new-tab dashboard without calling the AI provider again |
| Settings: auto-triage thresholds, badge config, sleep config, sync toggle | Your preferences |
| Free-tier quota counter (current week's triage count) | Enforces the 5-triages-per-week free limit |

You can clear all of this by uninstalling the extension or by clicking "Clear all data" in `chrome://extensions` → Tab Triage AI → "Site data."

## What leaves your device, when, and to whom

### AI provider (Anthropic, OpenAI / OpenAI-compatible, Google)

Triggered by: clicking "Triage tabs," clicking "Triage now," or auto-triage firing in the background while enabled.

Sent: a JSON array containing the `title`, `url`, and `id` of each selected tab; plus your saved system prompt (which may include your custom grouping rules, if you set any). Tab content (page text) is **not** read or sent — only titles and URLs.

Destination: the host you chose. The default endpoints are:
- Anthropic: `https://api.anthropic.com`
- OpenAI: `https://api.openai.com`
- Google: `https://generativelanguage.googleapis.com`
- Or whatever Base URL you supply for an OpenAI-compatible provider (OpenRouter, Groq, Together, Fireworks, a local Ollama or LM Studio, etc.)

Authentication: the API key you pasted into Settings, sent in the standard provider header (`x-api-key`, `Authorization: Bearer`, or `x-goog-api-key`).

We do not route any of this through any server we operate.

### Notion (only if you configured it)

Triggered by: clicking "Send to Notion" on a triage result, a single group, or a saved session.

Sent: the session/group's title, group labels, summary bullets, tab titles, tab URLs, optional notes, and a small metadata line (date, tab count, group count, provider name).

Destination: `https://api.notion.com`.

Authentication: the Notion integration token you pasted into Settings.

### ExtensionPay (payments only)

Triggered by: clicking "Buy lifetime access."

Sent: the standard ExtensionPay flow, which processes the purchase via Stripe. We receive the boolean fact that your purchase succeeded, and a randomly generated user identifier so the extension can recognize you on other devices via the same ExtensionPay account. We do not see, store, or receive your card number, billing address, or any other payment details — those stay with Stripe.

See [ExtensionPay's privacy policy](https://extensionpay.com/privacy) and [Stripe's privacy policy](https://stripe.com/privacy) for details on those processors.

### Chrome sync (only if you opt in)

Triggered by: enabling "Sync saved sessions" in Settings.

Sent: each saved session as a separate item to `chrome.storage.sync`. This is Google's sync infrastructure — the same channel that syncs your bookmarks, history, and other extension preferences. We have no access to this data, no server in the path. When you disable sync, the extension clears its sync items.

## Permissions and why they are requested

| Permission | Purpose |
|---|---|
| `tabs` | Read tab titles, URLs, and last-accessed timestamps; switch to a tab when you click a search result; close tabs you ask to be closed |
| `tabGroups` | Create native Chrome tab groups with the AI's labels |
| `storage` | Persist your settings, API keys, saved sessions, and cache locally |
| `windows` | Open a new window when you restore a session into one; focus windows when switching tabs |
| `alarms` | Debounce auto-triage runs and refresh the toolbar badge on a schedule |
| `notifications` | Show "Grouped N tabs" notifications after an auto-triage run |
| `host_permissions` for `api.anthropic.com`, `api.openai.com`, `generativelanguage.googleapis.com`, `openrouter.ai`, `api.groq.com`, `api.together.xyz`, `api.fireworks.ai`, `localhost`, `127.0.0.1`, `api.notion.com`, `extensionpay.com` | Direct browser-to-provider API calls; no proxy in between |
| Content script on `extensionpay.com` | Detect successful payment so your lifetime status activates immediately |

## What we do not do

- We do not sell, share, or transfer any user data to anyone.
- We do not use any data for advertising, profiling, or any purpose other than performing the function you triggered.
- We do not collect analytics, error reports, crash logs, usage metrics, or any telemetry.
- We do not run servers, databases, queues, or any backend that touches your data.
- We do not contact you unless you email us first.

## Children

The extension is not directed at children under 13 and we do not knowingly collect data from them.

## Your rights

Because we don't operate any servers that hold your data, there is nothing for us to delete on your behalf. If you want to wipe everything the extension has stored:

1. Open `chrome://extensions`, find Tab Triage AI, click **Details**, then scroll to **Extension options** to inspect what's stored.
2. To remove the extension and all its data: click **Remove** on the extension card.
3. If you enabled cross-device sync, Chrome will also remove the synced items when you disable sync or remove the extension on every signed-in Chrome.

To request information about ExtensionPay/Stripe processing of your payment, contact ExtensionPay support directly. To delete the Notion content you exported, delete those pages from your Notion workspace.

## Changes to this policy

If we change this policy, the new version will be posted at the same URL with an updated effective date.

## Contact

Questions? Reach out to **jankoszy@gmail.com**.
