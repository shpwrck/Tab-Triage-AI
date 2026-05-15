# Chrome Web Store Listing — Tab Triage AI

Source of truth for everything that goes into the Chrome Web Store submission form. Edit before uploading; everything between `[brackets]` is a placeholder you should swap.

---

## Name (45 chars max)

```
Tab Triage AI
```

## Summary / short description (132 chars max — appears in search results)

```
Cluster open tabs by intent, summarize each cluster, and clean up stale & duplicate tabs. Bring your own Claude, GPT, or Gemini key.
```
*(128 chars)*

Alternates if the AI-provider angle feels too technical for search:
```
AI tab manager that clusters your tabs by intent, summarizes each group, and cleans up stale and duplicate tabs.
```
*(115 chars)*

```
Group, summarize, and clean up your tabs with AI. Works with Claude, GPT, or Gemini using your own API key.
```
*(110 chars)*

## Detailed description

```
Tab Triage AI groups your open tabs by what you're actually doing — research, buying decisions, rabbit holes — and writes a 3-bullet summary for each cluster so you can resume a project without re-opening 40 tabs to remember what's there.

Bring your own LLM key. The extension works with:
• Anthropic (Claude)
• OpenAI (GPT) and any OpenAI-compatible endpoint — OpenRouter, Groq, Together, Fireworks, Ollama, LM Studio, vLLM
• Google (Gemini)

Pick a provider in Settings, paste your key, and you're done. Your key stays on your device. There's no proxy, no analytics, no third-party server in the middle — the extension calls the provider's API directly from your browser.

Don't want to pay any provider? Sign up for OpenRouter (free, no card), grab a key, point the extension at https://openrouter.ai/api/v1, and pick any model with the :free suffix. Step-by-step is in Settings.

WHAT IT DOES

• Clusters by intent, not topic. "Refactor billing," "Laptop buying," "Hacker News dive" — distinctive labels that stay readable when Chrome collapses tab groups in the strip.
• Three-bullet summary per group: what you're doing, the key sources, a next step.
• Applies clusters as native Chrome tab groups with rotating colors in one click.
• Auto-triages new tabs in the background with debounce/throttle so it doesn't spam your API quota. Tunable; off by default.
• Archives a group as a saved session: closes the tabs, keeps the work. Restore later into a new window or the current one.
• Stale-tabs dashboard on the new tab page: tabs you haven't touched in 24h+ (configurable). Bulk archive or close. Optional auto-sleep frees memory via chrome.tabs.discard.
• Duplicate-tab cleanup: finds open tabs sharing a URL, keeps the most recently used copy, closes the rest in one click.
• Global fuzzy search (Cmd/Ctrl-Shift-K) across every open tab in every window AND your saved sessions.
• Custom grouping rules. A free-form Settings textarea lets you teach the AI your conventions ("Always separate work email from personal," "Group dev docs under one Docs label").
• Notion export. Send a triage result, a single group, or a saved session straight into a Notion page with date, tab count, and provider tagged in the metadata.
• Sync your saved sessions across every Chrome you're signed into, via Chrome's built-in sync (no server of ours involved).

PRICING

Free forever: 5 triages per week, 10 tabs per triage. Everything else is unlocked.

Lifetime: $9.99 one-time. Unlimited triages, no tab cap, Notion export, deep mode. No subscription, no renewals.

PRIVACY

• No analytics, no telemetry, no error reporting.
• No proxy. Your tab titles and URLs go from your browser straight to the API host you chose — we never see them.
• Your LLM key, your Notion token, your saved sessions: all in chrome.storage.local on your device.

KEYBOARD SHORTCUTS

• Cmd/Ctrl+Shift+Y — open the popup
• Cmd/Ctrl+Shift+U — triage the current window now
• Cmd/Ctrl+Shift+K — fuzzy search across tabs and saved sessions

---

Built by an independent developer. Bug reports and feature requests: jankoszy@gmail.com
```

## Category

**Productivity**

Tab Triage AI fits cleanly under Productivity. (Avoid "Workflow & Planning Tools" — the audience there is project-management-heavy.)

## Language

English

## Single-purpose description (required at submission)

```
Tab Triage AI clusters a user's open browser tabs into groups by intent, generates a short summary for each group using a large language model the user supplies the key for, and helps the user clean up stale and duplicate tabs. All AI calls go directly from the user's browser to the provider they selected; the extension does not operate any backend.
```

---

## Permission justifications

Chrome's submission form asks you to justify each permission individually. Paste these into the matching fields.

### `tabs`

```
Reads tab titles, URLs, and lastAccessed timestamps so the AI can cluster them, the dashboard can surface stale or duplicate tabs, and the user can switch to a tab via search. Closes tabs only when the user explicitly clicks Archive, Close all, or the per-tab × button.
```

### `tabGroups`

```
Creates and updates native Chrome tab groups with the AI-generated labels and rotating colors so the user's tab strip is visibly organized after a triage. The user can ungroup at any time via Chrome's normal tab-group UI.
```

### `storage`

```
Stores the user's LLM provider configuration, API key, saved sessions, settings, and the cache of the most recent triage so the new-tab dashboard can render without making another API call. Also stores the per-week free-tier quota counter.
```

