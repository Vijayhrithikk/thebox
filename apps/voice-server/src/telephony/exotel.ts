import type { WebSocket } from "ws";
import { env } from "../config.js";
import { FRAME_MS } from "../call/audio.js";
import type { AudioSink } from "../call/audio-sink.js";

// Confirmed empirically against the real trial account: the Mumbai regional
// endpoint (api.in.exotel.com) 401s for this account, Singapore
// (api.exotel.com) works — the account must be provisioned there. Appending
// .json switches Exotel's legacy XML-by-default API to JSON responses.
const BASE_URL = "https://api.exotel.com/v1";

function assertExotelConfigured(): void {
  if (!env.EXOTEL_SID || !env.EXOTEL_API_KEY || !env.EXOTEL_API_TOKEN || !env.EXOTEL_EXOPHONE || !env.EXOTEL_APP_ID) {
    throw new Error(
      "EXOTEL_SID/EXOTEL_API_KEY/EXOTEL_API_TOKEN/EXOTEL_EXOPHONE/EXOTEL_APP_ID required when TELEPHONY_PROVIDER=exotel",
    );
  }
}

function authHeader(): string {
  const token = Buffer.from(`${env.EXOTEL_API_KEY}:${env.EXOTEL_API_TOKEN}`).toString("base64");
  return `Basic ${token}`;
}

export interface PlaceCallOptions {
  to: string;
  /** Correlates the PSTN call, the media stream and the console's live view. */
  sessionId: string;
}

/**
 * Dials out via Exotel's "Outgoing Call to Flow" mode of the Calls/connect
 * API. This is NOT the same as the (also-named) "connect two numbers" mode
 * — that one dials `From` first as a human agent leg, then bridges to a
 * separately-dialed `To` number, which live-testing confirmed fails outright
 * for a bot (there's no second human leg to bridge to). Flow mode instead
 * omits `To` entirely: `From` is the single real number being called, and
 * `Url` points at an Exotel-hosted App Bazaar flow (holding a Voicebot
 * Applet configured with our WSS endpoint) rather than an external URL —
 * confirmed live that an arbitrary external Url is silently ignored here,
 * only Exotel's own `http://my.exotel.com/{sid}/exoml/start_voice/{app_id}`
 * format triggers the flow.
 */
export async function placeCall({ to, sessionId }: PlaceCallOptions) {
  assertExotelConfigured();

  const body = new URLSearchParams({
    From: to,
    CallerId: env.EXOTEL_EXOPHONE!,
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

/**
 * Mirrors OutboundAudio (Twilio) behind the same AudioSink interface, but
 * for Exotel's raw linear16 PCM wire format instead of μ-law, and using
 * Exotel's snake_case field names (`stream_sid`, not `streamSid`).
 *
 * Unlike Telnyx's adapter, both `mark` (playback-complete confirmation) and
 * `clear` (barge-in buffer flush) are explicitly documented by Exotel, so
 * this uses real server-confirmed completion the same way Twilio's does —
 * no elapsed-time guessing.
 */
export class ExotelAudioSink implements AudioSink {
  readonly codec = "linear16" as const;
  private markSeq = 0;
  private pending = new Map<string, () => void>();
  private speakingUntil = 0;

  constructor(
    private readonly socket: WebSocket,
    private readonly streamSid: string,
  ) {}

  get isSpeaking(): boolean {
    return Date.now() < this.speakingUntil;
  }

  get remainingMs(): number {
    return Math.max(0, this.speakingUntil - Date.now());
  }

  play(frames: Buffer[]): Promise<void> {
    if (frames.length === 0) return Promise.resolve();

    for (const frame of frames) {
      this.send({ event: "media", stream_sid: this.streamSid, media: { payload: frame.toString("base64") } });
    }

    const durationMs = frames.length * FRAME_MS;
    this.speakingUntil = Math.max(this.speakingUntil, Date.now()) + durationMs;

    const name = `m${++this.markSeq}`;
    this.send({ event: "mark", stream_sid: this.streamSid, mark: { name } });

    return new Promise<void>((resolve) => this.pending.set(name, resolve));
  }

  interrupt(): void {
    this.send({ event: "clear", stream_sid: this.streamSid });
    this.speakingUntil = 0;
    for (const resolve of this.pending.values()) resolve();
    this.pending.clear();
  }

  /** Called when Exotel echoes a mark back to us. */
  onMark(name: string): void {
    const resolve = this.pending.get(name);
    if (resolve) {
      this.pending.delete(name);
      resolve();
    }
  }

  private send(message: unknown): void {
    if (this.socket.readyState === this.socket.OPEN) {
      this.socket.send(JSON.stringify(message));
    }
  }
}
