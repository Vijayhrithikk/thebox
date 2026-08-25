import type { WebSocket } from "ws";
import type { FastifyBaseLogger } from "fastify";
import { OutboundAudio } from "./media-stream.js";
import { EnergyVad } from "./vad.js";
import { mulawToPcm16 } from "./audio.js";
import { SonioxStream } from "../providers/soniox.js";
import { synthesize, type Language } from "../providers/sarvam.js";
import { Agent, type StopReason } from "../brain/agent.js";
import { ConsoleActionSink } from "../brain/tools.js";
import { createLiveProvider } from "../brain/providers/index.js";

/** Soniox's 2-letter codes → Sarvam's locale codes. Unknown stays on whatever we were already speaking. */
function toSarvamLanguage(code: string | undefined, fallback: Language): Language {
  switch (code) {
    case "te":
      return "te-IN";
    case "hi":
      return "hi-IN";
    case "en":
      return "en-IN";
    default:
      return fallback;
  }
}

/** No new final tokens for this long ⇒ treat it as the end of the caller's turn. */
const SILENCE_TURN_END_MS = 700;

/**
 * One live phone call, start to finish. Owns the whole ASR → brain → TTS
 * loop and both barge-in signals (energy VAD for same-frame speed, ASR
 * partials for confirmation) that keep it feeling like a real conversation
 * rather than a walkie-talkie.
 */
export class CallSession {
  private readonly out: OutboundAudio;
  private readonly asr = new SonioxStream();
  private readonly vad = new EnergyVad();
  private readonly agent: Agent;

  private turnBuffer = "";
  private silenceTimer: NodeJS.Timeout | null = null;
  private agentBusy = false;
  private currentLanguage: Language = "te-IN"; // matches the Telugu-first opener
  private playQueue: Promise<void> = Promise.resolve();
  private closed = false;

  constructor(
    socket: WebSocket,
    streamSid: string,
    public readonly sessionId: string,
    private readonly log: FastifyBaseLogger,
  ) {
    this.out = new OutboundAudio(socket, streamSid);
    this.agent = new Agent(
      createLiveProvider(),
      new ConsoleActionSink((obj, msg) => this.log.info({ sessionId, ...obj as object }, msg)),
    );
    this.wireAsr();
  }

  /** Twilio's inbound 20ms mu-law frame, straight off the media socket. */
  handleInboundFrame(mulaw: Buffer): void {
    const pcm = mulawToPcm16(mulaw);

    if (this.vad.feed(pcm) && this.out.isSpeaking) {
      this.bargeIn("vad");
    }

    this.asr.sendAudio(pcm);
  }

  onMark(name: string): void {
    this.out.onMark(name);
  }

  close(): void {
    this.closed = true;
    if (this.silenceTimer) clearTimeout(this.silenceTimer);
    this.asr.finish();
    this.asr.close();
  }

  private wireAsr(): void {
    this.asr.on("partial", (text: string) => {
      if (text.trim().length > 2 && this.out.isSpeaking) {
        this.bargeIn("asr-partial");
      }
    });

    this.asr.on("final", ({ text, language }) => {
      if (!text) return;
      this.currentLanguage = toSarvamLanguage(language, this.currentLanguage);
      this.turnBuffer += (this.turnBuffer ? " " : "") + text;

      if (this.silenceTimer) clearTimeout(this.silenceTimer);
      this.silenceTimer = setTimeout(() => this.onTurnEnd(), SILENCE_TURN_END_MS);
    });

    this.asr.on("error", (err: Error) => {
      this.log.error({ err, sessionId: this.sessionId }, "Soniox error");
    });
  }

  private bargeIn(source: "vad" | "asr-partial"): void {
    this.out.interrupt();
    if (this.agentBusy) this.agent.interrupt();
    this.log.info({ sessionId: this.sessionId, source }, "barge-in");
  }

  private async onTurnEnd(): Promise<void> {
    if (this.closed || !this.turnBuffer.trim() || this.agentBusy) return;

    const utterance = this.turnBuffer.trim();
    this.turnBuffer = "";
    this.agentBusy = true;

    const startedAt = performance.now();
    this.log.info({ sessionId: this.sessionId, utterance }, "turn start");

    let stopReason: StopReason;
    try {
      stopReason = await this.agent.respond(utterance, (sentence) => {
        // Deliberately not awaited — see the comment on `speak`. Awaiting
        // here would block Claude's own stream from being read further,
        // which defeats sentence-level pipelining entirely.
        void this.speak(sentence);
      });
    } catch (err) {
      this.log.error({ err, sessionId: this.sessionId }, "agent turn failed");
      stopReason = "error";
    }

    this.agentBusy = false;
    this.log.info(
      { sessionId: this.sessionId, stopReason, ms: Math.round(performance.now() - startedAt) },
      "turn end",
    );

    if (stopReason === "refusal" || stopReason === "error") {
      void this.speak(
        this.currentLanguage === "te-IN"
          ? "క్షమించండి, మళ్ళీ చెప్పగలరా?"
          : "Sorry, could you say that again?",
      );
    }
  }

  /**
   * Synthesis is kicked off immediately so Sarvam's network round trip
   * overlaps with whatever is currently playing; the playQueue chain only
   * serializes the *playback* order, not the synthesis calls themselves —
   * that overlap is most of the gap between sentences disappearing.
   */
  private speak(text: string): Promise<void> {
    const synthPromise = synthesize(text, this.currentLanguage);
    this.playQueue = this.playQueue.then(async () => {
      if (this.closed) return;
      try {
        const speech = await synthPromise;
        await this.out.play(speech.frames);
      } catch (err) {
        this.log.error({ err, sessionId: this.sessionId, text }, "TTS/playback failed");
      }
    });
    return this.playQueue;
  }
}
