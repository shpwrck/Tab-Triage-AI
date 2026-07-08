import { looksLikeTruncatedJson, outputLimitMessage } from "./limits.js";

export class LLMError extends Error {
  constructor(message, { status = 0, provider = "", retryable = false, code = "" } = {}) {
    super(message);
    this.name = "LLMError";
    this.status = status;
    this.provider = provider;
    this.retryable = retryable;
    this.code = code;
  }
}

// Extract a JSON object from arbitrary model text. Models sometimes
// preface JSON with a sentence or wrap it in ```json fences — strip that
// out before parsing.
export function extractJson(text) {
  if (!text) return text;
  // Trim ```json ... ``` fences if present.
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fence) return fence[1].trim();
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end === -1) return text;
  return text.slice(start, end + 1);
}

export function outputLimitError(provider, tabCount) {
  return new LLMError(outputLimitMessage(provider, tabCount), {
    provider,
    retryable: true,
    code: "output_limit",
  });
}

export function parseGroups(text, provider, { outputLimited = false, tabCount = 0 } = {}) {
  const jsonText = extractJson(text);
  if (outputLimited || looksLikeTruncatedJson(jsonText)) {
    throw outputLimitError(provider, tabCount);
  }

  let parsed;
  try {
    parsed = JSON.parse(jsonText);
  } catch {
    if (looksLikeTruncatedJson(jsonText)) {
      throw outputLimitError(provider, tabCount);
    }
    throw new LLMError(`Could not parse ${provider} response as JSON.`, { provider });
  }
  if (!Array.isArray(parsed?.groups)) {
    throw new LLMError(`${provider} response missing "groups" array.`, { provider });
  }
  return parsed.groups;
}
