import type { LLMProvider, ToolSpec } from "./providers/types.js";

/**
 * Turns a spoken callback phrase ("tomorrow morning", "after Diwali", "next
 * Monday around 6") into a concrete IST datetime. Deliberately an LLM call,
 * not regex — "after Diwali" needs calendar knowledge no date library has,
 * and open-ended Indian-English phrasing doesn't fit a fixed grammar.
 * Same shape as signalExtractor.ts: a single-purpose tool call, no
 * conversational text expected back.
 */
const RESOLVE_TOOL: ToolSpec = {
  name: "resolve_callback_time",
  description: "Resolve the caller's spoken callback time into a concrete datetime.",
  inputSchema: {
    type: "object",
    properties: {
      resolvable: {
        type: "boolean",
        description: "false if the phrase is genuinely too vague to resolve to any date (e.g. 'sometime', 'later')",
      },
      iso_datetime: {
        type: "string",
        description: "IST datetime in ISO 8601 with +05:30 offset, e.g. 2026-08-26T10:00:00+05:30. Required when resolvable is true.",
      },
      confidence: {
        type: "string",
        enum: ["exact", "approximate"],
        description: "exact = a specific time was named or clearly implied. approximate = a rough window (e.g. 'morning' -> a default time).",
      },
      reasoning: {
        type: "string",
        description: "One line: how you got from the phrase to this datetime.",
      },
    },
    required: ["resolvable"],
    additionalProperties: false,
  },
};

const buildSystemPrompt = (nowIst: string) => `You resolve a spoken callback-time phrase from
an Indian phone sales call into a concrete IST datetime. The current date and time is
${nowIst} IST (India Standard Time, UTC+5:30).

Known Indian festival dates: Diwali 2026 falls on 8 November 2026.

Default clock times when only a part of day is named: "morning" -> 10:00, "afternoon" ->
14:00, "evening" -> 18:00, "night" -> 20:00 IST, unless a more specific time is given (mark
those "approximate"; mark a named specific time "exact").

A phrase relative to a known event or day ("after Diwali", "once the weekend is over",
"early next week") DOES have an anchor — resolve it to a specific reasonable datetime
(a few days after the event/day, using the default clock times above) and mark it
"approximate". Only refuse to resolve — resolvable:false — when the phrase has genuinely
no anchor at all: no day, date, event, or relative reference of any kind ("sometime",
"later", "I'll let you know"). Being unable to pin an *exact* moment is not the same as
having nothing to work with — approximate is a real, useful answer; use it before giving up.`;

export interface CallbackResolution {
  resolvable: boolean;
  isoDatetime?: string;
  confidence?: "exact" | "approximate";
  reasoning?: string;
}

export async function resolveCallbackTime(
  spokenPhrase: string,
  provider: LLMProvider,
  now: Date = new Date(),
): Promise<CallbackResolution> {
  const nowIst = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Kolkata",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  })
    .format(now)
    .replace(",", "");

  const result = await provider.streamTurn({
    systemPrompt: buildSystemPrompt(nowIst),
    history: [{ role: "user", text: spokenPhrase }],
    tools: [RESOLVE_TOOL],
    onSentence: () => {}, // this call never produces conversational text
    signal: new AbortController().signal,
  });

  const call = result.toolCalls.find((c) => c.name === "resolve_callback_time");
  if (!call) return { resolvable: false };

  const input = call.input as Record<string, unknown>;
  return {
    resolvable: Boolean(input.resolvable),
    isoDatetime: typeof input.iso_datetime === "string" ? input.iso_datetime : undefined,
    confidence: input.confidence === "exact" || input.confidence === "approximate" ? input.confidence : undefined,
    reasoning: typeof input.reasoning === "string" ? input.reasoning : undefined,
  };
}
