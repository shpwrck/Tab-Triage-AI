// Provider-agnostic triage entry point.
//
// settings.llm = {
//   provider: "anthropic" | "openai" | "gemini",
//   apiKey: "...",
//   model: "model-id",
//   baseUrl: "" | "https://your-proxy/v1"     // optional for providers that support custom endpoints
// }

import { LLMError } from "./errors.js";
import { buildSystemPrompt } from "./prompt.js";
import { triageAnthropic, pingAnthropic } from "./anthropic.js";
import { triageOpenAI, pingOpenAI } from "./openai.js";
import { triageGemini, pingGemini } from "./gemini.js";
import { largeTriageMessage, MAX_TABS_PER_LLM_TRIAGE } from "./limits.js";

export { LLMError } from "./errors.js";

export const PROVIDERS = {
  anthropic: {
    label: "Anthropic (Claude)",
    keyPrefix: "sk-ant-",
    keyPlaceholder: "sk-ant-...",
    defaultModel: "claude-haiku-4-5-20251001",
    modelHelp: "Defaults to Claude Haiku. Override only if you want a different Claude model.",
    supportsBaseUrl: true,
    baseUrlPlaceholder: "https://api.anthropic.com",
    baseUrlHelp: "Advanced: only set this for an Anthropic-compatible proxy. Leave blank for Anthropic.",
    keyHelp: "Get a key at https://console.anthropic.com/settings/keys",
  },
  openai: {
    label: "OpenAI-compatible",
    keyPrefix: "",
    keyPlaceholder: "sk-...",
    defaultModel: "gpt-4o-mini",
    modelHelp: "Defaults to gpt-4o-mini. Use the exact model name from your OpenAI-compatible provider.",
    supportsBaseUrl: true,
    baseUrlPlaceholder: "https://openrouter.ai/api/v1",
    baseUrlHelp: "For OpenAI-compatible servers (OpenRouter, Groq, Together, Ollama, LM Studio). Leave blank for OpenAI proper.",
    keyHelp: "Works with OpenAI, OpenRouter, Groq, Together, Fireworks, Ollama (compat mode), LM Studio, vLLM. For non-OpenAI providers, set a Base URL like https://openrouter.ai/api/v1. Want free? See \"Free AI model via OpenRouter\" below.",
  },
  gemini: {
    label: "Google (Gemini)",
    keyPrefix: "",
    keyPlaceholder: "AIza...",
    defaultModel: "gemini-2.0-flash",
    modelHelp: "Defaults to Gemini Flash. Override only if you want a different Gemini model.",
    supportsBaseUrl: false,
    baseUrlPlaceholder: "",
    baseUrlHelp: "",
    keyHelp: "Get a key at https://aistudio.google.com/app/apikey",
  },
};

function cleanText(value) {
  return String(value ?? "").trim();
}

export function normalizeLlmSettings(llm) {
  const source = llm ?? {};
  const provider = source.provider;
  const config = PROVIDERS[provider];
  return {
    ...source,
    model: cleanText(source.model) || config?.defaultModel || "",
    baseUrl: config?.supportsBaseUrl ? cleanText(source.baseUrl) : "",
  };
}

export async function triageTabs({ settings, tabs }) {
  if (!tabs?.length) throw new LLMError("No tabs to triage.");
  const llm = normalizeLlmSettings(settings?.llm);
  if (!llm || !llm.provider) throw new LLMError("No AI provider configured. Open Settings to choose one.");
  if (!llm.apiKey) throw new LLMError("Missing API key. Add one in Settings.");
  const model = llm.model;
  if (!model) throw new LLMError(`Unknown AI provider: ${llm.provider}`);
  if (tabs.length > MAX_TABS_PER_LLM_TRIAGE) {
    throw new LLMError(largeTriageMessage(tabs.length), {
      provider: llm.provider,
      retryable: true,
      code: "triage_too_large",
    });
  }

  const systemPrompt = buildSystemPrompt(llm.customInstructions);
  const args = {
    apiKey: llm.apiKey,
    model,
    tabs,
    baseUrl: llm.baseUrl || undefined,
    systemPrompt,
  };
  switch (llm.provider) {
    case "anthropic": return triageAnthropic(args);
    case "openai":    return triageOpenAI(args);
    case "gemini":    return triageGemini(args);
    default:          throw new LLMError(`Unknown AI provider: ${llm.provider}`);
  }
}

export async function pingProvider({ settings }) {
  const llm = normalizeLlmSettings(settings?.llm);
  if (!llm?.provider) throw new LLMError("No AI provider configured.");
  if (!llm.apiKey) throw new LLMError("Missing API key.");
  const model = llm.model;
  const args = { apiKey: llm.apiKey, model, baseUrl: llm.baseUrl || undefined };
  switch (llm.provider) {
    case "anthropic": return pingAnthropic(args);
    case "openai":    return pingOpenAI(args);
    case "gemini":    return pingGemini(args);
    default:          throw new LLMError(`Unknown AI provider: ${llm.provider}`);
  }
}
