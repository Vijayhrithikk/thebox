import type { WebSocket } from "ws";
import { FRAME_MS } from "./audio.js";
import type { AudioSink } from "./audio-sink.js";

/**
 * Owns everything we write *back* to Twilio on the media socket.
 *
 * Twilio buffers what we send, so the fastest path is to push every frame at
 * once and rely on `clear` to flush the buffer when the caller interrupts.
 * That is what makes barge-in feel instant rather than "finishes the sentence
 * then stops" — the alternative (pacing frames in realtime) leaves up to a
 * few hundred ms of already-queued speech playing over the human.
 */
export class OutboundAudio implements AudioSink {
  readonly codec = "mulaw" as const;
  private markSeq = 0;
  private pending = new Map<string, () => void>();
  private speakingUntil = 0;

  constructor(
    private readonly socket: WebSocket,
    private readonly streamSid: string,
  ) {}

  /** True while audio we queued is still expected to be playing. */
  get isSpeaking(): boolean {
    return Date.now() < this.speakingUntil;
  }

  /** Milliseconds of queued audio still to play. */
  get remainingMs(): number {
    return Math.max(0, this.speakingUntil - Date.now());
  }

  /**
   * Queue frames for playback. Resolves when Twilio confirms the trailing mark
   * has been played — i.e. when the agent has actually finished speaking.
   */
  play(frames: Buffer[]): Promise<void> {
    if (frames.length === 0) return Promise.resolve();

    for (const frame of frames) {
      this.send({
        event: "media",
        streamSid: this.streamSid,
        media: { payload: frame.toString("base64") },
      });
    }

    const durationMs = frames.length * FRAME_MS;
    // Extend rather than overwrite, so back-to-back sentences chain correctly.
    this.speakingUntil = Math.max(this.speakingUntil, Date.now()) + durationMs;

    const name = `m${++this.markSeq}`;
    this.send({ event: "mark", streamSid: this.streamSid, mark: { name } });

    return new Promise<void>((resolve) => this.pending.set(name, resolve));
  }

  /**
   * Barge-in. Drops everything Twilio has buffered so the caller hears us stop
   * mid-word, which is what a person interrupting expects.
   */
  interrupt(): void {
    this.send({ event: "clear", streamSid: this.streamSid });
    this.speakingUntil = 0;
    for (const resolve of this.pending.values()) resolve();
    this.pending.clear();
  }

  /** Called when Twilio echoes a mark back to us. */
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
