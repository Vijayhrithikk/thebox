import { env } from "../config.js";
import * as Twilio from "./twilio.js";
import * as Telnyx from "./telnyx.js";

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
  } else {
    if (!env.TELNYX_API_KEY || !env.TELNYX_PHONE_NUMBER || !env.TELNYX_CONNECTION_ID) {
      throw new Error("TELNYX_API_KEY/TELNYX_PHONE_NUMBER/TELNYX_CONNECTION_ID required when TELEPHONY_PROVIDER=telnyx");
    }
  }
}

/**
 * Places the outbound call on whichever provider TELEPHONY_PROVIDER selects.
 * Twilio is fully built and proven end-to-end up to its trial-account wall;
 * Telnyx is the live default — see docs/SETUP.md and PROGRESS.md decisions
 * table for why. Switching back is one env var, zero code changes.
 */
export async function placeCall(options: PlaceCallOptions) {
  assertTelephonyConfigured();
  return env.TELEPHONY_PROVIDER === "twilio" ? Twilio.placeCall(options) : Telnyx.placeCall(options);
}