### `windows`

```
Opens a new focused window when the user restores a saved session in "New window" mode, and brings the right window forward when the user clicks a tab in the global search results.
```

### `alarms`

```
Debounces auto-triage runs (so a burst of new-tab opens collapses into one API call) and refreshes the stale-tab toolbar badge on a 15-minute periodic alarm. Both alarms are required to survive Manifest V3 service worker eviction.
```

### `notifications`

```
Shows a system notification after a background auto-triage run summarizing how many tabs were grouped, and after the keyboard-shortcut "Triage now" command. The notification is the only way the user is told the background action completed.
```

### Host permissions (combined justification)

```
Each host the extension contacts is an LLM provider API that the user explicitly chose in Settings (Anthropic, OpenAI, Google Gemini, OpenRouter, Groq, Together, Fireworks), localhost/127.0.0.1 for users running local models (Ollama, LM Studio, vLLM), Notion's API for the optional Send-to-Notion feature, or ExtensionPay for license verification. All calls are made directly from the user's browser to the chosen host; the extension does not proxy through any server we operate.
```

### `<all_urls>` (optional host permission)

```
Reserved for a future opt-in "deep mode" that would extract visible page text to give the AI more context than the tab title alone. This permission is not granted at install time — it would be requested only when the user explicitly enables deep mode, and only for the duration they keep it enabled.
```

### `scripting` (optional permission)

```
Paired with the optional <all_urls> permission for the same future opt-in deep-mode feature, where a content script would extract visible page text. Not used today; granted only on explicit user request.
```

### Remote code use

**Are you using remote code?**

**No.** All JavaScript executed by the extension ships in the package. ExtensionPay's library is vendored locally as `lib/ExtPay.js`. No `eval`, no dynamically loaded scripts, no remote CDN imports.

### Data usage disclosures

When the form asks about each data type, the honest answers are:

| Data type | Collected? | Sent to | Sold? |
|---|---|---|---|
| Personally identifiable information | No | — | No |
| Health information | No | — | No |
| Financial / payment info | Only if user buys lifetime; handled by Stripe via ExtensionPay; we never see card details | Stripe (via ExtensionPay) | No |
| Authentication info (API keys) | Stored locally on user's device only; sent in API calls to the user-chosen provider | The LLM provider the user picked | No |
| Personal communications | No | — | No |
| Location | No | — | No |
| Web history | Tab titles and URLs are sent to the LLM provider only when the user triggers a triage | The LLM provider the user picked | No |
| User activity | No | — | No |
| Website content | No (we never read page text — only tab titles and URLs) | — | No |

**Confirm the three required certifications:**
- ✓ I do not use or transfer user data for purposes unrelated to my item's single purpose.
- ✓ I do not use or transfer user data to determine creditworthiness or for lending purposes.
- ✓ I do not sell user data to third parties.

---

## Listing assets you still need to capture

| Asset | Spec | What to show |
|---|---|---|
| Small promo tile | 440×280 PNG/JPG | Cover art with the medical-cross icon + product name on a clean background |
| Large promo tile (optional but bumps placement) | 920×680 PNG/JPG | Hero shot of the new-tab dashboard with grouped tabs visible |
| Marquee promo (optional, featured tier) | 1400×560 PNG/JPG | Skip until featured |
| Screenshot 1 (1280×800 or 640×400, PNG/JPG) | required | The popup after a triage: 3-4 groups, each with summary bullets and tab list. Pick a believable set of tabs that span different intents. |
| Screenshot 2 | required | The new-tab dashboard: stats row at top, latest-triage card, stale-tabs section visible |
| Screenshot 3 | required | The new-tab duplicates section with a "Close all duplicates · 5" button |
| Screenshot 4 | required | Chrome's tab strip after "Organize window" — colored tab groups with distinct labels |
| Screenshot 5 (optional) | recommended | Settings page showing the multi-provider picker — proves the BYOK story |

Shot list for screenshots:
1. **Have 12–20 real-looking tabs open** before capture. Mix work, shopping, articles, docs.
2. **Use the medical-red theme** as-is; don't customize.
3. **Bump browser zoom to 110–125%** so the screenshot UI looks legible at 1280×800.
4. **Hide other extension icons** in the toolbar before capture; right-click the toolbar → "Customize Toolbar" or just temporarily disable other extensions.
5. **The first screenshot is the most important** — that's the carousel hero. Make it the popup triage result with 3-4 good groups.

---

## Pre-flight checklist before clicking Submit

- [ ] Real support email in `manifest.json` author field
- [ ] `homepage_url` in `manifest.json` pointing at your landing page
- [ ] Privacy policy URL set in the submission form (host `docs/privacy.html` somewhere public)
- [ ] $9.99 price set on the ExtensionPay dashboard
- [ ] At least one successful test purchase ran end-to-end
- [ ] Run `./scripts/package.sh` and inspect the produced .zip — it should NOT contain `.git`, `docs/`, `scripts/`, `__pycache__`, the build_icons.py source, or any `*.zip` file
- [ ] Reload the unpacked extension from a clean clone to confirm nothing depends on dev-only files
- [ ] Sanity-check on a second profile (no leftover storage from your dev profile)
