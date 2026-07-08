import { looksLikeTruncatedJson, outputLimitMessage } from "./limits.js";

export class LLMError extends Error {
  constructor(message, { status = 0, provider = "", retryable = false, code = "", details = "" } = {}) {
    super(message);
    this.name = "LLMError";
    this.status = status;
    this.provider = provider;
    this.retryable = retryable;
    this.code = code;
    this.details = details;
  }
}

const PROVIDER_LABELS = {
  anthropic: "Anthropic",
  openai: "OpenAI-compatible provider",
  gemini: "Gemini",
};

const AUTO_RETRY_CODES = new Set(["network", "provider_unavailable", "request_timeout"]);

export function providerLabel(provider) {
  return PROVIDER_LABELS[provider] || "AI provider";
}

function cleanSnippet(value, maxLength = 700) {
  return String(value ?? "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, maxLength);
}

function providerBodyMessage(body) {
  const text = String(body ?? "").trim();
  if (!text) return "";
  try {
    const parsed = JSON.parse(text);
    return cleanSnippet(
      parsed?.error?.message
        ?? parsed?.error?.status
        ?? parsed?.message
        ?? parsed?.detail
        ?? parsed?.error_description
        ?? "",
    );
  } catch {
    return cleanSnippet(text);
  }
}

function technicalDetails({ provider, status = 0, body = "", cause = null, note = "" } = {}) {
  const lines = [];
  if (provider) lines.push(`Provider: ${providerLabel(provider)}`);
  if (status) lines.push(`HTTP status: ${status}`);
  if (note) lines.push(note);
  if (cause) lines.push(`Error: ${cause.message ?? String(cause)}`);
  const providerMessage = providerBodyMessage(body);
  if (providerMessage) lines.push(`Provider detail: ${providerMessage}`);
  return lines.join("\n");
}

export function providerNetworkError(provider, cause) {
  const label = providerLabel(provider);
  return new LLMError(
    `Could not reach ${label}. Check your internet connection, provider base URL, VPN/firewall, then try again.`,
    {
      provider,
      retryable: true,
      code: "network",
      details: technicalDetails({ provider, cause }),
    },
  );
}

export function providerStatusError(provider, status, body = "") {
  const label = providerLabel(provider);
  let message = `${label} returned HTTP ${status}. Check the provider settings and try again.`;
  let code = "provider_error";
  let retryable = false;

  if (status === 401 || status === 403) {
    code = "auth";
    message = `${label} rejected the API key or model access. Check the key in Settings, then make sure it can use the selected model.`;
  } else if (status === 429) {
    code = "rate_limit";
    retryable = true;
    message = `${label} is rate limiting this request or the account is out of quota. Wait a minute, then try again or check provider billing/quota.`;
  } else if (status === 408 || status === 409 || status === 425) {
    code = "request_timeout";
    retryable = true;
    message = `${label} did not finish the request. Try again in a moment.`;
  } else if (status >= 500) {
    code = "provider_unavailable";
    retryable = true;
    message = `${label} is having trouble right now. Try again in a moment.`;
  } else if (status === 400 || status === 404) {
    code = "bad_request";
    message = `${label} could not run the selected model. Check the model name and provider/base URL in Settings.`;
  }

  return new LLMError(message, {
    provider,
    status,
    retryable,
    code,
    details: technicalDetails({ provider, status, body }),
  });
}

export async function readProviderJson(res, provider) {
  const text = await res.text().catch(e => {
    throw providerNetworkError(provider, e);
  });
  try {
    return JSON.parse(text);
  } catch {
    throw providerMalformedOutputError(provider, text, "Provider returned invalid JSON in the HTTP response.");
  }
}

export async function readProviderError(res, provider) {
  const text = await res.text().catch(() => "");
  return providerStatusError(provider, res.status, text);
}

export function providerMalformedOutputError(provider, text, note = "Model output was not valid triage JSON.") {
  const label = providerLabel(provider);
  return new LLMError(
    `${label} returned an answer Tab Triage AI could not read. Try again; if it keeps happening, choose a model that supports JSON output.`,
    {
      provider,
      retryable: true,
      code: "bad_model_output",
      details: technicalDetails({ provider, body: text, note }),
    },
  );
}

export function shouldAutoRetryProviderError(error) {
  return error instanceof LLMError
    && error.retryable
    && AUTO_RETRY_CODES.has(error.code);
}

export async function withLlmRetry(operation, { attempts = 2, delayMs = 500 } = {}) {
  let retryCount = 0;
  let lastError;
  const maxAttempts = Math.max(1, attempts);

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      return await operation();
    } catch (e) {
      lastError = e;
      if (attempt >= maxAttempts || !shouldAutoRetryProviderError(e)) {
        if (retryCount && e instanceof LLMError) {
          e.details = [e.details, `Retried ${retryCount} time${retryCount === 1 ? "" : "s"} before showing this error.`]
            .filter(Boolean)
            .join("\n\n");
        }
        throw e;
      }
      retryCount += 1;
      if (delayMs > 0) {
        await new Promise(resolve => setTimeout(resolve, delayMs * retryCount));
      }
    }
  }

  throw lastError;
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
    throw providerMalformedOutputError(provider, jsonText);
  }
  if (!Array.isArray(parsed?.groups)) {
    throw providerMalformedOutputError(provider, jsonText, "Model output did not include a groups array.");
  }
  return parsed.groups;
}
