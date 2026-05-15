// Works with OpenAI, OpenRouter, Groq, Together, Fireworks, Ollama (in
// OpenAI-compat mode), LM Studio, vLLM — anything that speaks the
// /v1/chat/completions wire format.

import { buildUserMessage } from "./prompt.js";
import { LLMError, parseGroups } from "./errors.js";

const DEFAULT_BASE = "https://api.openai.com/v1";

export async function triageOpenAI({ apiKey, model, tabs, baseUrl, systemPrompt }) {
  if (!apiKey) throw new LLMError("Missing API key.", { provider: "openai" });
  const url = `${(baseUrl || DEFAULT_BASE).replace(/\/+$/, "")}/chat/completions`;
  const body = {
    model,
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user", content: buildUserMessage(tabs) },
    ],
    // Most modern OpenAI-compatible servers accept this. Servers that
    // don't will simply ignore it; the prompt also asks for JSON, so the
    // parse step still works.
    response_format: { type: "json_object" },
    temperature: 0.2,
  };
  let res;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify(body),
    });
  } catch (e) {
    throw new LLMError(`Network error: ${e.message}`, { provider: "openai", retryable: true });
  }
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new LLMError(`OpenAI ${res.status}: ${text.slice(0, 300)}`, { provider: "openai", status: res.status });
  }
  const data = await res.json();
  const text = data?.choices?.[0]?.message?.content ?? "";
  return parseGroups(text, "openai");
}

export async function pingOpenAI({ apiKey, model, baseUrl }) {
  const url = `${(baseUrl || DEFAULT_BASE).replace(/\/+$/, "")}/chat/completions`;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model,
      max_tokens: 16,
      messages: [{ role: "user", content: "Reply with the single word: ok" }],
    }),
  });
  if (!res.ok) {
    const t = await res.text().catch(() => "");
    throw new LLMError(`Server ${res.status}: ${t.slice(0, 200)}`, { provider: "openai", status: res.status });
  }
}
