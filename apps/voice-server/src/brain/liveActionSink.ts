import type { ActionSink, ClassifyInput, NoteDiscoveryInput, RequestCallbackInput } from "./tools.js";
import { scheduleCallbackFromSpeech } from "./callbackScheduler.js";
import type { LLMProvider } from "./providers/types.js";

/**
 * Phase 4's real action sink. `request_callback` now actually schedules a
 * re-dial (see callbackScheduler.ts) instead of just being logged.
 * `classify_lead`'s real mid-call dispatch — the WhatsApp send that has to
 * land while the call is still live — still only logs; wiring the real
 * send is blocked on picking a WhatsApp transport (web-session vs Cloud
 * API), see PROGRESS.md and docs/SETUP.md for the open decision.
 */
export class LiveActionSink implements ActionSink {
  constructor(
    private readonly sessionId: string,
    private readonly provider: LLMProvider,
    private readonly log: (obj: unknown, msg: string) => void,
  ) {}

  onClassify(input: ClassifyInput): void {
    this.log(input, `[classify:${input.source ?? "llm"}] ${input.classification}`);
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
