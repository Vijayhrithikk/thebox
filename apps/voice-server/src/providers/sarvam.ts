import { env } from "../config.js";
import { pcmFromWav, pcm16ToMulaw, toFrames } from "../call/audio.js";

const ENDPOINT = "https://api.sarvam.ai/text-to-speech";

export type Language = "te-IN" | "hi-IN" | "en-IN";

export interface SynthesisResult {
  /** Ready to write straight onto a Twilio media stream. */
  frames: Buffer[];
  /** Wall-clock ms from request to first byte — the number that decides if the call feels alive. */
  latencyMs: number;
  /** Playback duration, so the session knows when it stops talking. */
  durationMs: number;
}

/**
 * Sarvam Bulbul: native Telugu/Hindi/English with Tenglish and Hinglish
 * code-switching, and it will hand back 8 kHz directly — which means no
 * resampling stage between TTS and the phone line.
 */
export async function synthesize(
  text: string,
  language: Language,
  signal?: AbortSignal,
): Promise<SynthesisResult> {
  const started = performance.now();

  const body = {
    text,
    target_language_code: language,
    speaker: env.SARVAM_VOICE,
    model: env.SARVAM_MODEL,
    // Ask for the phone line's native rate so nothing has to be resampled.
    speech_sample_rate: 8000,
    enable_preprocessing: true,
    pace: 1.0,
  };

  const res = await fetch(ENDPOINT, {
    method: "POST",
    headers: {
      "api-subscription-key": env.SARVAM_API_KEY,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
    signal,
  });

  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new Error(`Sarvam TTS ${res.status}: ${detail.slice(0, 400)}`);
  }

  const payload = (await res.json()) as { audios?: string[]; audio?: string };
  const b64 = payload.audios?.[0] ?? payload.audio;
  if (!b64) throw new Error("Sarvam returned no audio");

  const pcm = pcmFromWav(Buffer.from(b64, "base64"));
  const mulaw = pcm16ToMulaw(pcm);
  const frames = toFrames(mulaw);

  return {
    frames,
    latencyMs: Math.round(performance.now() - started),
    // One μ-law byte per sample at 8 kHz → 8 bytes per millisecond.
    durationMs: Math.round(mulaw.length / 8),
  };
}
