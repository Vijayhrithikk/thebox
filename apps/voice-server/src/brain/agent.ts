import { buildSystemPrompt } from "./prompt.js";
import type { LLMProvider, StopReason, Turn } from "./providers/types.js";

export type { StopReason } from "./providers/types.js";

/**
 * One conversation's worth of state, provider-agnostic.
 *
 * Deliberately never sends tools on the live path. Measured live (not
 * assumed): the moment a turn includes tool schemas, both DeepSeek V4 Pro
 * and V4 Flash produce a tool-only response with zero spoken text, forcing
 * a second sequential API round trip before any audio can start — 6.4s and
 * 3.6s to first sentence respectively, both well past the "three seconds
 * and the conversation is dead" bar from the brief. A prompt instruction
 * asking the model to speak *and* call tools in the same turn had no
 * effect — this is how the API's tool-calling shape behaves, not a
 * preference a system prompt can override.
 *
 * So the live agent's only job is to talk: exactly one streamTurn call per
 * turn, tools always empty, guaranteeing first-sentence latency is bounded
 * by one model call, not two. Classification, discovery notes, and
 * callback scheduling all happen in signalExtractor.ts instead — a
 * parallel side-channel that reads the same transcript but never blocks
 * the spoken reply. See PROGRESS.md decisions table for the measured
 * before/after.
 */
export class Agent {
  private history: Turn[] = [];
  private readonly systemPrompt = buildSystemPrompt();
  private currentAbort: AbortController | null = null;

  constructor(private readonly provider: LLMProvider) {}

  /**
   * Called on barge-in. Aborts the in-flight request so we stop generating
   * text nobody is going to hear, rather than silently keeping a stream open
   * (and paying for it) after the audio has already been cut.
   */
  interrupt(): void {
    this.currentAbort?.abort();
  }

  /** Injects live call state (elapsed time, "WhatsApp already sent") without touching the cached system prompt. */
  injectSystemNote(text: string): void {
    this.history.push({ role: "system", text });
  }

  /** Sends the caller's turn, streams the reply sentence-by-sentence via onSentence, returns why it stopped. */
  async respond(userText: string, onSentence: (text: string) => void): Promise<StopReason> {
    this.history.push({ role: "user", text: userText });
    this.currentAbort = new AbortController();

    try {
      const result = await this.provider.streamTurn({
        systemPrompt: this.systemPrompt,
        history: this.history,
        tools: [],
        onSentence,
        signal: this.currentAbort.signal,
      });
      this.history.push({ role: "assistant", text: result.text });
      return result.stopReason;
    } catch (err) {
      if (isAbortError(err)) return "interrupted";
      throw err;
    } finally {
      this.currentAbort = null;
    }
  }
}

function isAbortError(err: unknown): boolean {
  return err instanceof Error && (err.name === "AbortError" || /aborted?/i.test(err.message));
}
