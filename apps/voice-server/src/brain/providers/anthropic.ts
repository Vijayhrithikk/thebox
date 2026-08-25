import Anthropic from "@anthropic-ai/sdk";
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

const client = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY! });

/**
 * Claude Opus 5 in fast mode with adaptive thinking at low effort.
 *
 * Never `thinking:{type:"disabled"}` — on Opus 5 that can leak a tool call
 * as plain visible text instead of a real tool_use block, which here would
 * mean the WhatsApp silently never fires. Low-effort adaptive thinking closes
 * that hole and is barely slower.
 */
export class AnthropicProvider implements LLMProvider {
  readonly name = "anthropic";

  async streamTurn(params: StreamTurnParams): Promise<StreamTurnResult> {
    const { systemPrompt, history, tools, onSentence, signal } = params;

    const stream = client.beta.messages.stream(
      {
        model: env.LLM_MODEL,
        max_tokens: 1024,
        speed: "fast",
        betas: ["fast-mode-2026-02-01"],
        thinking: { type: "adaptive" },
        output_config: { effort: "low" },
        system: [{ type: "text", text: systemPrompt, cache_control: { type: "ephemeral" } }],
        tools: tools.map(toAnthropicTool),
        messages: toAnthropicMessages(history),
      },
      { signal },
    );

    let buffer = "";
    let fullText = "";
    const toolCalls: StreamTurnResult["toolCalls"] = [];

    let currentText = "";
    let currentToolId = "";
    let currentToolName = "";
    let currentToolJson = "";
    let currentBlockType: "text" | "tool_use" | "thinking" | null = null;

    stream.on("streamEvent", (event) => {
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
          fullText += event.delta.text;
          const { ready, buffer: rest } = chunkOnSentence(buffer, event.delta.text);
          buffer = rest;
          if (ready.trim()) onSentence(ready.trim());
        } else if (event.delta.type === "input_json_delta") {
          currentToolJson += event.delta.partial_json;
        }
      } else if (event.type === "content_block_stop") {
        if (currentBlockType === "tool_use") {
          let input: unknown = {};
          try {
            input = currentToolJson ? JSON.parse(currentToolJson) : {};
          } catch {
            /* malformed tool JSON — dispatch with empty input rather than crash the call */
          }
          toolCalls.push({ id: currentToolId, name: currentToolName, input });
        }
        currentText = "";
        currentBlockType = null;
      }
    });

    const final = await stream.finalMessage();
    if (buffer.trim()) onSentence(buffer.trim());

    return { text: fullText, toolCalls, stopReason: mapStopReason(final.stop_reason) };
  }
}

function mapStopReason(reason: string | null): StopReason {
  switch (reason) {
    case "tool_use":
      return "tool_use";
    case "refusal":
      return "refusal";
    case "max_tokens":
      return "max_tokens";
    default:
      return "end_turn";
  }
}

function toAnthropicTool(spec: ToolSpec): Anthropic.Tool {
  return {
    name: spec.name,
    description: spec.description,
    input_schema: spec.inputSchema as Anthropic.Tool.InputSchema,
  };
}

/**
 * Anthropic wants tool results as `tool_result` content blocks inside a
 * `role:"user"` message, and mid-conversation operator context as a genuine
 * `role:"system"` message (a Claude Opus 5 feature — the SDK's type is
 * stricter than the wire protocol, hence the cast).
 */
function toAnthropicMessages(history: Turn[]): Anthropic.MessageParam[] {
  const messages: Anthropic.MessageParam[] = [];

  for (const turn of history) {
    if (turn.role === "system") {
      messages.push({
        role: "system" as Anthropic.MessageParam["role"],
        content: turn.text ?? "",
      });
      continue;
    }

    if (turn.toolResults && turn.toolResults.length > 0) {
      messages.push({
        role: "user",
        content: turn.toolResults.map((r) => ({
          type: "tool_result" as const,
          tool_use_id: r.id,
          content: r.output,
        })),
      });
      continue;
    }

    if (turn.role === "assistant" && turn.toolCalls && turn.toolCalls.length > 0) {
      const content: Anthropic.ContentBlockParam[] = [];
      if (turn.text) content.push({ type: "text", text: turn.text });
      for (const tc of turn.toolCalls) {
        content.push({ type: "tool_use", id: tc.id, name: tc.name, input: tc.input as Record<string, unknown> });
      }
      messages.push({ role: "assistant", content });
      continue;
    }

    messages.push({ role: turn.role as "user" | "assistant", content: turn.text ?? "" });
  }

  return messages;
}
