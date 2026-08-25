import { SarvamAIClient, type SarvamAI } from "sarvamai";
import { env } from "../config.js";
import { toFrames, toPcm16Frames } from "../call/audio.js";

const client = new SarvamAIClient({ apiSubscriptionKey: env.SARVAM_API_KEY });

export type Language = "te-IN" | "hi-IN" | "en-IN";
/** Which wire format Sarvam should hand back — matched to whichever telephony provider's AudioSink is playing it. */
export type OutputCodec = "mulaw" | "linear16";

export interface SpokenSentence {
  /** Ready to write straight onto the media stream — Sarvam is asked for the target codec @ 8kHz directly, so there's no conversion left to do on our side. */
  frames: Buffer[];
  /** Wall-clock ms from send to first audio byte — the number the batch REST endpoint measured at ~1.7s. */
  latencyMs: number;
  durationMs: number;
}

type Socket = Awaited<ReturnType<typeof client.textToSpeechStreaming.connect>>;
type Message = SarvamAI.AudioOutput | SarvamAI.EventResponse | SarvamAI.ErrorResponse;

/**
 * One persistent Sarvam TTS WebSocket per call.
 *
 * The batch REST endpoint measured ~1.7s time-to-first-byte per sentence —
 * every sentence pays a fresh TLS handshake and connection setup, on top of
 * waiting for the *entire* clip before any audio is usable. Sarvam's own
 * streaming docs put first-byte latency under 250ms, and that number is
 * only real if the connection is opened once per call and reused — so
 * that's the shape here: connect in the constructor, `speak()` for every
 * sentence, `close()` when the call ends.
 *
 * Sentences are deliberately serialized against the socket (not fired
 * concurrently) because the SDK's event wiring holds one message handler at
 * a time, not a queue — installing a fresh handler per sentence only stays
 * correct if the previous sentence has already resolved.
 */
export class SarvamVoice {
  private socket: Socket | null = null;
  private readonly opening: Promise<Socket>;
  private queue: Promise<unknown> = Promise.resolve();
  private language: Language;

  constructor(
    initialLanguage: Language,
    private readonly codec: OutputCodec = "mulaw",
  ) {
    this.language = initialLanguage;
    this.opening = this.connect();
  }

  private async connect(): Promise<Socket> {
    const socket = await client.textToSpeechStreaming.connect({
      model: "bulbul:v3",
      send_completion_event: "true",
    });
    // client.connect() only constructs the (reconnecting) WebSocket — it
    // does not wait for the handshake to finish. configureConnection()
    // asserts the socket is OPEN and throws otherwise, so this wait is load
    // -bearing, not defensive.
    await socket.waitForOpen();
    this.configure(socket, this.language);
    this.socket = socket;
    return socket;
  }

  private configure(socket: Socket, language: Language): void {
    socket.configureConnection({
      language_code: language as SarvamAI.ConfigureConnection.Data.LanguageCode,
      speaker: env.SARVAM_VOICE as SarvamAI.ConfigureConnection.Data.Speaker,
      output_audio_codec: this.codec,
      speech_sample_rate: 8000,
    });
  }

  /** Caller code-switched — Sarvam accepts a fresh config message at any point in the socket's lifetime. */
  setLanguage(language: Language): void {
    if (language === this.language) return;
    this.language = language;
    this.queue = this.queue.then(async () => {
      const socket = await this.opening;
      this.configure(socket, language);
    });
  }

  /** Synthesizes one sentence; resolves once Sarvam signals generation is complete. */
  speak(text: string): Promise<SpokenSentence> {
    const task = this.queue.then(() => this.speakNow(text));
    // A failed sentence shouldn't wedge every sentence after it.
    this.queue = task.catch(() => undefined);
    return task;
  }

  private async speakNow(text: string): Promise<SpokenSentence> {
    const socket = await this.opening;
    const startedAt = performance.now();
    const chunks: Buffer[] = [];
    let firstByteMs = 0;

    return new Promise<SpokenSentence>((resolve, reject) => {
      socket.on("message", (message: Message) => {
        if (message.type === "audio") {
          if (!firstByteMs) firstByteMs = Math.round(performance.now() - startedAt);
          chunks.push(Buffer.from(message.data.audio, "base64"));
        } else if (message.type === "event" && message.data.event_type === "final") {
          const audio = Buffer.concat(chunks);
          // mu-law is 1 byte/sample @ 8kHz; linear16 is 2 bytes/sample @ 8kHz.
          const bytesPerMs = this.codec === "mulaw" ? 8 : 16;
          resolve({
            frames: this.codec === "mulaw" ? toFrames(audio) : toPcm16Frames(audio),
            latencyMs: firstByteMs || Math.round(performance.now() - startedAt),
            durationMs: Math.round(audio.length / bytesPerMs),
          });
        } else if (message.type === "error") {
          reject(new Error(`Sarvam streaming TTS: ${message.data.message}`));
        }
      });
      socket.convert(text);
      socket.flush();
    });
  }

  close(): void {
    this.socket?.close();
  }
}
