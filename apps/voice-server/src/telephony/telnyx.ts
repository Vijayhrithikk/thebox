import TelnyxSDK from "telnyx";
import type { WebSocket } from "ws";
import { env, streamUrl } from "../config.js";
import { FRAME_MS } from "../call/audio.js";
import type { AudioSink } from "../call/audio-sink.js";

// Lazy for the same reason as twilio.ts: TELNYX_API_KEY is legitimately
// unset when Twilio is the active provider, and constructing this at module
// scope would fail the moment this file is imported, not when it's used.
function telnyxClient() {
  if (!env.TELNYX_API_KEY) {
    throw new Error("TELNYX_API_KEY required when TELEPHONY_PROVIDER=telnyx");
  }
  return new TelnyxSDK({ apiKey: env.TELNYX_API_KEY });
}

export interface PlaceCallOptions {
  to: string;
  /** Correlates the PSTN call, the media stream and the console's live view. */
  sessionId: string;
}

/**
 * Dials out via Telnyx's Call Control API. Unlike Twilio's TwiML-first
 * model, streaming isn't declarative — the `stream_*` fields go directly on
 * the Dial request, and Telnyx starts pushing bidirectional RTP to our
 * WebSocket automatically once the call is answered (confirmed via the
 * SDK's own type definitions: `dial()`'s JSDoc lists `streaming.started` as
 * an expected webhook whenever `stream_url` is set — no separate
 * streaming_start action needed for the common case of "stream from the
 * moment the call connects").
 */
export async function placeCall({ to, sessionId }: PlaceCallOptions) {
  if (!env.TELNYX_PHONE_NUMBER || !env.TELNYX_CONNECTION_ID) {
    throw new Error("TELNYX_PHONE_NUMBER/TELNYX_CONNECTION_ID required when TELEPHONY_PROVIDER=telnyx");
  }

  const response = await telnyxClient().calls.dial({
    connection_id: env.TELNYX_CONNECTION_ID,
    to,
    from: env.TELNYX_PHONE_NUMBER,
    client_state: base64(JSON.stringify({ sessionId })),
    stream_url: streamUrl(),
    stream_track: "both_tracks",
    stream_bidirectional_mode: "rtp",
    stream_bidirectional_codec: "PCMU", // G.711 mu-law — same codec Twilio uses, so our existing audio.ts needs no changes
    stream_bidirectional_sampling_rate: 8000,
    stream_bidirectional_target_legs: "self", // the leg we just dialed, not the far end
    // Ring for 30s, then give up rather than landing in voicemail forever — matches twilio.ts's timeout.
    timeout_secs: 30,
  });

  return response.data;
}

function base64(s: string): string {
  return Buffer.from(s, "utf-8").toString("base64");
}

/**
 * Mirrors OutboundAudio (Twilio) behind the same AudioSink interface.
 *
 * Two honest gaps, unverifiable until the account clears review and a real
 * call can be tested end to end:
 *   1. No documented Telnyx equivalent of Twilio's `mark` echo was found, so
 *      playback-complete is inferred from elapsed time (frame count x 20ms)
 *      rather than a server confirmation — same duration math as Twilio,
 *      just without the extra certainty the mark gives there.
 *   2. No documented `clear`-equivalent message was found for flushing
 *      already-buffered audio on barge-in. `interrupt()` resets our own
 *      timing state immediately, but whether Telnyx's side stops queued
 *      audio the same instant Twilio's `clear` does is unconfirmed. If live
 *      testing shows a lag here, that's the first place to look.
 */
export class TelnyxAudioSink implements AudioSink {
  private speakingUntil = 0;

  constructor(
    private readonly socket: WebSocket,
    private readonly streamId: string,
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
      this.send({ event: "media", media: { payload: frame.toString("base64") } });
    }

    const durationMs = frames.length * FRAME_MS;
    this.speakingUntil = Math.max(this.speakingUntil, Date.now()) + durationMs;

    return new Promise<void>((resolve) => setTimeout(resolve, durationMs));
  }

  interrupt(): void {
    // No confirmed clear-buffer message for Telnyx — see class doc.
    this.speakingUntil = 0;
  }

  private send(message: unknown): void {
    if (this.socket.readyState === this.socket.OPEN) {
      this.socket.send(JSON.stringify(message));
    }
  }
}
