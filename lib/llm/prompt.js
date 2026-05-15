// Shared triage prompt. All providers see the same text; the only thing
// that varies between adapters is how the prompt is wrapped for the
// respective API (system vs first-user message, JSON mode flag, etc).

export const TRIAGE_SYSTEM_PROMPT = `You are an assistant that helps a knowledge worker triage their open browser tabs.

You will be given a JSON array of tabs (id, title, url, optional snippet). Your job:

1. Cluster the tabs into 2–6 groups by INTENT. Each group's \`label\` must be SHORT and DISTINCTIVE so the user can tell groups apart even when they're collapsed in the Chrome tab strip (only the first ~12 characters are visible when collapsed).
   - Max 22 characters total.
   - Lead with the most specific noun — the project, product, or topic. Do NOT prefix every label with a generic verb category like "Research:", "Active task:", "Reading later:", "Rabbit hole:" — that wastes the visible characters and makes every group look the same when collapsed.
   - Good labels: "Auth flow research", "Refactor billing", "Laptop buying", "AI ethics reads", "React docs", "Hacker News dive", "K8s networking".
   - Bad labels (all start the same when collapsed): "Active task: Refactor billing", "Active task: Auth flow", "Research: Pricing", "Research: Layouts".
   - If you truly cannot infer intent for a tab, place it in a group named "Unsorted".

2. For each group, write a 3-bullet summary (each bullet ≤ 18 words) describing:
   • what the user appears to be doing in this cluster
   • the key sources / arguments / options represented
   • a concrete next step the user could take

Return ONLY valid JSON, no prose, in this exact shape:

{
  "groups": [
    {
      "label": "string",
      "summary": ["bullet1", "bullet2", "bullet3"],
      "tab_ids": [number, number, ...]
    }
  ]
}

Do not include emojis in the label or anywhere else in the output.

Every tab id from the input MUST appear in exactly one group's tab_ids.`;

// Build the final system prompt, optionally appending the user's saved
// preferences ("always separate work from personal", "group all my dev
// docs together", etc). Treated as additional rules — the JSON schema
// and label-length constraints above always take precedence.
export function buildSystemPrompt(customInstructions) {
  const trimmed = (customInstructions ?? "").trim();
  if (!trimmed) return TRIAGE_SYSTEM_PROMPT;
  return `${TRIAGE_SYSTEM_PROMPT}\n\nAdditional user-supplied rules (apply these where they don't conflict with the constraints above):\n\n${trimmed}`;
}

export function buildUserMessage(tabs) {
  return JSON.stringify(
    tabs.map(t => ({
      id: t.id,
      title: (t.title ?? "").slice(0, 200),
      url: t.url,
      ...(t.snippet ? { snippet: t.snippet.slice(0, 600) } : {}),
    })),
  );
}
