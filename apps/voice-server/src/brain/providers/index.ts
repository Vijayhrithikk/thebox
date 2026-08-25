import { env } from "../../config.js";
import { AnthropicProvider } from "./anthropic.js";
import { DeepSeekProvider } from "./deepseek.js";
import type { LLMProvider } from "./types.js";

export type { LLMProvider } from "./types.js";

/**
 * Fails loudly the moment something actually tries to use the brain, rather
 * than at module-load time — that's what keeps standalone diagnostics
 * (say.ts, and anything else that only touches TTS/ASR) from being blocked
 * by a provider key they never call. server.ts calls this once at startup
 * so a live server still fails at boot, not three seconds into a call.
 */
export function assertProviderConfigured(): void {
  if (env.LLM_PROVIDER === "anthropic" && !env.ANTHROPIC_API_KEY) {
    throw new Error("ANTHROPIC_API_KEY is required when LLM_PROVIDER=anthropic — see docs/SETUP.md");
  }
  if (env.LLM_PROVIDER === "deepseek" && !env.DEEPSEEK_API_KEY) {
    throw new Error("DEEPSEEK_API_KEY is required when LLM_PROVIDER=deepseek — see docs/SETUP.md");
  }
}

/**
 * Picks the live-call provider from LLM_PROVIDER. Adding a third provider
 * later means one new file implementing LLMProvider plus one line here —
 * Agent and everything above it (session, tools, prompt) never change.
 */
export function createLiveProvider(): LLMProvider {
  assertProviderConfigured();
  switch (env.LLM_PROVIDER) {
    case "deepseek":
      // Both args are hard-coded, not read from config — "low" effort and
      // "flash" (never the flagship) for the live path. See deepseek.ts for
      // the measured numbers behind both.
      return new DeepSeekProvider("low", "deepseek-v4-flash");
    case "anthropic":
    default:
      return new AnthropicProvider();
  }
}

/**
 * Provider for offline/post-call composition (the WhatsApp follow-up),
 * where quality matters more than latency and the 12-30s DeepSeek "max"
 * reasoning cost is irrelevant because nobody is on the line waiting.
 */
export function createDeepReasoningProvider(): LLMProvider {
  assertProviderConfigured();
  switch (env.LLM_PROVIDER) {
    case "deepseek":
      return new DeepSeekProvider("max");
    case "anthropic":
    default:
      return new AnthropicProvider();
  }
}
