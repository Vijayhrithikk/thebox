import type { FastifyBaseLogger } from "fastify";
import type { AudioSink } from "./audio-sink.js";
import { EnergyVad } from "./vad.js";
import { SonioxStream } from "../providers/soniox.js";
import { SarvamVoice, type Language } from "../providers/sarvam.js";
import { Agent, type StopReason } from "../brain/agent.js";
import { dedupeHotClassification, type ActionSink } from "../brain/tools.js";
import { LiveActionSink } from "../brain/liveActionSink.js";
import { extractSignals } from "../brain/signalExtractor.js";
import { scoreUtterance } from "../brain/signalScorer.js";
import { createLiveProvider, type LLMProvider } from "../brain/providers/index.js";

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
 * How long to wait, after WE finish speaking, before assuming the caller
 * has gone quiet rather than just thinking. First strike gets a spoken
 * check-in; a second strike with still nothing ends the call politely
 * instead of sitting connected in dead air indefinitely — the brief is
 * explicit that dead air is the one thing never acceptable, and an
 * abandoned or dropped call staying "live" burns real telephony minutes
 * for no reason.
 */
const CALLER_SILENCE_MS = 10_000;

/**
 * Grace window after WE start a new spoken segment before VAD/ASR-partial
 * barge-in is allowed to fire. Without this, any real phone line's acoustic
 * or line echo of our own TTS output — the caller's earpiece leaking into
 * their mic, extremely common on speakerphone or a lot of real handsets —
 * gets detected as "the caller started talking" within the very first
 * frame, cutting us off mid-word, immediately, every single sentence. That
 * produces exactly a broken, stuttering, "not spontaneous" conversation
 * with nothing to do with model or TTS latency. A genuine human interrupt
 * essentially never lands inside the first ~350ms of us starting to talk —
 * reaction time alone rules it out — so this window costs nothing on real
 * barge-in responsiveness while filtering out immediate self-echo.
 */
const BARGE_IN_GRACE_MS = 350;

/**
 * One live phone call, start to finish. Owns the whole ASR → brain → TTS
 * loop and both barge-in signals (energy VAD for same-frame speed, ASR
 * partials for confirmation) that keep it feeling like a real conversation
 * rather than a walkie-talkie.
 */
export class CallSession {
  private readonly asr = new SonioxStream();
  private readonly vad = new EnergyVad();
  private readonly agent: Agent;
  /** One WebSocket per call, opened once — see providers/sarvam.ts for why that matters. */
  private readonly voice: SarvamVoice;
  /** Separate provider instance for signalExtractor.ts — a distinct concurrent call per turn, never awaited by the spoken reply. */
  private readonly extractionProvider: LLMProvider;
  private readonly sink: ActionSink;

  private turnBuffer = "";
  private silenceTimer: NodeJS.Timeout | null = null;
  private agentBusy = false;
  private currentLanguage: Language = "te-IN"; // matches the Telugu-first opener
  private playQueue: Promise<void> = Promise.resolve();
  private closed = false;

  /** Separate from `silenceTimer` above — that one detects end-of-caller-turn (700ms); this one detects the caller going quiet for the whole call. */
  private callerSilenceTimer: NodeJS.Timeout | null = null;
  private silenceStrikes = 0;

  /** When our current spoken segment started — see BARGE_IN_GRACE_MS. */
  private speechStartedAt = 0;

  constructor(
    private readonly out: AudioSink,
    public readonly sessionId: string,
    private readonly log: FastifyBaseLogger,
  ) {
    this.voice = new SarvamVoice(this.currentLanguage, out.codec);
    this.agent = new Agent(createLiveProvider());
    this.extractionProvider = createLiveProvider();
    this.sink = dedupeHotClassification(
      new LiveActionSink(sessionId, this.extractionProvider, (obj, msg) =>
        this.log.info({ sessionId, ...obj as object }, msg),
      ),
    );
    this.wireAsr();
    void this.greet();
  }

  /**
   * This is an outbound sales call — the agent has to open, not wait for the
   * caller to speak first. Without this, the call sits in total silence
   * until the caller says something, which for an unknown incoming number
   * often never happens at all. Only caught now because this is the first
   * time the full pipeline has actually run against a live phone call.
   */
  private async greet(): Promise<void> {
    this.agentBusy = true;
    try {
      const stopReason = await this.agent.greet((sentence) => {
        this.log.info({ sessionId: this.sessionId, sentence }, "agent said");
        void this.speak(sentence);
      });
      this.log.info({ sessionId: this.sessionId, stopReason }, "greeting sent");
      void this.playQueue.then(() => this.armSilenceWatch());
    } catch (err) {
      this.log.error({ err, sessionId: this.sessionId }, "greeting failed");
    } finally {
      this.agentBusy = false;
    }
  }

