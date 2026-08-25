/**
 * Offline callback-resolver check — no phone call, no Twilio/Soniox spend.
 * Same purpose as `pnpm say` / `pnpm chat`: prove the piece works against
 * real credentials before it's wired into the live call path.
 *
 *   pnpm schedule "tomorrow morning"
 *   pnpm schedule "after Diwali"
 *   pnpm schedule "sometime, I'll let you know"
 */
import { resolveCallbackTime } from "../brain/callbackResolver.js";
import { createLiveProvider } from "../brain/providers/index.js";

const phrase = process.argv[2] ?? "tomorrow morning";
console.log(`phrase: "${phrase}"\n`);

const startedAt = performance.now();
const result = await resolveCallbackTime(phrase, createLiveProvider());
const ms = Math.round(performance.now() - startedAt);

console.log(JSON.stringify(result, null, 2));
console.log(`\n${ms}ms`);
