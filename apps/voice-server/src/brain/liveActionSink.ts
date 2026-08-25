import type { ActionSink, ClassifyInput, NoteDiscoveryInput, RequestCallbackInput } from "./tools.js";
import { scheduleCallbackFromSpeech } from "./callbackScheduler.js";
import { sendWhatsApp } from "../actions/whatsapp.js";
import { getCallerNumber } from "../telephony/index.js";
import { env } from "../config.js";
import type { LLMProvider } from "./providers/types.js";

/**
 * Phase 4's real action sink. `request_callback` actually schedules a
 * re-dial (see callbackScheduler.ts); `classify_lead` on a HOT verdict
 * actually sends a WhatsApp to the caller's own number — the message that
 * has to land while the call is still live, the whole point of doing this
 * mid-call rather than after hanging up. `dedupeHotClassification` (see
 * tools.ts) guarantees this only ever fires once per call even though two
 * independent paths (LLM + signalScorer.ts) can both call onClassify("hot").
 */
export class LiveActionSink implements ActionSink {
  constructor(
    private readonly sessionId: string,
    private readonly provider: LLMProvider,
    private readonly log: (obj: unknown, msg: string) => void,
  ) {}

  onClassify(input: ClassifyInput): void {
    this.log(input, `[classify:${input.source ?? "llm"}] ${input.classification}`);

    if (input.classification !== "hot") return;

    const to = getCallerNumber(this.sessionId);
    if (!to) {
      this.log({ sessionId: this.sessionId }, "hot lead but no caller number on file — WhatsApp not sent");
      return;
    }

    void sendWhatsApp(to, buildHotLeadMessage(input.evidence), this.log);
  }

  onDiscovery(input: NoteDiscoveryInput): void {
    this.log(input, `[discovery] ${input.slot}`);
  }

  onCallbackRequested(input: RequestCallbackInput): void {
    this.log(input, `[callback] "${input.spoken_time}"`);
    void scheduleCallbackFromSpeech(this.sessionId, input.spoken_time, this.provider, this.log).catch((err) => {
      this.log({ err }, "callback scheduling failed");
    });
  }
}

/**
 * The mid-call message — immediate, short, sent the instant intent is
 * read as HOT. Deliberately not the rich, fully personalized follow-up
 * (with resume + architecture image + full conversational context) that
 * fires after the call ends — that one has a whole call transcript to draw
 * on and no latency pressure. This one has to exist the moment a live tool
 * call resolves, so it's a template filled with what's already known
 * (the name, number, and the exact thing the caller said that triggered
 * this), not an LLM composition.
 */
function buildHotLeadMessage(evidence: string): string {
  const name = env.CANDIDATE_NAME || "our team";
  const number = env.CANDIDATE_PHONE || "";
  return (
    `Hi! Great talking to you just now — you mentioned "${evidence}", so I wanted to get this to you ` +
    `right away. ${name} will follow up shortly with everything on building your e-commerce website. ` +
    (number ? `Feel free to reach out directly at ${number} anytime.` : "")
  ).trim();
}
