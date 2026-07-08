export const MAX_TABS_PER_LLM_TRIAGE = 120;

export function largeTriageMessage(tabCount, limit = MAX_TABS_PER_LLM_TRIAGE) {
  return `This triage has ${tabCount} tabs. Send up to ${limit} tabs at once so the AI can return a complete grouping. Select fewer tabs or split this window, then try again.`;
}

export function outputLimitMessage(provider, tabCount = 0) {
  const providerLabel = providerLabelForMessage(provider);
  const scope = Number.isFinite(tabCount) && tabCount > 0
    ? ` while triaging ${tabCount} tabs`
    : "";
  return `The ${providerLabel} response was cut off${scope} before it finished. Select fewer tabs or split this window, then try again.`;
}

export function outputTokenLimitForTabs(tabCount) {
  const count = Number.isFinite(tabCount) ? Math.max(0, tabCount) : 0;
  if (count <= 40) return 2048;
  if (count <= 80) return 3072;
  return 4096;
}

export function finishReasonHitOutputLimit(provider, reason) {
  const normalized = String(reason ?? "").trim().toLowerCase();
  if (!normalized) return false;
  if (provider === "anthropic") return normalized === "max_tokens";
  if (provider === "openai") return normalized === "length";
  if (provider === "gemini") return normalized === "max_tokens";
  return normalized === "max_tokens" || normalized === "length";
}

export function looksLikeTruncatedJson(text) {
  const source = String(text ?? "").trim();
  if (!source) return false;
  const start = source.search(/[\{\[]/);
  if (start === -1) return false;

  const stack = [];
  let inString = false;
  let escaped = false;
  for (const ch of source.slice(start)) {
    if (escaped) {
      escaped = false;
      continue;
    }
    if (ch === "\\") {
      escaped = inString;
      continue;
    }
    if (ch === "\"") {
      inString = !inString;
      continue;
    }
    if (inString) continue;
    if (ch === "{" || ch === "[") {
      stack.push(ch);
      continue;
    }
    if (ch === "}" || ch === "]") {
      const opener = stack.pop();
      if ((ch === "}" && opener !== "{") || (ch === "]" && opener !== "[")) {
        return false;
      }
    }
  }

  return inString || stack.length > 0;
}

function providerLabelForMessage(provider) {
  switch (provider) {
    case "anthropic": return "Anthropic";
    case "openai": return "OpenAI-compatible";
    case "gemini": return "Gemini";
    default: return "AI";
  }
}
