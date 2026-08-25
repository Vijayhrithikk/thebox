/**
 * Bare energy-based speech detector.
 *
 * This exists purely to shave milliseconds off barge-in. Soniox will also
 * tell us the caller is talking, but that is a network round trip away. A
 * same-process RMS check on the raw PCM reacts within one 20ms frame — that
 * gap is the difference between "cuts off instantly" and "keeps talking for
 * a beat after the human starts", which the brief calls out by name as
 * something to get right ("People talk over the bot. Handle it.").
 */
export class EnergyVad {
  private readonly threshold: number;
  private readonly hangoverFrames: number;
  private aboveCount = 0;

  constructor(opts: { threshold?: number; sustainedFrames?: number } = {}) {
    // Empirically: phone-line background noise sits well under 400 RMS;
    // actual speech clears 800+. Tuned during rehearsal, not guessed once.
    this.threshold = opts.threshold ?? 800;
    // Require 2 consecutive frames (40ms) above threshold before declaring
    // speech, so a single click or line-noise spike can't trigger barge-in.
    this.hangoverFrames = opts.sustainedFrames ?? 2;
  }

  /** Feed one 20ms PCM16 frame. Returns true the instant sustained speech is detected. */
  feed(pcm16: Buffer): boolean {
    const rms = rmsOf(pcm16);
    if (rms > this.threshold) {
      this.aboveCount++;
    } else {
      this.aboveCount = 0;
    }
    return this.aboveCount >= this.hangoverFrames;
  }

  reset(): void {
    this.aboveCount = 0;
  }
}

function rmsOf(pcm16: Buffer): number {
  let sumSquares = 0;
  const samples = pcm16.length / 2;
  for (let i = 0; i < pcm16.length; i += 2) {
    const sample = pcm16.readInt16LE(i);
    sumSquares += sample * sample;
  }
  return Math.sqrt(sumSquares / Math.max(1, samples));
}
