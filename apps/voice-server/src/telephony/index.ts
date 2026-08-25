import { env } from "../config.js";
import * as Twilio from "./twilio.js";
import * as Telnyx from "./telnyx.js";
import * as Exotel from "./exotel.js";

export type { AudioSink } from "../call/audio-sink.js";

export interface PlaceCallOptions {
  to: string;
  sessionId: string;
}

/**
 * Fails loudly the moment something actually places a call, not at module
 * import time — same reasoning as brain/providers/index.ts's
 * assertProviderConfigured(): whichever provider is inactive legitimately
 * has empty env vars, and importing this module shouldn't crash over that.
 */
export function assertTelephonyConfigured(): void {
  if (env.TELEPHONY_PROVIDER === "twilio") {
    if (!env.TWILIO_ACCOUNT_SID || !env.TWILIO_AUTH_TOKEN || !env.TWILIO_PHONE_NUMBER) {
      throw new Error("TWILIO_ACCOUNT_SID/TWILIO_AUTH_TOKEN/TWILIO_PHONE_NUMBER required when TELEPHONY_PROVIDER=twilio");
    }
  } else if (env.TELEPHONY_PROVIDER === "telnyx") {
    if (!env.TELNYX_API_KEY || !env.TELNYX_PHONE_NUMBER || !env.TELNYX_CONNECTION_ID) {
      throw new Error("TELNYX_API_KEY/TELNYX_PHONE_NUMBER/TELNYX_CONNECTION_ID required when TELEPHONY_PROVIDER=telnyx");
    }
  } else {
    if (!env.EXOTEL_SID || !env.EXOTEL_API_KEY || !env.EXOTEL_API_TOKEN || !env.EXOTEL_EXOPHONE || !env.EXOTEL_APP_ID) {
      throw new Error(
        "EXOTEL_SID/EXOTEL_API_KEY/EXOTEL_API_TOKEN/EXOTEL_EXOPHONE/EXOTEL_APP_ID required when TELEPHONY_PROVIDER=exotel",
      );
    }
  }
}

/**
 * sessionId -> phone number, for every call this process has placed since
 * boot. In-memory, not persisted — doesn't survive a restart, which matters
 * for callbackScheduler.ts: a scheduled re-dial only fires if the process
 * that scheduled it stays up. Real persistence (Postgres) is the Phase 4
 * follow-up once DATABASE_URL is a real connection string; this is enough
 * to prove the mechanism works end to end today.
 */
const callerNumbers = new Map<string, string>();

export function getCallerNumber(sessionId: string): string | undefined {
  return callerNumbers.get(sessionId);
}

/**
 * Places the outbound call on whichever provider TELEPHONY_PROVIDER selects.
 * Exotel is the live default — Twilio and Telnyx are both fully built and
 * kept as documented fallbacks, but both hit the same wall calling India (a
 * trial-tier block and an unverified-account block respectively); Exotel's
 * India-domestic routing sidesteps that entirely. See docs/SETUP.md and
 * PROGRESS.md decisions table for the full history. Switching back is one
 * env var, zero code changes.
 */
export async function placeCall(options: PlaceCallOptions) {
  assertTelephonyConfigured();
  callerNumbers.set(options.sessionId, options.to);
  if (env.TELEPHONY_PROVIDER === "twilio") return Twilio.placeCall(options);
  if (env.TELEPHONY_PROVIDER === "telnyx") return Telnyx.placeCall(options);
  return Exotel.placeCall(options);
}
