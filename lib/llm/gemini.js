import { buildUserMessage } from "./prompt.js";
import { LLMError, parseGroups, providerNetworkError, readProviderError, readProviderJson } from "./errors.js";
import { finishReasonHitOutputLimit, outputTokenLimitForTabs } from "./limits.js";

const DEFAULT_BASE = "https://generativelanguage.googleapis.com/v1beta";

export async function triageGemini({ apiKey, model, tabs, baseUrl, systemPrompt }) {
  if (!apiKey) throw new LLMError("Missing API key.", { provider: "gemini" });
  const url = `${(baseUrl || DEFAULT_BASE).replace(/\/+$/, "")}/models/${encodeURIComponent(model)}:generateContent`;
  const body = {
    systemInstruction: { parts: [{ text: systemPrompt }] },
    contents: [{ role: "user", parts: [{ text: buildUserMessage(tabs) }] }],
    generationConfig: {
      maxOutputTokens: outputTokenLimitForTabs(tabs.length),
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
    throw providerNetworkError("gemini", e);
  }
  if (!res.ok) {
    throw await readProviderError(res, "gemini");
  }
  const data = await readProviderJson(res, "gemini");
  const candidate = data?.candidates?.[0];
  const text = Array.isArray(candidate?.content?.parts)
    ? candidate.content.parts.map(part => part?.text ?? "").join("")
    : "";
  return parseGroups(text, "gemini", {
    outputLimited: finishReasonHitOutputLimit("gemini", candidate?.finishReason),
    tabCount: tabs.length,
  });
}

export async function pingGemini({ apiKey, model, baseUrl }) {
  const url = `${(baseUrl || DEFAULT_BASE).replace(/\/+$/, "")}/models/${encodeURIComponent(model)}:generateContent`;
  let res;
  try {
    res = await fetch(url, {
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
  } catch (e) {
    throw providerNetworkError("gemini", e);
  }
  if (!res.ok) {
    throw await readProviderError(res, "gemini");
  }
}
