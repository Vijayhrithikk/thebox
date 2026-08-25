import { env } from "../config.js";

// Confirmed empirically against the real account: the Mumbai regional
// endpoint (api.in.exotel.com) 401s for this account, Singapore
// (api.exotel.com) works — the account must be provisioned there. Appending
// .json switches Exotel's legacy XML-by-default API to JSON responses.
const BASE_URL = "https://api.exotel.com/v1";

function authHeader(): string {
  const token = Buffer.from(`${env.EXOTEL_API_KEY}:${env.EXOTEL_API_TOKEN}`).toString("base64");
  return `Basic ${token}`;
}

export interface PlaceCallOptions {
  to: string;
  sessionId: string;
}

/**
 * Dials out via Exotel's "Outgoing Call to Flow" mode of the Calls/connect
 * API. This is NOT the same as the (also-named) "connect two numbers" mode
 * — that one dials `From` first as a human agent leg, then bridges to a
 * separately-dialed `To` number, which live-testing confirmed fails outright
 * for a bot (there's no second human leg to bridge to). Flow mode instead
 * omits `To` entirely: `From` is the single real number being called, and
 * `Url` points at an Exotel-hosted App Bazaar flow — confirmed live that an
 * arbitrary external Url is silently ignored here, only Exotel's own
 * `http://my.exotel.com/{sid}/exoml/start_voice/{app_id}` format triggers
 * the flow. That flow's Voicebot Applet now points at Sarvam's Voice Agent
 * runtime, not this server — this function's only remaining job is placing
 * the call; the actual conversation happens entirely inside Sarvam.
 */
export async function placeCall({ to, sessionId }: PlaceCallOptions) {
  // Callers (telephony/index.ts) already check isTelephonyConfigured()
  // before reaching here — these fields are legitimately optional at the
  // schema level now, since a live install may run with no Exotel
  // credentials at all, but by the time this function runs they're known
  // to be set.
  if (!env.EXOTEL_EXOPHONE || !env.EXOTEL_SID || !env.EXOTEL_APP_ID) {
    throw new Error("EXOTEL_EXOPHONE/EXOTEL_SID/EXOTEL_APP_ID required to place a call");
  }

  const body = new URLSearchParams({
    From: to,
    CallerId: env.EXOTEL_EXOPHONE,
    Url: `http://my.exotel.com/${env.EXOTEL_SID}/exoml/start_voice/${env.EXOTEL_APP_ID}`,
    CustomField: sessionId,
  });

  const response = await fetch(`${BASE_URL}/Accounts/${env.EXOTEL_SID}/Calls/connect.json`, {
    method: "POST",
    headers: {
      Authorization: authHeader(),
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: body.toString(),
  });

  const data = (await response.json()) as { Call?: { Sid: string; Status: string }; RestException?: { Message: string } };
  if (!response.ok || data.RestException) {
    throw new Error(`Exotel call failed: ${data.RestException?.Message ?? response.statusText}`);
  }

  return data.Call;
}
