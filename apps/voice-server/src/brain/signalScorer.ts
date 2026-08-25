import type { ClassifyInput } from "./tools.js";

/**
 * Second, non-LLM path to Hot/Warm/Cold — runs synchronously, in-process,
 * zero network calls, on every caller utterance alongside signalExtractor.ts's
 * LLM-based path. The brief calls for classification to survive "one missed
 * call" on the 15-point mid-call action; a single LLM tool-call is still a
 * single point of failure (a bad JSON parse, a dropped connection, a model
 * that just doesn't call the tool that turn) no matter how well-prompted.
 * This catches the same class of indirect phrasing the brief itself calls
 * out ("send me the details", "budget is not much right now", "how soon can
 * you start") via pattern matching instead of model judgement.
 *
 * Honest limitation, not hidden: these patterns are English/Hinglish only.
 * Soniox transcribes Telugu/Hindi in native script when that's what's
 * spoken, and this scorer has no patterns for that script — on a
 * Telugu-only turn, this path simply won't fire, and the LLM path (which
 * has no such limitation) is the only signal. That's an acceptable
 * redundancy shape for now — this path adds coverage, it doesn't have to
 * match the LLM path's language coverage to be worth having — but it's a
 * real gap to close before this can be called complete, not an edge case
 * to ignore.
 */

interface Pattern {
  regex: RegExp;
  classification: ClassifyInput["classification"];
}

// Order matters: checked top to bottom, first match wins. Explicit
// disqualifiers (COLD) are checked before softer HOT/WARM cues so "not
// interested, how much is it anyway" doesn't get read as a price question.
const PATTERNS: Pattern[] = [
  // COLD — explicit disqualifiers
  { regex: /\bnot interested\b/i, classification: "cold" },
  { regex: /\balready (have|got|built)\b.*(website|site|app)/i, classification: "cold" },
  { regex: /\b(just|only) (browsing|looking|checking)\b/i, classification: "cold" },
  { regex: /\bno budget\b/i, classification: "cold" },
  { regex: /\bdon'?t need\b/i, classification: "cold" },
  { regex: /\bnot (looking|planning) (for|to)\b/i, classification: "cold" },
  { regex: /\bstop calling\b/i, classification: "cold" },

  // HOT — readiness to move now
  { regex: /\bhow (soon|fast|quickly) can (you|we|this)\b/i, classification: "hot" },
  { regex: /\bwhen can (you|we) start\b/i, classification: "hot" },
  { regex: /\b(what'?s|what is) the (price|cost|total)\b/i, classification: "hot" },
  { regex: /\bhow much (will|does|would) (it|this) cost\b/i, classification: "hot" },
  { regex: /\blet'?s (do it|go ahead|proceed|start)\b/i, classification: "hot" },
  { regex: /\bhow do i pay\b/i, classification: "hot" },
  { regex: /\b(send|share) (the )?(payment|invoice|link)\b/i, classification: "hot" },
  { regex: /\bstart (today|this week|right away|now)\b/i, classification: "hot" },
  { regex: /\bi want to (proceed|move forward|go ahead)\b/i, classification: "hot" },

  // WARM — real interest with a stated barrier or deferral
  { regex: /\bbudget is (a bit |kinda |quite )?(tight|not much|limited|low)\b/i, classification: "warm" },
  { regex: /\bneed to (check|discuss|talk) (with|to)\b/i, classification: "warm" },
  { regex: /\bmy (brother|partner|husband|wife|father|boss|manager) (handles|deals with|takes care of)\b/i, classification: "warm" },
  { regex: /\bnot sure (about|if|yet)\b/i, classification: "warm" },
  { regex: /\bmaybe (later|next month|next week)\b/i, classification: "warm" },
  { regex: /\bsend (me )?(the )?details\b/i, classification: "warm" },
  { regex: /\blet me think\b/i, classification: "warm" },
  { regex: /\bcall (me )?back\b/i, classification: "warm" },
  { regex: /\bright now (is|isn'?t) (not )?(a good|the right) time\b/i, classification: "warm" },
];

export interface ScoredSignal extends ClassifyInput {
  source: "deterministic";
}

/** Pure, synchronous, no I/O — safe to call on every turn with zero latency cost. */
export function scoreUtterance(utterance: string): ScoredSignal | null {
  for (const { regex, classification } of PATTERNS) {
    const match = utterance.match(regex);
    if (match) {
      return { classification, evidence: match[0], source: "deterministic" };
    }
  }
  return null;
}
