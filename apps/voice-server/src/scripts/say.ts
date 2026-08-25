/**
 * Offline TTS check — no phone call, no Twilio spend.
 * Verifies the Sarvam key works and that the Telugu comes back sounding human.
 *
 *   pnpm say "నమస్కారం" te-IN
 */
import { writeFile } from "node:fs/promises";
import { synthesize, type Language } from "../providers/sarvam.js";

const text = process.argv[2] ?? "నమస్కారం, మీ e-commerce website గురించి మాట్లాడొచ్చా?";
const language = (process.argv[3] ?? "te-IN") as Language;

const result = await synthesize(text, language);
console.log(`ttfb=${result.latencyMs}ms  duration=${result.durationMs}ms  frames=${result.frames.length}`);

// Wrap the μ-law back into a WAV so it's playable in any media player.
const audio = Buffer.concat(result.frames);
const header = Buffer.alloc(44);
header.write("RIFF", 0);
header.writeUInt32LE(36 + audio.length, 4);
header.write("WAVEfmt ", 8);
header.writeUInt32LE(16, 16);
header.writeUInt16LE(7, 20); // format 7 = μ-law
header.writeUInt16LE(1, 22);
header.writeUInt32LE(8000, 24);
header.writeUInt32LE(8000, 28);
header.writeUInt16LE(1, 32);
header.writeUInt16LE(8, 34);
header.write("data", 36);
header.writeUInt32LE(audio.length, 40);

await writeFile("tts-check.wav", Buffer.concat([header, audio]));
console.log("wrote tts-check.wav — play it and judge whether it sounds like a person");
