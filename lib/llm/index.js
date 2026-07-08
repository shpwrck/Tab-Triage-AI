// Provider-agnostic triage entry point.
//
// settings.llm = {
//   provider: "anthropic" | "openai" | "gemini",
//   apiKey: "...",
//   model: "model-id",
//   baseUrl: "" | "https://your-proxy/v1"     // optional, openai/anthropic only
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
    defaultModel: "claude-haiku-4-5-20251001",
    supportsBaseUrl: true,
    keyHelp: "Get a key at https://console.anthropic.com/settings/keys",
  },
  openai: {
    label: "OpenAI-compatible",
    keyPrefix: "",
    defaultModel: "gpt-4o-mini",
    supportsBaseUrl: true,
    keyHelp: "Works with OpenAI, OpenRouter, Groq, Together, Fireworks, Ollama (compat mode), LM Studio, vLLM. For non-OpenAI providers, set a Base URL like https://openrouter.ai/api/v1. Want free? See \"Free LLM via OpenRouter\" below.",
  },
  gemini: {
    label: "Google (Gemini)",
    keyPrefix: "",
    defaultModel: "gemini-2.0-flash",
    supportsBaseUrl: false,
    keyHelp: "Get a key at https://aistudio.google.com/app/apikey",
  },
};

export async function triageTabs({ settings, tabs }) {
  if (!tabs?.length) throw new LLMError("No tabs to triage.");
  const llm = settings?.llm;
  if (!llm || !llm.provider) throw new LLMError("No LLM provider configured. Open Settings to choose one.");
  if (!llm.apiKey) throw new LLMError("Missing API key. Add one in Settings.");
  const model = llm.model || PROVIDERS[llm.provider]?.defaultModel;
  if (!model) throw new LLMError(`Unknown provider: ${llm.provider}`);
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
    default:          throw new LLMError(`Unknown provider: ${llm.provider}`);
  }
}

export async function pingProvider({ settings }) {
  const llm = settings?.llm;
  if (!llm?.provider) throw new LLMError("No provider configured.");
  if (!llm.apiKey) throw new LLMError("Missing API key.");
  const model = llm.model || PROVIDERS[llm.provider]?.defaultModel;
  const args = { apiKey: llm.apiKey, model, baseUrl: llm.baseUrl || undefined };
  switch (llm.provider) {
    case "anthropic": return pingAnthropic(args);
    case "openai":    return pingOpenAI(args);
    case "gemini":    return pingGemini(args);
    default:          throw new LLMError(`Unknown provider: ${llm.provider}`);
  }
}
