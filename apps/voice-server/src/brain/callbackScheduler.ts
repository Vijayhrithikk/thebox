import { randomUUID } from "node:crypto";
import { resolveCallbackTime } from "./callbackResolver.js";
import type { LLMProvider } from "./providers/types.js";
import { placeCall } from "../telephony/index.js";

/**
 * Turns a resolved callback time into an actual future call — the part of
 * the brief that makes this more than a note ("call me back tomorrow" has
 * to result in the phone actually ringing tomorrow, not just a logged
 * intention). In-process only: a `setTimeout` per scheduled callback, keyed
 * by a fresh id, held in memory for the life of this server process — needs
 * Postgres before this survives a restart or scales past one process, which
 * is exactly what DATABASE_URL is reserved for.
 *
 * Takes the destination number directly rather than looking it up from a
 * sessionId — telephony/index.ts's sessionId->number map only gets
 * populated by calls this process places itself, and once Sarvam's voice
 * agent is placing the primary call (see webhooks in server.ts), that map
 * is empty for calls it originates. The re-dial itself still goes through
 * our own Exotel adapter (placeCall below), not Sarvam — Sarvam's outbound
 * calling is portal/campaign-driven with no API found yet for placing one
 * ad-hoc call, so the callback re-dial keeps using the pipeline we already
 * have working rather than blocking on that.
 */
export interface ScheduledCallback {
  to: string;
  at: Date;
}

const scheduled = new Map<string, ScheduledCallback>();

/** Node's setTimeout takes a 32-bit signed ms value — anything past ~24.8 days overflows and fires immediately, which would be worse than not scheduling at all. */
const MAX_DELAY_MS = 2 ** 31 - 1;

export async function scheduleCallbackFromSpeech(
  to: string,
  spokenTime: string,
  provider: LLMProvider,
  log: (obj: unknown, msg: string) => void,
): Promise<void> {
  const resolution = await resolveCallbackTime(spokenTime, provider);
  if (!resolution.resolvable || !resolution.isoDatetime) {
    log({ to, spokenTime, resolution }, "callback phrase unresolvable — not scheduled");
    return;
  }

  const at = new Date(resolution.isoDatetime);
  const delayMs = at.getTime() - Date.now();

  if (delayMs <= 0) {
    log({ to, spokenTime, at }, "resolved callback time is already in the past — not scheduled");
    return;
  }
  if (delayMs > MAX_DELAY_MS) {
    log({ to, spokenTime, at }, "resolved callback time is too far out for this in-process scheduler — not scheduled");
    return;
  }

  const callbackId = randomUUID();
  scheduled.set(callbackId, { to, at });

  setTimeout(() => {
    scheduled.delete(callbackId);
    log({ to, at }, "firing scheduled callback");
    placeCall({ to, sessionId: randomUUID() }).catch((err) => {
      log({ err, to }, "scheduled callback failed to place");
    });
  }, delayMs);

  log({ to, at, confidence: resolution.confidence }, "callback scheduled");
}

/** For the eventual console view — what's currently queued, in memory, right now. */
export function listScheduledCallbacks(): ScheduledCallback[] {
  return [...scheduled.values()];
}
