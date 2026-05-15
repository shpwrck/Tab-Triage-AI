import { buildUserMessage } from "./prompt.js";
import { LLMError, parseGroups } from "./errors.js";

const DEFAULT_BASE = "https://api.anthropic.com";

export async function triageAnthropic({ apiKey, model, tabs, baseUrl, systemPrompt }) {
  if (!apiKey) throw new LLMError("Missing API key.", { provider: "anthropic" });
  const url = `${(baseUrl || DEFAULT_BASE).replace(/\/+$/, "")}/v1/messages`;
  const body = {
    model,
    max_tokens: 2048,
    system: systemPrompt,
    messages: [{ role: "user", content: buildUserMessage(tabs) }],
  };
  let res;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
        "anthropic-dangerous-direct-browser-access": "true",
      },
      body: JSON.stringify(body),
    });
  } catch (e) {
    throw new LLMError(`Network error reaching Anthropic: ${e.message}`, { provider: "anthropic", retryable: true });
  }
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new LLMError(`Anthropic ${res.status}: ${text.slice(0, 300)}`, { provider: "anthropic", status: res.status });
  }
  const data = await res.json();
  const text = data?.content?.[0]?.text ?? "";
  return parseGroups(text, "anthropic");
}

export async function pingAnthropic({ apiKey, model, baseUrl }) {
  const url = `${(baseUrl || DEFAULT_BASE).replace(/\/+$/, "")}/v1/messages`;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
      "anthropic-dangerous-direct-browser-access": "true",
    },
    body: JSON.stringify({
      model,
      max_tokens: 16,
      messages: [{ role: "user", content: "Reply with the single word: ok" }],
    }),
  });
  if (!res.ok) {
    const t = await res.text().catch(() => "");
    throw new LLMError(`Anthropic ${res.status}: ${t.slice(0, 200)}`, { provider: "anthropic", status: res.status });
  }
}
