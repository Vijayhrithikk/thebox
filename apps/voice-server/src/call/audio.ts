/**
 * Audio plumbing between our TTS provider and Twilio's media stream.
 *
 * Twilio speaks exactly one dialect on a <Stream>: 8 kHz mono G.711 μ-law,
 * base64-encoded, in 20 ms frames. Sarvam can hand us 8 kHz PCM directly, so
 * there is no resampling step — just PCM16 → μ-law and framing.
 */

/** 8000 Hz × 0.02 s × 1 byte per μ-law sample. */
export const FRAME_BYTES = 160;
export const FRAME_MS = 20;

const MULAW_BIAS = 0x84;
const MULAW_CLIP = 32635;

// Standard G.711 exponent lookup, indexed by the top byte of the biased sample.
const EXPONENT = new Uint8Array(256);
for (let i = 0; i < 256; i++) {
  if (i < 1) EXPONENT[i] = 0;
  else if (i < 2) EXPONENT[i] = 1;
  else if (i < 4) EXPONENT[i] = 2;
  else if (i < 8) EXPONENT[i] = 3;
  else if (i < 16) EXPONENT[i] = 4;
  else if (i < 32) EXPONENT[i] = 5;
  else if (i < 64) EXPONENT[i] = 6;
  else EXPONENT[i] = 7;
}

function encodeSample(sample: number): number {
  let sign = (sample >> 8) & 0x80;
  if (sign !== 0) sample = -sample;
  if (sample > MULAW_CLIP) sample = MULAW_CLIP;
  sample += MULAW_BIAS;

  const exponent = EXPONENT[(sample >> 7) & 0xff]!;
  const mantissa = (sample >> (exponent + 3)) & 0x0f;
  return ~(sign | (exponent << 4) | mantissa) & 0xff;
}

/** Signed 16-bit little-endian PCM at 8 kHz → μ-law. */
export function pcm16ToMulaw(pcm: Buffer): Buffer {
  const out = Buffer.allocUnsafe(pcm.length >> 1);
  for (let i = 0, j = 0; i + 1 < pcm.length; i += 2, j++) {
    out[j] = encodeSample(pcm.readInt16LE(i));
  }
  return out;
}

const MULAW_DECODE = new Int16Array(256);
for (let i = 0; i < 256; i++) {
  const inv = ~i & 0xff;
  const sign = inv & 0x80;
  const exponent = (inv >> 4) & 0x07;
  const mantissa = inv & 0x0f;
  let sample = ((mantissa << 3) + MULAW_BIAS) << exponent;
  sample -= MULAW_BIAS;
  MULAW_DECODE[i] = sign !== 0 ? -sample : sample;
}

/** μ-law → signed 16-bit little-endian PCM. Needed to feed the ASR. */
export function mulawToPcm16(mulaw: Buffer): Buffer {
  const out = Buffer.allocUnsafe(mulaw.length * 2);
  for (let i = 0; i < mulaw.length; i++) {
    out.writeInt16LE(MULAW_DECODE[mulaw[i]!]!, i * 2);
  }
  return out;
}

/**
 * Strip a RIFF/WAVE header and return the raw sample data.
 * Providers vary in how many chunks they put before `data` (LIST, fact, …),
 * so walk the chunk table rather than assuming the classic 44-byte header.
 */
export function pcmFromWav(wav: Buffer): Buffer {
  if (wav.length < 12 || wav.toString("ascii", 0, 4) !== "RIFF") {
    // Not a WAV — assume the provider already gave us raw PCM.
    return wav;
  }
  let offset = 12;
  while (offset + 8 <= wav.length) {
    const id = wav.toString("ascii", offset, offset + 4);
    const size = wav.readUInt32LE(offset + 4);
    if (id === "data") {
      return wav.subarray(offset + 8, Math.min(offset + 8 + size, wav.length));
    }
    offset += 8 + size + (size % 2); // chunks are word-aligned
  }
  throw new Error("WAV had no data chunk");
}

/** Split μ-law bytes into exact 20 ms frames, zero-padding the tail. */
export function toFrames(mulaw: Buffer): Buffer[] {
  const frames: Buffer[] = [];
  for (let i = 0; i < mulaw.length; i += FRAME_BYTES) {
    const slice = mulaw.subarray(i, i + FRAME_BYTES);
    if (slice.length === FRAME_BYTES) {
      frames.push(slice);
    } else {
      // μ-law silence is 0xFF, not 0x00.
      const padded = Buffer.alloc(FRAME_BYTES, 0xff);
      slice.copy(padded);
      frames.push(padded);
    }
  }
  return frames;
}
