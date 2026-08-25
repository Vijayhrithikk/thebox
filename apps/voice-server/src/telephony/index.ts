import { env } from "../config.js";
import * as Exotel from "./exotel.js";

export interface PlaceCallOptions {
  to: string;
  sessionId: string;
}

/** True only when every Exotel field is actually set — the number moved to a Sarvam-rented number, so these are legitimately unset now. */
export function isTelephonyConfigured(): boolean {
  return Boolean(env.EXOTEL_SID && env.EXOTEL_API_KEY && env.EXOTEL_API_TOKEN && env.EXOTEL_EXOPHONE && env.EXOTEL_APP_ID);
}

/**
 * The only thing this server ever dials out for is a scheduled callback
 * (see brain/callbackScheduler.ts) — the primary call is placed by Sarvam's
 * Voice Agent via its own campaign system, not by this code. Throws if
 * Exotel isn't configured; callbackScheduler.ts is what actually decides
 * whether to call this or just log, so the throw only ever happens right
 * next to where it's caught.
 */
export async function placeCall(options: PlaceCallOptions) {
  if (!isTelephonyConfigured()) {
    throw new Error("No telephony configured — EXOTEL_* env vars are unset, cannot place the callback re-dial");
  }
  return Exotel.placeCall(options);
}
