/**
 * Trigger an outbound call from the terminal.
 *
 *   pnpm call              → dials TEST_PHONE (your own second number)
 *   pnpm call --prospect   → dials PROSPECT_PHONE (the recruiter). Deliberately
 *                            requires the flag so no rehearsal can hit him by accident.
 */
import { randomUUID } from "node:crypto";
import { env } from "../config.js";
import { placeCall } from "../telephony/index.js";

const wantsProspect = process.argv.includes("--prospect");
const explicit = process.argv.find((a) => a.startsWith("+"));

const to = explicit ?? (wantsProspect ? env.PROSPECT_PHONE : env.TEST_PHONE);

if (!to) {
  console.error("No destination. Set TEST_PHONE in .env, pass a +E.164 number, or use --prospect.");
  process.exit(1);
}

if (to === env.PROSPECT_PHONE && !wantsProspect) {
  console.error("Refusing to dial the prospect without --prospect.");
  process.exit(1);
}

const sessionId = randomUUID();
console.log(`Dialling ${to} via ${env.TELEPHONY_PROVIDER}  (session ${sessionId})`);

const call = await placeCall({ to, sessionId });
// Twilio and Telnyx return different shapes (call.sid/call.status vs
// call_control_id/call_leg_id) — dump the whole thing rather than assuming one.
console.log("Call queued:", call);
