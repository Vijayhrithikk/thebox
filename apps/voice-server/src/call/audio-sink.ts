/**
 * Everything CallSession needs to push audio back to the caller, with zero
 * knowledge of which telephony provider (Twilio, Telnyx) is on the other
 * end of the WebSocket — see telephony/index.ts for how one gets picked.
 */
export interface AudioSink {
  /** True while audio we queued is still expected to be playing. */
  readonly isSpeaking: boolean;
  /** Milliseconds of queued audio still to play. */
  readonly remainingMs: number;
  /** Queue frames for playback; resolves once they've finished playing. */
  play(frames: Buffer[]): Promise<void>;
  /** Barge-in: drop whatever's buffered so playback stops immediately. */
  interrupt(): void;
  /** Twilio confirms playback completion via an echoed `mark` event; other providers may have no equivalent. */
  onMark?(name: string): void;
}
