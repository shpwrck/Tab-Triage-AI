import { buildUserMessage } from "./prompt.js";
import { LLMError, parseGroups } from "./errors.js";

const DEFAULT_BASE = "https://generativelanguage.googleapis.com/v1beta";

export async function triageGemini({ apiKey, model, tabs, baseUrl, systemPrompt }) {
  if (!apiKey) throw new LLMError("Missing API key.", { provider: "gemini" });
  const url = `${(baseUrl || DEFAULT_BASE).replace(/\/+$/, "")}/models/${encodeURIComponent(model)}:generateContent`;
  const body = {
    systemInstruction: { parts: [{ text: systemPrompt }] },
    contents: [{ role: "user", parts: [{ text: buildUserMessage(tabs) }] }],
    generationConfig: {
      responseMimeType: "application/json",
      temperature: 0.2,
    },
  };
  let res;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-goog-api-key": apiKey,
      },
      body: JSON.stringify(body),
    });
  } catch (e) {
    throw new LLMError(`Network error: ${e.message}`, { provider: "gemini", retryable: true });
  }
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new LLMError(`Gemini ${res.status}: ${text.slice(0, 300)}`, { provider: "gemini", status: res.status });
  }
  const data = await res.json();
  const text = data?.candidates?.[0]?.content?.parts?.[0]?.text ?? "";
  return parseGroups(text, "gemini");
}

export async function pingGemini({ apiKey, model, baseUrl }) {
  const url = `${(baseUrl || DEFAULT_BASE).replace(/\/+$/, "")}/models/${encodeURIComponent(model)}:generateContent`;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-goog-api-key": apiKey,
    },
    body: JSON.stringify({
      contents: [{ role: "user", parts: [{ text: "Reply with the single word: ok" }] }],
      generationConfig: { maxOutputTokens: 16 },
    }),
  });
  if (!res.ok) {
    const t = await res.text().catch(() => "");
    throw new LLMError(`Gemini ${res.status}: ${t.slice(0, 200)}`, { provider: "gemini", status: res.status });
  }
}
