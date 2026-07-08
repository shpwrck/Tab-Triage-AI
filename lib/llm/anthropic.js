import { buildUserMessage } from "./prompt.js";
import { LLMError, parseGroups, providerNetworkError, readProviderError, readProviderJson } from "./errors.js";
import { finishReasonHitOutputLimit, outputTokenLimitForTabs } from "./limits.js";

const DEFAULT_BASE = "https://api.anthropic.com";

export async function triageAnthropic({ apiKey, model, tabs, baseUrl, systemPrompt }) {
  if (!apiKey) throw new LLMError("Missing API key.", { provider: "anthropic" });
  const url = `${(baseUrl || DEFAULT_BASE).replace(/\/+$/, "")}/v1/messages`;
  const body = {
    model,
    max_tokens: outputTokenLimitForTabs(tabs.length),
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
    throw providerNetworkError("anthropic", e);
  }
  if (!res.ok) {
    throw await readProviderError(res, "anthropic");
  }
  const data = await readProviderJson(res, "anthropic");
  const text = Array.isArray(data?.content)
    ? data.content.filter(part => part?.type === "text").map(part => part.text ?? "").join("")
    : "";
  return parseGroups(text, "anthropic", {
    outputLimited: finishReasonHitOutputLimit("anthropic", data?.stop_reason),
    tabCount: tabs.length,
  });
}

export async function pingAnthropic({ apiKey, model, baseUrl }) {
  const url = `${(baseUrl || DEFAULT_BASE).replace(/\/+$/, "")}/v1/messages`;
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
      body: JSON.stringify({
        model,
        max_tokens: 16,
        messages: [{ role: "user", content: "Reply with the single word: ok" }],
      }),
    });
  } catch (e) {
    throw providerNetworkError("anthropic", e);
  }
  if (!res.ok) {
    throw await readProviderError(res, "anthropic");
  }
}