  /**
   * One 20ms frame of inbound audio, already decoded to linear16 PCM by the
   * route handler — codec differences (Twilio/Telnyx's μ-law vs Exotel's
   * native PCM) are a wire-format concern for that boundary, not something
   * CallSession needs to know about.
   */
  handleInboundFrame(pcm: Buffer): void {
    if (this.vad.feed(pcm) && this.out.isSpeaking && this.pastBargeInGrace()) {
      this.bargeIn("vad");
    }

    this.asr.sendAudio(pcm);
  }

  private pastBargeInGrace(): boolean {
    return Date.now() - this.speechStartedAt > BARGE_IN_GRACE_MS;
  }

  onMark(name: string): void {
    this.out.onMark?.(name);
  }

  close(): void {
    this.closed = true;
    if (this.silenceTimer) clearTimeout(this.silenceTimer);
    this.clearSilenceWatch();
    this.asr.finish();
    this.asr.close();
    this.voice.close();
  }

  /** Restarts the "has the caller gone quiet" watch — called after every turn we finish speaking. */
  private armSilenceWatch(): void {
    if (this.closed) return;
    if (this.callerSilenceTimer) clearTimeout(this.callerSilenceTimer);
    this.callerSilenceTimer = setTimeout(() => this.onCallerSilence(), CALLER_SILENCE_MS);
  }

  /** Any sign of caller speech (even a partial) cancels the watch — see wireAsr(). */
  private clearSilenceWatch(): void {
    this.silenceStrikes = 0;
    if (this.callerSilenceTimer) {
      clearTimeout(this.callerSilenceTimer);
      this.callerSilenceTimer = null;
    }
  }

  private onCallerSilence(): void {
    if (this.closed || this.agentBusy) return;
    this.silenceStrikes++;

    if (this.silenceStrikes === 1) {
      this.log.info({ sessionId: this.sessionId }, "caller silent — checking in");
      void this.speak(
        this.currentLanguage === "te-IN" ? "హలో? మీరు అక్కడ ఉన్నారా?" : "Hello? Are you still there?",
      );
      this.armSilenceWatch();
    } else {
      this.log.info({ sessionId: this.sessionId }, "caller silent after check-in — ending call");
      void this.speak(
        this.currentLanguage === "te-IN"
          ? "సరే, తర్వాత మాట్లాడదాం. ధన్యవాదాలు!"
          : "Alright, I'll let you go for now — thank you!",
      ).finally(() => this.close());
    }
  }

  private wireAsr(): void {
    this.asr.on("partial", (text: string) => {
      if (text.trim().length > 2) {
        this.clearSilenceWatch();
        if (this.out.isSpeaking && this.pastBargeInGrace()) this.bargeIn("asr-partial");
      }
    });

    this.asr.on("final", ({ text, language }) => {
      if (!text) return;
      this.clearSilenceWatch();
      this.currentLanguage = toSarvamLanguage(language, this.currentLanguage);
      this.voice.setLanguage(this.currentLanguage);
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

    // Fires concurrently, never awaited here — extraction latency must never
    // show up as a delay in what the caller hears. See signalExtractor.ts.
    void extractSignals(utterance, this.extractionProvider, this.sink).catch((err) => {
      this.log.error({ err, sessionId: this.sessionId, utterance }, "signal extraction failed");
    });

    // Second, non-LLM path to the same classification — synchronous, zero
    // latency cost, redundant on purpose. See signalScorer.ts and
    // dedupeHotClassification() for why two paths calling onClassify("hot")
    // don't produce two mid-call actions.
    const deterministic = scoreUtterance(utterance);
    if (deterministic) this.sink.onClassify(deterministic);

    let stopReason: StopReason;
    try {
      stopReason = await this.agent.respond(utterance, (sentence) => {
        this.log.info({ sessionId: this.sessionId, sentence }, "agent said");
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

    void this.playQueue.then(() => this.armSilenceWatch());
  }

  /**
   * `voice.speak()` is kicked off immediately so Sarvam's synthesis overlaps
   * whatever is currently playing; the playQueue chain only serializes
   * *playback* order, not synthesis. Synthesis itself is already serialized
   * one level down, inside SarvamVoice, against its single persistent socket.
   *
   * Known gap, not fixed here: barge-in aborts the LLM request and clears
   * already-playing audio, but doesn't cancel a sentence mid-synthesis on
   * the Sarvam socket — a stray sentence can still land right after an
   * interrupt. Revisit in Phase 6 hardening once this is stress-tested
   * against real barge-in timing; the old REST-based synth had the same gap.
   */
  private speak(text: string): Promise<void> {
    const synthPromise = this.voice.speak(text);
    this.playQueue = this.playQueue.then(async () => {
      if (this.closed) return;
      try {
        const speech = await synthPromise;
        this.speechStartedAt = Date.now();
        await this.out.play(speech.frames);
      } catch (err) {
        this.log.error({ err, sessionId: this.sessionId, text }, "TTS/playback failed");
      }
    });
    return this.playQueue;
  }
}
