import OpenAI from "openai";
import type { ChatCompletionMessageParam, ChatCompletionChunk } from "openai/resources/chat/completions";
import { env } from "../../config.js";
import {
  chunkOnSentence,
  type LLMProvider,
  type StreamTurnParams,
  type StreamTurnResult,
  type StopReason,
  type Turn,
  type ToolSpec,
} from "./types.js";

const client = new OpenAI({
  apiKey: env.DEEPSEEK_API_KEY!,
  baseURL: "https://api.deepseek.com",
});

/**
 * DeepSeek over its OpenAI-compatible endpoint.
 *
 * Two latency guards, both found by live measurement, not assumption:
 *
 * 1. `reasoning_effort` is the DeepSeek analogue of Claude's `effort`, but
 *    the curve isn't comparable — at "high"/"max" the flagship has been
 *    independently benchmarked at 12-30s to first token. Hard-coded to
 *    "low" for every in-call turn regardless of what's configured
 *    elsewhere, overridable only via `forceReasoningEffort` for offline use.
 *
 * 2. The flagship (`deepseek-v4-pro`) is simply a much slower *model*, not
 *    just a slower setting — measured at ~10s to first token even for a
 *    plain conversational turn with zero tools involved, roughly 5x
 *    `deepseek-v4-flash` on the identical prompt. It also showed weaker
 *    tool-schema adherence in testing (inventing its own JSON keys instead
 *    of following the declared schema). So the live path is hard-coded to
 *    `deepseek-v4-flash` via `forceModel`, independent of `DEEPSEEK_MODEL`
 *    — that env var is reserved for the offline/deep-reasoning path
 *    (createDeepReasoningProvider), where v4-pro's slowness genuinely
 *    doesn't matter and its extra quality can help.
 */
export class DeepSeekProvider implements LLMProvider {
  readonly name = "deepseek";

  constructor(
    private readonly forceReasoningEffort?: "low" | "high" | "max",
    private readonly forceModel?: string,
  ) {}

  async streamTurn(params: StreamTurnParams): Promise<StreamTurnResult> {
    const { systemPrompt, history, tools, onSentence, signal } = params;
    const effort = this.forceReasoningEffort ?? "low";
    const model = this.forceModel ?? env.DEEPSEEK_MODEL;

    const stream = await client.chat.completions.create(
      {
        model,
        stream: true,
        messages: [{ role: "system", content: systemPrompt }, ...toOpenAiMessages(history)],
        tools: tools.length > 0 ? tools.map(toOpenAiTool) : undefined,
        // DeepSeek-specific — not in the openai SDK's request type, but the
        // API accepts unknown top-level fields per its documented extension pattern.
        ...({ reasoning_effort: effort } as Record<string, unknown>),
      },
      { signal },
    );

    let buffer = "";
    let fullText = "";
    let finishReason: string | null = null;

    // OpenAI-style tool_calls stream as fragments keyed by array index —
    // id/name arrive once on the first fragment for that index, arguments
    // trickle in afterward and must be concatenated before parsing.
    const toolFragments = new Map<number, { id: string; name: string; args: string }>();

    for await (const chunk of stream as AsyncIterable<ChatCompletionChunk>) {
      const choice = chunk.choices[0];
      if (!choice) continue;

      if (choice.finish_reason) finishReason = choice.finish_reason;

      const delta = choice.delta;
      if (delta?.content) {
        fullText += delta.content;
        const { ready, buffer: rest } = chunkOnSentence(buffer, delta.content);
        buffer = rest;
        if (ready.trim()) onSentence(ready.trim());
      }

      if (delta?.tool_calls) {
        for (const tc of delta.tool_calls) {
          const existing = toolFragments.get(tc.index);
          if (existing) {
            existing.args += tc.function?.arguments ?? "";
          } else {
            toolFragments.set(tc.index, {
              id: tc.id ?? "",
              name: tc.function?.name ?? "",
              args: tc.function?.arguments ?? "",
            });
          }
        }
      }
    }

    if (buffer.trim()) onSentence(buffer.trim());

    const toolCalls: StreamTurnResult["toolCalls"] = [];
    for (const frag of toolFragments.values()) {
      let input: unknown = {};
      try {
        input = frag.args ? JSON.parse(frag.args) : {};
      } catch {
        /* malformed tool JSON — dispatch with empty input rather than crash the call */
      }
      toolCalls.push({ id: frag.id, name: frag.name, input });
    }

    return { text: fullText, toolCalls, stopReason: mapFinishReason(finishReason) };
  }
}

function mapFinishReason(reason: string | null): StopReason {
  switch (reason) {
    case "tool_calls":
      return "tool_use";
    case "content_filter":
      return "refusal";
    case "length":
      return "max_tokens";
    default:
      return "end_turn";
  }
}

function toOpenAiTool(spec: ToolSpec): OpenAI.Chat.ChatCompletionTool {
  return {
    type: "function",
    function: {
      name: spec.name,
      description: spec.description,
      parameters: spec.inputSchema,
    },
  };
}

/**
 * OpenAI-compatible chat wants tool results as standalone `role:"tool"`
 * messages (one per result, keyed by tool_call_id) rather than Anthropic's
 * content-block-inside-a-user-message layout — same neutral Turn history,
 * different wire shape.
 */
function toOpenAiMessages(history: Turn[]): ChatCompletionMessageParam[] {
  const messages: ChatCompletionMessageParam[] = [];

  for (const turn of history) {
    if (turn.role === "system") {
      messages.push({ role: "system", content: turn.text ?? "" });
      continue;
    }

    if (turn.toolResults && turn.toolResults.length > 0) {
      for (const r of turn.toolResults) {
        messages.push({ role: "tool", tool_call_id: r.id, content: r.output });
      }
      continue;
    }

    if (turn.role === "assistant" && turn.toolCalls && turn.toolCalls.length > 0) {
      messages.push({
        role: "assistant",
        content: turn.text || null,
        tool_calls: turn.toolCalls.map((tc) => ({
          id: tc.id,
          type: "function" as const,
          function: { name: tc.name, arguments: JSON.stringify(tc.input) },
        })),
      });
      continue;
    }

    messages.push({ role: turn.role as "user" | "assistant", content: turn.text ?? "" });
  }

  return messages;
}
