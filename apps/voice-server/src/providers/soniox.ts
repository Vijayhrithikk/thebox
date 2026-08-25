import WebSocket from "ws";
import { EventEmitter } from "node:events";
import { env } from "../config.js";

const ENDPOINT = "wss://stt-rt.soniox.com/transcribe-websocket";

interface SonioxToken {
  text: string;
  is_final: boolean;
  language?: string;
  speaker?: number;
}

interface SonioxMessage {
  tokens?: SonioxToken[];
  finished?: boolean;
  error_code?: number | null;
  error_message?: string | null;
}

export interface TranscriptEvent {
  /** Finalized text since the last final event — safe to hand to the LLM. */
  text: string;
  /** Soniox's own language guess for this span, when it can tell. */
  language?: string;
}

/**
 * Streaming Telugu/Hindi/English ASR over Soniox's realtime WebSocket.
 *
 * Two things this exists to get right, both named directly in the brief:
 *   - code-switching: `language_hints` covers all three: Soniox auto-detects
 *     and switches mid-utterance with no manual toggling on our side.
 *   - low latency: we forward raw PCM as binary frames the instant Twilio's
 *     mu-law arrives (after decode), rather than batching — every buffered
 *     frame is milliseconds added to the turn-latency budget.
 *
 * Emits:
 *   'partial'  (text: string)              — interim words, for barge-in and live captions
 *   'final'    (event: TranscriptEvent)     — confirmed text, safe to reason over
 *   'error'    (err: Error)
 *   'close'    ()
 */
export class SonioxStream extends EventEmitter {
  private socket: WebSocket;
  private ready = false;
  private queued: Buffer[] = [];

  constructor() {
    super();
    this.socket = new WebSocket(ENDPOINT);

    this.socket.on("open", () => {
      this.socket.send(
        JSON.stringify({
          api_key: env.SONIOX_API_KEY,
          model: "stt-rt-v5",
          audio_format: "pcm_s16le",
          sample_rate: 8000,
          num_channels: 1,
          // Telugu, Hindi, English — hints bias detection without forcing it,
          // which is what lets a caller code-switch mid-sentence.
          language_hints: ["te", "hi", "en"],
          enable_language_identification: true,
          enable_endpoint_detection: true,
          // Domain context to bias recognition toward what this call is
          // actually about — live testing surfaced real mis-hears ("Good
          // morning, friend s.") that look like generic-vocabulary
          // hallucination on ordinary speech, not code-switching confusion.
          context: {
            general: [
              { key: "domain", value: "E-commerce website development sales call" },
              { key: "agent", value: env.CANDIDATE_NAME || "the caller" },
            ],
            text: "An outbound sales call in India, in Telugu, Hindi, and English, offering to build an e-commerce website — discussing budget, product catalog, timeline, payment gateway, and callback scheduling.",
            terms: [
              "e-commerce",
              "website",
              "product catalog",
              "checkout",
              "payment gateway",
              "WhatsApp",
              "callback",
              "budget",
              "timeline",
            ],
          },
        }),
      );
      this.ready = true;
      for (const frame of this.queued.splice(0)) this.socket.send(frame);
    });

    this.socket.on("message", (raw: Buffer) => {
      let msg: SonioxMessage;
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        return;
      }

      if (msg.error_code) {
        this.emit("error", new Error(`Soniox ${msg.error_code}: ${msg.error_message}`));
        return;
      }

      // `enable_endpoint_detection` makes Soniox emit a literal `<end>`
      // token (is_final: true) once per finalized segment as an endpoint
      // signal — it's meant as a trigger, not transcript text. Missing this
      // meant every turn's utterance had "<end>" concatenated onto it
      // verbatim (e.g. "హలో.<end>"), a garbled string handed straight to
      // the LLM as if the caller had said it — a real, silent cause of bad
      // replies that had nothing to do with prompt or model quality.
      const finalTokens = (msg.tokens ?? []).filter((t) => t.is_final && t.text.trim() && t.text !== "<end>");
      const partialTokens = (msg.tokens ?? []).filter((t) => !t.is_final && t.text.trim());

      if (finalTokens.length > 0) {
        const text = joinTokens(finalTokens);
        const language = finalTokens.find((t) => t.language)?.language;
        this.emit("final", { text, language } satisfies TranscriptEvent);
      }
      if (partialTokens.length > 0) {
        this.emit("partial", joinTokens(partialTokens));
      }
      if (msg.finished) {
        this.emit("close");
      }
    });

    this.socket.on("error", (err: Error) => this.emit("error", err));
    this.socket.on("close", () => this.emit("close"));
  }

  /** PCM16 mono @ 8kHz — exactly what the config negotiated above. */
  sendAudio(pcm: Buffer): void {
    if (this.ready && this.socket.readyState === this.socket.OPEN) {
      this.socket.send(pcm);
    } else {
      this.queued.push(pcm);
    }
  }

  /** Signals end-of-audio per Soniox's protocol, then lets the server close. */
  finish(): void {
    if (this.socket.readyState === this.socket.OPEN) {
      this.socket.send("");
    }
  }

  close(): void {
    this.socket.close();
  }
}

/**
 * Soniox tokens are subword/word fragments, not whitespace-delimited words —
 * naive space-joining produces "నమస్ కారం" instead of "నమస్కారం". Tokens that
 * start a new word carry a leading space themselves, so concatenation (not
 * join-with-space) is the correct reconstruction.
 */
function joinTokens(tokens: SonioxToken[]): string {
  return tokens.map((t) => t.text).join("").trim();
}
