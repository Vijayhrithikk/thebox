import { env } from "../config.js";
import * as Sarvam from "./sarvam.js";

export interface PlaceCallOptions {
  to: string;
  sessionId: string;
}

export function isTelephonyConfigured(): boolean {
  return Boolean(
    env.SARVAM_API_KEY &&
      env.SARVAM_ORG_ID &&
      env.SARVAM_WORKSPACE_ID &&
      env.SARVAM_APP_ID &&
      env.SARVAM_APP_VERSION &&
      env.SARVAM_CONNECTION_ID &&
      env.SARVAM_AGENT_PHONE_NUMBER,
  );
}

export async function placeCall(options: PlaceCallOptions) {
  if (!isTelephonyConfigured()) {
    throw new Error("No telephony configured — SARVAM_* env vars are unset, cannot place the call");
  }
  return Sarvam.placeCall(options);
}
