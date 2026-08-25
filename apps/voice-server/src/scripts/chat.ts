/**
 * Offline brain check — no phone call, no Twilio/Soniox spend.
 * Exercises the real Agent (pure conversation, no tools) and the parallel
 * signalExtractor (classification/discovery/callback) against whichever
 * LLM_PROVIDER is configured, side by side, so the two latencies that
 * matter are both visible: first spoken sentence, and how long extraction
 * takes to catch up in the background.
 *
 *   pnpm chat "నా బడ్జెట్ ఇరవై వేలు, వచ్చే నెలలో కావాలి"
 *   pnpm chat                       # uses a built-in Telugu sample turn
 */
import { Agent } from "../brain/agent.js";
import { ConsoleActionSink } from "../brain/tools.js";
import { extractSignals } from "../brain/signalExtractor.js";
import { createLiveProvider } from "../brain/providers/index.js";
import { env } from "../config.js";

const utterance =
  process.argv[2] ??
  "నా బడ్జెట్ ఇరవై వేలు, వచ్చే నెలలో కావాలి, మా shop లో బట్టలు అమ్ముతాము";

console.log(`provider=${env.LLM_PROVIDER}\nuser: ${utterance}\n`);

const sink = new ConsoleActionSink((obj, msg) => console.log(`  ${msg}`, JSON.stringify(obj)));
const startedAt = performance.now();

const extraction = extractSignals(utterance, createLiveProvider(), sink).then(
  () => console.log(`  [extraction done at ${Math.round(performance.now() - startedAt)}ms]`),
);

const agent = new Agent(createLiveProvider());
let firstSentenceMs = 0;

const stopReason = await agent.respond(utterance, (sentence) => {
  if (!firstSentenceMs) firstSentenceMs = Math.round(performance.now() - startedAt);
  console.log(`agent: ${sentence}`);
});

console.log(
  `\nstopReason=${stopReason}  firstSentence=${firstSentenceMs}ms  totalReply=${Math.round(performance.now() - startedAt)}ms`,
);

await extraction; // let the background extraction finish printing before the script exits
