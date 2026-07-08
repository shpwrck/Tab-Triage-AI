import assert from "node:assert/strict";

import {
  LLMError,
  parseGroups,
  providerNetworkError,
  providerStatusError,
  withLlmRetry,
} from "../lib/llm/errors.js";
import { pingProvider } from "../lib/llm/index.js";

const invalidKey = providerStatusError(
  "openai",
  401,
  '{"error":{"message":"Incorrect API key provided: sk-secret"}}',
);
assert(invalidKey instanceof LLMError);
assert.equal(invalidKey.code, "auth");
assert.equal(invalidKey.retryable, false);
assert.match(invalidKey.message, /rejected the API key/);
assert.doesNotMatch(invalidKey.message, /sk-secret|Incorrect API key/);
assert.match(invalidKey.details, /Incorrect API key provided/);

const rateLimit = providerStatusError(
  "anthropic",
  429,
  '{"error":{"message":"rate_limit_error: quota exhausted"}}',
);
assert.equal(rateLimit.code, "rate_limit");
assert.equal(rateLimit.retryable, true);
assert.match(rateLimit.message, /rate limiting|quota/);
assert.match(rateLimit.message, /try again/i);
assert.doesNotMatch(rateLimit.message, /rate_limit_error/);
assert.match(rateLimit.details, /quota exhausted/);

const outage = providerStatusError("gemini", 503, "backend unavailable");
assert.equal(outage.code, "provider_unavailable");
assert.equal(outage.retryable, true);
assert.match(outage.message, /having trouble/);

assert.throws(
  () => parseGroups("not json", "gemini"),
  err => {
    assert(err instanceof LLMError);
    assert.equal(err.code, "bad_model_output");
    assert.equal(err.retryable, true);
    assert.match(err.message, /could not read/);
    assert.doesNotMatch(err.message, /not json/);
    assert.match(err.details, /not json/);
    return true;
  },
);

let networkAttempts = 0;
await assert.rejects(
  withLlmRetry(
    async () => {
      networkAttempts += 1;
      throw providerNetworkError("openai", new Error("Failed to fetch"));
    },
    { attempts: 2, delayMs: 0 },
  ),
  err => {
    assert(err instanceof LLMError);
    assert.equal(err.code, "network");
    assert.match(err.details, /Retried 1 time/);
    return true;
  },
);
assert.equal(networkAttempts, 2);

let rateLimitAttempts = 0;
await assert.rejects(
  withLlmRetry(
    async () => {
      rateLimitAttempts += 1;
      throw providerStatusError("openai", 429, "too many requests");
    },
    { attempts: 3, delayMs: 0 },
  ),
);
assert.equal(rateLimitAttempts, 1);

let recoveryAttempts = 0;
const recovered = await withLlmRetry(
  async () => {
    recoveryAttempts += 1;
    if (recoveryAttempts === 1) {
      throw providerStatusError("anthropic", 503, "temporary outage");
    }
    return "ok";
  },
  { attempts: 2, delayMs: 0 },
);
assert.equal(recovered, "ok");
assert.equal(recoveryAttempts, 2);

const originalFetch = globalThis.fetch;
try {
  let pingOutageAttempts = 0;
  globalThis.fetch = async () => {
    pingOutageAttempts += 1;
    return new Response('{"error":{"message":"backend down"}}', { status: 503 });
  };
  await assert.rejects(
    pingProvider({
      settings: {
        llm: {
          provider: "openai",
          apiKey: "sk-test",
          model: "gpt-test",
        },
      },
    }),
    err => {
      assert(err instanceof LLMError);
      assert.equal(err.code, "provider_unavailable");
      assert.match(err.message, /having trouble/);
      assert.match(err.details, /Retried 1 time/);
      return true;
    },
  );
  assert.equal(pingOutageAttempts, 2);

  let pingAuthAttempts = 0;
  globalThis.fetch = async () => {
    pingAuthAttempts += 1;
    return new Response('{"error":{"message":"bad key sk-test"}}', { status: 401 });
  };
  await assert.rejects(
    pingProvider({
      settings: {
        llm: {
          provider: "openai",
          apiKey: "sk-test",
          model: "gpt-test",
        },
      },
    }),
    err => {
      assert(err instanceof LLMError);
      assert.equal(err.code, "auth");
      assert.doesNotMatch(err.message, /sk-test/);
      assert.match(err.details, /bad key sk-test/);
      return true;
    },
  );
  assert.equal(pingAuthAttempts, 1);
} finally {
  globalThis.fetch = originalFetch;
}

console.log("LLM error mapping assertions passed.");
