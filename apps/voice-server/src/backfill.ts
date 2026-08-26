import { env } from "./config.js";
import { recordEvent, hasCallEndedFor } from "./monitoring.js";

/**
 * One-time (well, re-runnable) import of everything Sarvam's Analytics API
 * already knows about this agent — covers calls that predate the
 * call-completed webhook existing, calls where the old on_end tool never
 * fired, and anything lost to a container restart before persistence was
 * added. Dedupes against events already in the log by interaction_id, so
 * running this repeatedly only pulls in what's new.
 */

const ANALYTICS_BASE = "https://apps.sarvam.ai/api/analytics/v1";

interface SarvamInteraction {
  interaction_id: string;
  user_contact?: string;
  duration_in_seconds?: number;
  start_datetime: string;
  failure_reason?: string;
  agent_variables?: Record<string, unknown>;
}

interface SarvamTranscriptTurn {
  turn_id: number;
  role: string;
  content: string;
}

function analyticsConfigured(): boolean {
  return Boolean(env.SARVAM_ORG_ID && env.SARVAM_WORKSPACE_ID && env.SARVAM_APP_ID && env.SARVAM_API_KEY);
}

async function fetchTranscript(interactionId: string): Promise<{ role: string; indic_text: string }[] | null> {
  try {
    const url = `${ANALYTICS_BASE}/${env.SARVAM_ORG_ID}/${env.SARVAM_WORKSPACE_ID}/${env.SARVAM_APP_ID}/transcripts/${encodeURIComponent(interactionId)}`;
    const res = await fetch(url, { headers: { "X-API-Key": env.SARVAM_API_KEY! } });
    if (!res.ok) return null;
    const data = (await res.json()) as { messages?: SarvamTranscriptTurn[] };
    if (!data.messages) return null;
    return data.messages.map((m) => ({ role: m.role === "assistant" ? "agent" : "user", indic_text: m.content }));
  } catch {
    return null;
  }
}

export async function backfillFromSarvam(
  log: (obj: unknown, msg: string) => void,
): Promise<{ imported: number; skipped: number; total: number }> {
  if (!analyticsConfigured()) throw new Error("Sarvam analytics not configured (SARVAM_ORG_ID/WORKSPACE_ID/APP_ID/API_KEY)");

  const startDatetime = "2026-01-01T00:00:00Z";
  const endDatetime = new Date().toISOString();
  const limit = 50;

  let imported = 0;
  let skipped = 0;
  let offset = 0;
  let total = Infinity;

  while (offset < total) {
    const url =
      `${ANALYTICS_BASE}/${env.SARVAM_ORG_ID}/${env.SARVAM_WORKSPACE_ID}/${env.SARVAM_APP_ID}/interactions` +
      `?start_datetime=${encodeURIComponent(startDatetime)}&end_datetime=${encodeURIComponent(endDatetime)}&limit=${limit}&offset=${offset}`;
    const res = await fetch(url, { headers: { "X-API-Key": env.SARVAM_API_KEY! } });
    if (!res.ok) throw new Error(`Sarvam interactions fetch failed: ${res.status}`);
    const data = (await res.json()) as { items: SarvamInteraction[]; total: number };
    total = data.total;

    for (const it of data.items) {
      if (hasCallEndedFor(it.interaction_id)) {
        skipped++;
        continue;
      }

      const vars = (it.agent_variables ?? {}) as Record<string, string | undefined>;
      const callerNumber = vars.caller_number || it.user_contact || "";
      const transcript = await fetchTranscript(it.interaction_id);
      const connected = !it.failure_reason || it.failure_reason === "NO_FAILURE_REASON";

      recordEvent(
        {
          type: "call_ended",
          caller_number: callerNumber,
          session_id: it.interaction_id,
          classification: vars.classification ?? "",
          call_summary: vars.call_summary ?? "",
          budget: vars.budget ?? "",
          business_type: vars.business_type ?? "",
          product_count: vars.product_count ?? "",
          timeline: vars.timeline ?? "",
          features: vars.features ?? "",
          callback_requested: vars.callback_requested ?? "",
          callback_time: vars.callback_time ?? "",
          status: connected ? "connected" : it.failure_reason,
          duration: it.duration_in_seconds ?? null,
          transcript,
          imported_from_sarvam: true,
        },
        it.start_datetime.endsWith("Z") ? it.start_datetime : `${it.start_datetime}Z`,
      );
      imported++;
    }

    offset += limit;
    log({ imported, skipped, offset, total }, "Sarvam history backfill progress");
  }

  return { imported, skipped, total };
}
