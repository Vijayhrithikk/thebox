import Anthropic from "@anthropic-ai/sdk";
import { env } from "../config.js";
import { buildSystemPrompt } from "./prompt.js";
import { toolDefinitions, handleToolCall, type ActionSink } from "./tools.js";

const client = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY! });

/** Sentence/clause boundary — Telugu and Hindi both use these plus ASCII punctuation. */
const CHUNK_BOUNDARY = /([.!?।॥\n])/;

const MAX_TOOL_ROUNDTRIPS = 4;

export type StopReason = "end_turn" | "refusal" | "max_tokens" | "error" | "interrupted";

/**
 * One conversation's worth of state and the Opus 5 wiring around it.
 *
 * Everything here optimizes for one number: time from "caller stops talking"
 * to "first audible syllable of the reply". Three choices do that work:
 *
 *   1. Fast mode (`speed:"fast"`) — up to 2.5x output tokens/sec.
 *   2. Adaptive thinking at LOW effort, never `thinking:{type:"disabled"}` —
 *      disabling thinking on Opus 5 can leak a tool call as plain visible
 *      text instead of a real tool_use block. In this build that means the
 *      WhatsApp silently never fires, with no error to catch. Low-effort
 *      adaptive thinking is barely slower and closes that hole entirely.
 *   3. Sentence-level streaming — `onSentence` fires the moment a clause
 *      boundary appears in the stream, so TTS starts on the first sentence
 *      while Claude is still generating the second.
 */
export class Agent {
  private history: Anthropic.MessageParam[] = [];
  private readonly systemPrompt = buildSystemPrompt();
  private currentAbort: AbortController | null = null;

  constructor(private readonly sink: ActionSink) {}

  /**
   * Called on barge-in. Aborts the in-flight Claude request so we stop
   * generating text nobody is going to hear, rather than silently keeping
   * a stream open (and paying for it) after the audio has already been cut.
   */
  interrupt(): void {
    this.currentAbort?.abort();
  }

  /** Injects live call state (elapsed time, "WhatsApp already sent") without touching the cached system prompt. */
  injectSystemNote(text: string): void {
    this.history.push({ role: "system" as Anthropic.MessageParam["role"], content: text });
  }

  /**
   * Runs one full exchange: sends the caller's turn, streams the reply
   * sentence-by-sentence via onSentence, transparently resolves any tool
   * calls, and keeps looping until Claude actually stops talking.
   */
  async respond(
    userText: string,
    onSentence: (text: string) => void | Promise<void>,
  ): Promise<StopReason> {
    this.history.push({ role: "user", content: userText });

    for (let round = 0; round < MAX_TOOL_ROUNDTRIPS; round++) {
      this.currentAbort = new AbortController();
      let outcome: Awaited<ReturnType<typeof this.streamOneTurn>>;
      try {
        outcome = await this.streamOneTurn(onSentence, this.currentAbort.signal);
      } catch (err) {
        if (isAbortError(err)) return "interrupted";
        throw err;
      } finally {
        this.currentAbort = null;
      }
      const { assistantContent, toolUses, stopReason } = outcome;
      this.history.push({ role: "assistant", content: assistantContent });

      if (stopReason !== "tool_use") {
        return stopReason === "refusal" ? "refusal" : stopReason === "max_tokens" ? "max_tokens" : "end_turn";
      }

      // Fire-and-forget: the sink dispatches real side effects async and we
      // hand back an immediate ack, so this round-trip is Claude-API-only
      // latency — never the WhatsApp/DB call's latency.
      const toolResults: Anthropic.ToolResultBlockParam[] = toolUses.map((tu) => ({
        type: "tool_result",
        tool_use_id: tu.id,
        content: handleToolCall(tu.name, tu.input, this.sink),
      }));
      this.history.push({ role: "user", content: toolResults });
    }

    return "end_turn";
  }

  private async streamOneTurn(
    onSentence: (text: string) => void | Promise<void>,
    signal: AbortSignal,
  ): Promise<{
    assistantContent: Anthropic.ContentBlockParam[];
    toolUses: { id: string; name: string; input: unknown }[];
    stopReason: string;
  }> {
    const stream = client.beta.messages.stream({
      model: env.LLM_MODEL,
      max_tokens: 1024,
      speed: "fast",
      betas: ["fast-mode-2026-02-01"],
      thinking: { type: "adaptive" },
      output_config: { effort: "low" },
      system: [{ type: "text", text: this.systemPrompt, cache_control: { type: "ephemeral" } }],
      tools: toolDefinitions,
      messages: this.history,
    }, { signal });

    let buffer = "";
    const assistantContent: Anthropic.ContentBlockParam[] = [];
    const toolUses: { id: string; name: string; input: unknown }[] = [];

    let currentText = "";
    let currentToolId = "";
    let currentToolName = "";
    let currentToolJson = "";
    let currentBlockType: "text" | "tool_use" | "thinking" | null = null;

    stream.on("streamEvent", async (event) => {
      if (event.type === "content_block_start") {
        currentBlockType = event.content_block.type as typeof currentBlockType;
        if (event.content_block.type === "tool_use") {
          currentToolId = event.content_block.id;
          currentToolName = event.content_block.name;
          currentToolJson = "";
        }
      } else if (event.type === "content_block_delta") {
        if (event.delta.type === "text_delta") {
          currentText += event.delta.text;
          buffer += event.delta.text;
          const parts = buffer.split(CHUNK_BOUNDARY);
          // Odd-indexed elements are the boundary punctuation itself; a
          // complete sentence is a (text, punctuation) pair, so consume in
          // twos and leave any trailing partial fragment in the buffer.
          let ready = "";
          let i = 0;
          while (i + 1 < parts.length) {
            ready += (parts[i] ?? "") + (parts[i + 1] ?? "");
            i += 2;
          }
          buffer = parts.slice(i).join("");
          if (ready.trim()) await onSentence(ready.trim());
        } else if (event.delta.type === "input_json_delta") {
          currentToolJson += event.delta.partial_json;
        }
      } else if (event.type === "content_block_stop") {
        if (currentBlockType === "text") {
          assistantContent.push({ type: "text", text: currentText });
          currentText = "";
        } else if (currentBlockType === "tool_use") {
          let input: unknown = {};
          try {
            input = currentToolJson ? JSON.parse(currentToolJson) : {};
          } catch {
            /* malformed tool JSON — dispatch with an empty input rather than crash the call */
          }
          assistantContent.push({ type: "tool_use", id: currentToolId, name: currentToolName, input });
          toolUses.push({ id: currentToolId, name: currentToolName, input });
        }
        currentBlockType = null;
      }
    });

    const final = await stream.finalMessage();
    if (buffer.trim()) await onSentence(buffer.trim());

    return { assistantContent, toolUses, stopReason: final.stop_reason ?? "end_turn" };
  }
}

function isAbortError(err: unknown): boolean {
  return (
    err instanceof Error &&
    (err.name === "AbortError" || /aborted?/i.test(err.message))
  );
}
