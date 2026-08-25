import { env } from "../../config.js";
import { AnthropicProvider } from "./anthropic.js";
import { DeepSeekProvider } from "./deepseek.js";
import type { LLMProvider } from "./types.js";

export type { LLMProvider } from "./types.js";

/**
 * Picks the live-call provider from LLM_PROVIDER. Adding a third provider
 * later means one new file implementing LLMProvider plus one line here —
 * Agent and everything above it (session, tools, prompt) never change.
 */
export function createLiveProvider(): LLMProvider {
  switch (env.LLM_PROVIDER) {
    case "deepseek":
      return new DeepSeekProvider("low"); // never higher — see deepseek.ts for why
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
  switch (env.LLM_PROVIDER) {
    case "deepseek":
      return new DeepSeekProvider("max");
    case "anthropic":
    default:
      return new AnthropicProvider();
  }
}
