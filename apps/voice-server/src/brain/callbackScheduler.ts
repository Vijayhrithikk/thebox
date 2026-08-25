import { randomUUID } from "node:crypto";
import { resolveCallbackTime } from "./callbackResolver.js";
import type { LLMProvider } from "./providers/types.js";
import { placeCall, getCallerNumber } from "../telephony/index.js";

/**
 * Turns a resolved callback time into an actual future call — the part of
 * the brief that makes this more than a note ("call me back tomorrow" has
 * to result in the phone actually ringing tomorrow, not just a logged
 * intention). In-process only: a `setTimeout` per scheduled callback, keyed
 * by a fresh id, held in memory for the life of this server process. See
 * telephony/index.ts's `callerNumbers` map for the same "not persisted yet"
 * caveat — both need Postgres before this survives a restart or scales past
 * one process, which is exactly what DATABASE_URL is reserved for.
 */
export interface ScheduledCallback {
  originalSessionId: string;
  to: string;
  at: Date;
}

const scheduled = new Map<string, ScheduledCallback>();

/** Node's setTimeout takes a 32-bit signed ms value — anything past ~24.8 days overflows and fires immediately, which would be worse than not scheduling at all. */
const MAX_DELAY_MS = 2 ** 31 - 1;

export async function scheduleCallbackFromSpeech(
  originalSessionId: string,
  spokenTime: string,
  provider: LLMProvider,
  log: (obj: unknown, msg: string) => void,
): Promise<void> {
  const resolution = await resolveCallbackTime(spokenTime, provider);
  if (!resolution.resolvable || !resolution.isoDatetime) {
    log({ originalSessionId, spokenTime, resolution }, "callback phrase unresolvable — not scheduled");
    return;
  }

  const to = getCallerNumber(originalSessionId);
  if (!to) {
    log({ originalSessionId, spokenTime }, "callback requested but no caller number on file — cannot schedule");
    return;
  }

  const at = new Date(resolution.isoDatetime);
  const delayMs = at.getTime() - Date.now();

  if (delayMs <= 0) {
    log({ originalSessionId, spokenTime, at }, "resolved callback time is already in the past — not scheduled");
    return;
  }
  if (delayMs > MAX_DELAY_MS) {
    log({ originalSessionId, spokenTime, at }, "resolved callback time is too far out for this in-process scheduler — not scheduled");
    return;
  }

  const callbackId = randomUUID();
  scheduled.set(callbackId, { originalSessionId, to, at });

  setTimeout(() => {
    scheduled.delete(callbackId);
    log({ originalSessionId, to, at }, "firing scheduled callback");
    placeCall({ to, sessionId: randomUUID() }).catch((err) => {
      log({ err, originalSessionId, to }, "scheduled callback failed to place");
    });
  }, delayMs);

  log({ originalSessionId, to, at, confidence: resolution.confidence }, "callback scheduled");
}

/** For the eventual console view — what's currently queued, in memory, right now. */
export function listScheduledCallbacks(): ScheduledCallback[] {
  return [...scheduled.values()];
}
