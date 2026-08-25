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
 * DeepSeek V4 Pro over its OpenAI-compatible endpoint.
 *
 * `reasoning_effort` is the DeepSeek analogue of Claude's `effort`, but the
 * latency curve is not comparable: at "high"/"max" the flagship model has
 * been independently benchmarked at 12-30 SECONDS to first answer token —
 * completely disqualifying for a live phone call, where >1.2s already
 * breaks the conversation per the brief. This provider hard-codes "low"
 * (DeepSeek's non-thinking mode) for every in-call turn regardless of what
 * DEEPSEEK_REASONING_EFFORT is set to elsewhere, and only honours a higher
 * setting when explicitly asked for an offline/post-call composition via
 * `forceReasoningEffort`. Getting this wrong doesn't degrade gracefully —
 * it silently turns every turn into a 15+ second dead-air hang.
 */
export class DeepSeekProvider implements LLMProvider {
  readonly name = "deepseek";

  constructor(private readonly forceReasoningEffort?: "low" | "high" | "max") {}

  async streamTurn(params: StreamTurnParams): Promise<StreamTurnResult> {
    const { systemPrompt, history, tools, onSentence, signal } = params;
    const effort = this.forceReasoningEffort ?? "low";

    const stream = await client.chat.completions.create(
      {
        model: env.DEEPSEEK_MODEL,
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
