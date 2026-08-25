import type { ToolSpec } from "./providers/types.js";

/**
 * Everything the model can *do* mid-call, separate from what it *says*.
 * Provider-neutral JSON Schema — each provider adapter translates this into
 * its own tool-definition wire format (see providers/anthropic.ts and
 * providers/deepseek.ts).
 *
 * These are deliberately fire-and-forget from the model's point of view: the
 * tool result we hand back is a same-millisecond acknowledgement, never the
 * outcome of the real side effect (sending the WhatsApp, writing to the DB).
 * That is what "actions never block audio" means concretely — the model
 * gets to keep talking while ActionSink does the slow part in the background.
 */
export const toolDefinitions: ToolSpec[] = [
  {
    name: "classify_lead",
    description:
      "Record your current read on this lead's buying intent. Call this the moment you " +
      "judge them Hot — do not wait until the call ends. Can be called more than once if " +
      "your read changes as the conversation develops; the latest call wins.",
    inputSchema: {
      type: "object",
      properties: {
        classification: {
          type: "string",
          enum: ["hot", "warm", "cold"],
          description: "hot = clear buying intent. warm = real need, stated barrier. cold = browsing.",
        },
        evidence: {
          type: "string",
          description: "The specific thing they said that led to this classification. Quote them.",
        },
      },
      required: ["classification", "evidence"],
      additionalProperties: false,
    },
  },
  {
    name: "note_discovery",
    description:
      "Record a concrete fact learned about their requirements. Call this every time they " +
      "state a budget, describe their product/business, give a timeline, or name a feature.",
    inputSchema: {
      type: "object",
      properties: {
        slot: {
          type: "string",
          enum: ["budget", "business", "product_count", "timeline", "features"],
        },
        value: {
          type: "string",
          description: "What they actually said, in their words where possible — not your paraphrase.",
        },
      },
      required: ["slot", "value"],
      additionalProperties: false,
    },
  },
  {
    name: "request_callback",
    description:
      "The caller named a time they want to be called back, even a vague one. Pass exactly " +
      "what they said — a scheduler resolves it to an actual datetime.",
    inputSchema: {
      type: "object",
      properties: {
        spoken_time: {
          type: "string",
          description: "Their words verbatim, e.g. 'tomorrow morning', 'after Diwali', 'next Monday around 6'.",
        },
      },
      required: ["spoken_time"],
      additionalProperties: false,
    },
  },
];

export interface ClassifyInput {
  classification: "hot" | "warm" | "cold";
  evidence: string;
}
export interface NoteDiscoveryInput {
  slot: "budget" | "business" | "product_count" | "timeline" | "features";
  value: string;
}
export interface RequestCallbackInput {
  spoken_time: string;
}

/**
 * Where tool calls actually go. Phase 2 wires a console logger so the
 * conversation loop is testable end-to-end before real WhatsApp/scheduler
 * dispatch exists (Phase 4) — same interface, no rewrite needed later.
 */
export interface ActionSink {
  onClassify(input: ClassifyInput): void;
  onDiscovery(input: NoteDiscoveryInput): void;
  onCallbackRequested(input: RequestCallbackInput): void;
}

export class ConsoleActionSink implements ActionSink {
  constructor(private readonly log: (obj: unknown, msg: string) => void) {}

  onClassify(input: ClassifyInput): void {
    this.log(input, `[classify] ${input.classification}`);
  }
  onDiscovery(input: NoteDiscoveryInput): void {
    this.log(input, `[discovery] ${input.slot}`);
  }
  onCallbackRequested(input: RequestCallbackInput): void {
    this.log(input, `[callback] "${input.spoken_time}"`);
  }
}

/** Dispatches a completed tool call to the sink and returns the ack text for the tool result. */
export function handleToolCall(name: string, input: unknown, sink: ActionSink): string {
  switch (name) {
    case "classify_lead":
      sink.onClassify(input as ClassifyInput);
      return "noted";
    case "note_discovery":
      sink.onDiscovery(input as NoteDiscoveryInput);
      return "noted";
    case "request_callback":
      sink.onCallbackRequested(input as RequestCallbackInput);
      return "callback queued";
    default:
      return "unknown tool";
  }
}
