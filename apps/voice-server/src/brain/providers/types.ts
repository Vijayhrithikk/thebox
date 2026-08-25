/**
 * Provider-agnostic shapes that Agent (the turn-taking/barge-in/tool-loop
 * orchestrator) speaks, so it never touches an Anthropic- or OpenAI-shaped
 * object directly. Each concrete provider owns translating this into (and
 * out of) its own wire format — that's the entire cost of adding a new one.
 */

export type Role = "user" | "assistant" | "system";

export interface ToolCall {
  id: string;
  name: string;
  input: unknown;
}

export interface ToolResult {
  id: string;
  output: string;
}

/**
 * One turn in the conversation. Deliberately not a 1:1 mirror of either
 * provider's message shape — `toolCalls` and `toolResults` are separate
 * fields (not text) because Anthropic wants them as content blocks inside a
 * message while OpenAI-compatible APIs want a `tool_calls` array plus one
 * standalone `role:"tool"` message per result. Each provider decides that
 * layout; Agent just accumulates history in this neutral form.
 */
export interface Turn {
  role: Role;
  text?: string;
  toolCalls?: ToolCall[];
  toolResults?: ToolResult[];
}

export interface ToolSpec {
  name: string;
  description: string;
  /** Plain JSON Schema — both providers accept this shape, just nested differently in the request. */
  inputSchema: Record<string, unknown>;
}

export type StopReason = "end_turn" | "tool_use" | "refusal" | "max_tokens" | "error" | "interrupted";

export interface StreamTurnParams {
  systemPrompt: string;
  history: Turn[];
  tools: ToolSpec[];
  /** Fired the instant a sentence/clause boundary appears in the stream — this is what makes TTS start early. */
  onSentence: (text: string) => void;
  signal: AbortSignal;
}

export interface StreamTurnResult {
  text: string;
  toolCalls: ToolCall[];
  stopReason: StopReason;
}

export interface LLMProvider {
  readonly name: string;
  streamTurn(params: StreamTurnParams): Promise<StreamTurnResult>;
}

/** Sentence/clause boundary — Telugu and Hindi both use these plus ASCII punctuation. Shared by every provider. */
export const CHUNK_BOUNDARY = /([.!?।॥\n])/;

/**
 * Feed one text delta at a time; returns any newly-complete sentences ready
 * to speak, and the leftover fragment to keep accumulating. A tiny state
 * machine so every provider gets identical sentence-boundary behavior
 * instead of reimplementing (and subtly diverging on) the same regex logic.
 */
export function chunkOnSentence(buffer: string, delta: string): { ready: string; buffer: string } {
  const combined = buffer + delta;
  const parts = combined.split(CHUNK_BOUNDARY);
  let ready = "";
  let i = 0;
  while (i + 1 < parts.length) {
    ready += (parts[i] ?? "") + (parts[i + 1] ?? "");
    i += 2;
  }
  return { ready, buffer: parts.slice(i).join("") };
}
