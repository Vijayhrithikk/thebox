import { env } from "../config.js";
import * as Exotel from "./exotel.js";

export interface PlaceCallOptions {
  to: string;
  sessionId: string;
}

/** Fails loudly at boot if Exotel isn't configured, not three seconds into a scheduled callback. */
export function assertTelephonyConfigured(): void {
  if (!env.EXOTEL_SID || !env.EXOTEL_API_KEY || !env.EXOTEL_API_TOKEN || !env.EXOTEL_EXOPHONE || !env.EXOTEL_APP_ID) {
    throw new Error("EXOTEL_SID/EXOTEL_API_KEY/EXOTEL_API_TOKEN/EXOTEL_EXOPHONE/EXOTEL_APP_ID required");
  }
}

/**
 * The only thing this server still dials out for is a scheduled callback
 * (see brain/callbackScheduler.ts) — the primary call is placed by Sarvam's
 * Voice Agent via its own campaign system, not by this code. Dialing
 * through the same Exotel App reaches the same Sarvam-connected flow either
 * way, since the App's Voicebot Applet points at Sarvam, not at this server.
 */
export async function placeCall(options: PlaceCallOptions) {
  assertTelephonyConfigured();
  return Exotel.placeCall(options);
}
