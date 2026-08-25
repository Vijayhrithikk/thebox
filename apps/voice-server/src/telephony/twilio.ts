import twilio from "twilio";
import { env, streamUrl } from "../config.js";

// Lazy, not `export const twilioClient = twilio(...)` at module scope — with
// Telnyx as the default TELEPHONY_PROVIDER, TWILIO_ACCOUNT_SID/AUTH_TOKEN are
// legitimately unset, and the twilio SDK throws immediately on a malformed
// SID. Eager construction would crash the process just from *importing* this
// file, even on a call path that never touches Twilio.
function twilioClient() {
  if (!env.TWILIO_ACCOUNT_SID || !env.TWILIO_AUTH_TOKEN) {
    throw new Error("TWILIO_ACCOUNT_SID/TWILIO_AUTH_TOKEN required when TELEPHONY_PROVIDER=twilio");
  }
  return twilio(env.TWILIO_ACCOUNT_SID, env.TWILIO_AUTH_TOKEN);
}

/**
 * TwiML that hands the call straight to our WebSocket.
 *
 * <Connect><Stream> is the bidirectional form — Twilio streams the caller's
 * audio to us and plays back whatever we write into the same socket. The
 * one-way <Start><Stream> form cannot speak, only listen.
 */
export function connectStreamTwiml(params: Record<string, string> = {}): string {
  const attrs = Object.entries(params)
    .map(([name, value]) => `<Parameter name="${name}" value="${escapeXml(value)}"/>`)
    .join("");

  return `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Connect>
    <Stream url="${streamUrl()}">${attrs}</Stream>
  </Connect>
</Response>`;
}

export interface PlaceCallOptions {
  to: string;
  /** Correlates the PSTN call, the media stream and the console's live view. */
  sessionId: string;
}

/**
 * Dials out. Note the caller ID is our US number — Twilio dropped support for
 * Indian (+91) numbers on outbound in Aug 2024, but calling *into* India from a
 * non-India number is explicitly permitted where the recipient has consented.
 */
export async function placeCall({ to, sessionId }: PlaceCallOptions) {
  if (!env.TWILIO_PHONE_NUMBER) {
    throw new Error("TWILIO_PHONE_NUMBER required when TELEPHONY_PROVIDER=twilio");
  }
  const call = await twilioClient().calls.create({
    to,
    from: env.TWILIO_PHONE_NUMBER,
    twiml: connectStreamTwiml({ sessionId }),
    // Ring for 30s, then give up rather than landing in voicemail forever.
    timeout: 30,
    statusCallback: env.PUBLIC_HOST
      ? `https://${env.PUBLIC_HOST.replace(/^https?:\/\//, "")}/call-status`
      : undefined,
    statusCallbackEvent: ["initiated", "ringing", "answered", "completed"],
  });

  return call;
}

function escapeXml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
