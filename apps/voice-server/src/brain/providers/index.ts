import { env } from "../../config.js";
import { DeepSeekProvider } from "./deepseek.js";
import type { LLMProvider } from "./types.js";

export type { LLMProvider } from "./types.js";

/** Fails loudly the moment something actually tries to use the brain, not at module-load time. */
export function assertProviderConfigured(): void {
  if (!env.DEEPSEEK_API_KEY) {
    throw new Error("DEEPSEEK_API_KEY is required — see docs/SETUP.md");
  }
}

/**
 * Fast, low-reasoning-effort provider — used by callbackResolver.ts, where
 * a webhook is waiting on the response. "low" effort and the flash model
 * are hard-coded, not read from config: DeepSeek's flagship at higher
 * reasoning effort was independently measured at 12-30s to first token
 * during earlier live-call testing, which is fine for nothing this server
 * still does synchronously.
 */
export function createLiveProvider(): LLMProvider {
  assertProviderConfigured();
  return new DeepSeekProvider("low", "deepseek-v4-flash");
}

/**
 * Slower, higher-quality provider for the post-call WhatsApp follow-up
 * composition (see actions/followup.ts) — quality matters more than
 * latency there, and nobody is on the line waiting for it.
 */
export function createDeepReasoningProvider(): LLMProvider {
  assertProviderConfigured();
  return new DeepSeekProvider("max");
}
