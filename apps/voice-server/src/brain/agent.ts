import { buildSystemPrompt } from "./prompt.js";
import { toolDefinitions, handleToolCall, type ActionSink } from "./tools.js";
import type { LLMProvider, StopReason, Turn } from "./providers/types.js";

const MAX_TOOL_ROUNDTRIPS = 4;

export type { StopReason } from "./providers/types.js";

/**
 * One conversation's worth of state, provider-agnostic.
 *
 * This class owns *only* the turn loop, tool dispatch, and barge-in abort —
 * nothing here knows whether it's talking to Claude or DeepSeek. That split
 * is deliberate: which model answers is a config choice (LLM_PROVIDER), not
 * an architecture choice, so swapping providers touches zero lines here.
 */
export class Agent {
  private history: Turn[] = [];
  private readonly systemPrompt = buildSystemPrompt();
  private currentAbort: AbortController | null = null;

  constructor(
    private readonly provider: LLMProvider,
    private readonly sink: ActionSink,
  ) {}

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

  /**
   * Runs one full exchange: sends the caller's turn, streams the reply
   * sentence-by-sentence via onSentence, transparently resolves any tool
   * calls, and keeps looping until the model actually stops talking.
   */
  async respond(userText: string, onSentence: (text: string) => void): Promise<StopReason> {
    this.history.push({ role: "user", text: userText });

    for (let round = 0; round < MAX_TOOL_ROUNDTRIPS; round++) {
      this.currentAbort = new AbortController();
      let result: Awaited<ReturnType<LLMProvider["streamTurn"]>>;
      try {
        result = await this.provider.streamTurn({
          systemPrompt: this.systemPrompt,
          history: this.history,
          tools: toolDefinitions,
          onSentence,
          signal: this.currentAbort.signal,
        });
      } catch (err) {
        if (isAbortError(err)) return "interrupted";
        throw err;
      } finally {
        this.currentAbort = null;
      }

      this.history.push({ role: "assistant", text: result.text, toolCalls: result.toolCalls });

      if (result.stopReason !== "tool_use") {
        return result.stopReason;
      }

      // Fire-and-forget: the sink dispatches real side effects async and we
      // hand back an immediate ack, so this round-trip is model-API-only
      // latency — never the WhatsApp/DB call's latency.
      this.history.push({
        role: "user",
        toolResults: result.toolCalls.map((tc) => ({
          id: tc.id,
          output: handleToolCall(tc.name, tc.input, this.sink),
        })),
      });
    }

    return "end_turn";
  }
}

function isAbortError(err: unknown): boolean {
  return err instanceof Error && (err.name === "AbortError" || /aborted?/i.test(err.message));
}
