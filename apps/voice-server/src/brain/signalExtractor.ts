import { toolDefinitions, handleToolCall, type ActionSink } from "./tools.js";
import type { LLMProvider } from "./providers/types.js";

/**
 * Deliberately not a persona, not conversational — this call has exactly
 * one job: decide which tools apply to one utterance. No spoken text is
 * ever wanted from it, which is precisely the shape that made the live
 * conversational agent slow (see agent.ts) — here it's a feature, not a bug,
 * since nothing is listening for prose from this call.
 */
const EXTRACTOR_PROMPT = `You are analyzing one line from a customer during an e-commerce
website sales call, to decide which of the available tools apply to what they just said.
Call every tool that genuinely applies — zero, one, or several. Be conservative on
classify_lead: only call it when there is real signal in this specific line, not on every
turn. Do not produce any spoken reply — tool calls only.`;

/**
 * Runs concurrently with the live spoken reply (session.ts fires this
 * without awaiting it) so classification, discovery notes, and callback
 * scheduling never add latency to what the caller actually hears. A missed
 * or slow extraction degrades quietly — the conversation itself is
 * unaffected either way.
 */
export async function extractSignals(utterance: string, provider: LLMProvider, sink: ActionSink): Promise<void> {
  const result = await provider.streamTurn({
    systemPrompt: EXTRACTOR_PROMPT,
    history: [{ role: "user", text: utterance }],
    tools: toolDefinitions,
    onSentence: () => {}, // extraction never speaks; any stray text is discarded
    signal: new AbortController().signal,
  });

  for (const call of result.toolCalls) {
    handleToolCall(call.name, call.input, sink);
  }
}
