import Fastify from "fastify";
import { env } from "./config.js";
import { assertProviderConfigured, createLiveProvider, createDeepReasoningProvider } from "./brain/providers/index.js";
import { isTelephonyConfigured } from "./telephony/index.js";
import { initWhatsApp, sendWhatsApp } from "./actions/whatsapp.js";
import { sendFollowUp, type CallOutcome } from "./actions/followup.js";
import { scheduleCallbackFromSpeech } from "./brain/callbackScheduler.js";
import { recordEvent, getEvents } from "./monitoring.js";
import { createCampaign, listCampaigns, startCampaignDispatcher } from "./campaigns.js";
import { CONSOLE_HTML } from "./console.js";

/**
 * This server no longer runs the live call — Sarvam's Voice Agent does,
 * with its own STT, LLM, and TTS, dialing out from a Sarvam-rented number
 * (Exotel was tried first, hit a bridging bug in Sarvam's campaign dialer,
 * and was dropped in favor of Sarvam's own number). What's left here is
 * the action backend Sarvam's tools call mid-call and at call end (see
 * docs/sarvam-agent-* for the portal setup this pairs with), a monitoring
 * console, and a small in-memory event feed backing it. See PROGRESS.md
 * for why the pipeline that used to live in this file was removed.
 */
assertProviderConfigured();
if (!isTelephonyConfigured()) {
  console.warn(
    "SARVAM_* not configured — the scheduled-callback re-dial is disabled; request_callback will still resolve and log the requested time, it just won't place the call itself.",
  );
}

const app = Fastify({
  logger: { level: env.LOG_LEVEL, transport: { target: "pino-pretty" } },
});

app.get("/health", async () => ({ ok: true, at: new Date().toISOString() }));

app.get("/", async (_request, reply) => {
  reply.type("text/html").send(CONSOLE_HTML);
});

// Not awaited — pairing (scanning a QR the first time) is a one-off manual
// step that shouldn't hold up the HTTP server from listening. Once paired,
// .baileys-auth/ persists the session so this reconnects silently on every
// future boot.
void initWhatsApp((obj, msg) => app.log.info(obj as object, msg));

const webhookLog = (obj: unknown, msg: string) => app.log.info(obj as object, msg);

/** For the console: recent events across all calls, newest first. */
app.get("/events", async () => ({ events: getEvents() }));

/**
 * These four routes trigger real side effects (WhatsApp sends, a scheduled
 * re-dial that costs real Exotel minutes) and were, until now, reachable by
 * anyone who found the URL — no auth at all. WEBHOOK_SECRET is optional
 * specifically so nothing breaks before it's configured on both ends, but
 * it should be set in production: generate any random string, put it in
 * this server's WEBHOOK_SECRET env var, and configure the same value as a
 * header on all four tools in Sarvam's tool config (see the setup prompt).
 * /health, /, and /events stay open — they're read-only and /  is the
 * whole point of a demo console being shareable.
 */
function checkWebhookAuth(request: { headers: Record<string, unknown> }): boolean {
  if (!env.WEBHOOK_SECRET) return true;
  return request.headers["x-webhook-secret"] === env.WEBHOOK_SECRET;
}

/**
 * The campaign routes below place real calls against a real Sarvam number
 * for any number they're pointed at — unlike /events (read-only), an open
 * "call any number" endpoint is a real abuse vector even for a demo.
 * Reuses WEBHOOK_SECRET as the shared admin key rather than introducing a
 * second secret to configure and document; the console prompts for it once
 * and keeps it in localStorage.
 */
function checkAdminAuth(request: { headers: Record<string, unknown> }): boolean {
  if (!env.WEBHOOK_SECRET) return true;
  return request.headers["x-admin-secret"] === env.WEBHOOK_SECRET;
}

startCampaignDispatcher((obj, msg) => app.log.info(obj as object, msg));

// Read-only, same posture as /events — the thing that actually needs
// protecting is triggering a call (POST below), not viewing status.
app.get("/campaigns", async () => ({ campaigns: listCampaigns() }));

app.post("/campaigns", async (request, reply) => {
  if (!checkAdminAuth(request)) return reply.code(401).send({ ok: false, error: "unauthorized" });
  const body = request.body as { label?: string; contacts?: { number?: string; name?: string }[] };
  const contacts = (body.contacts ?? []).filter((c): c is { number: string; name?: string } => Boolean(c.number));
  if (contacts.length === 0) return reply.code(400).send({ ok: false, error: "no valid contacts" });

  const campaign = createCampaign(body.label || "Untitled campaign", contacts);
  webhookLog({ campaignId: campaign.id, count: campaign.contacts.length }, "campaign created");
  return reply.send({ ok: true, campaign });
});

// In-memory, per-process guard so a HOT verdict called more than once in the
// same conversation (Sarvam's agent can call the tool again as confidence
// increases) only sends one WhatsApp, keyed by whatever session identifier
// Sarvam passes.
const hotAlreadyFired = new Set<string>();
// Same idea for call-ended: if Sarvam retries the on_end tool call (a
// timeout, a network blip), this stops the follow-up composing and sending
// twice — a real duplicate-message risk that had no guard until now.
const callEndedAlreadyHandled = new Set<string>();

function buildHotLeadMessage(evidence: string): string {
  const name = env.CANDIDATE_NAME || "our team";
  const number = env.CANDIDATE_PHONE || "";
  return (
    `Hi! Great talking to you just now — you mentioned "${evidence}", so I wanted to get this to you ` +
    `right away. ${name} will follow up shortly with everything on building your e-commerce website. ` +
    (number ? `Feel free to reach out directly at ${number} anytime.` : "")
  ).trim();
}

app.post("/webhooks/classify", async (request, reply) => {
  if (!checkWebhookAuth(request)) return reply.code(401).send({ ok: false, error: "unauthorized" });
  const body = request.body as {
    classification?: "hot" | "warm" | "cold";
    evidence?: string;
    caller_number?: string;
    session_id?: string;
  };
  webhookLog(body, "[sarvam webhook] classify");
  recordEvent({ type: "classify", ...body });

  if (body.classification === "hot" && body.caller_number) {
    const dedupeKey = body.session_id ?? body.caller_number;
    if (!hotAlreadyFired.has(dedupeKey)) {
      hotAlreadyFired.add(dedupeKey);
      void sendWhatsApp(body.caller_number, buildHotLeadMessage(body.evidence ?? ""), webhookLog);
    }
  }

  return reply.send({ ok: true });
});

app.post("/webhooks/discovery", async (request, reply) => {
  if (!checkWebhookAuth(request)) return reply.code(401).send({ ok: false, error: "unauthorized" });
  webhookLog(request.body as object, "[sarvam webhook] discovery");
  recordEvent({ type: "discovery", ...(request.body as object) });
  return reply.send({ ok: true });
});

app.post("/webhooks/callback", async (request, reply) => {
  if (!checkWebhookAuth(request)) return reply.code(401).send({ ok: false, error: "unauthorized" });
  const body = request.body as { spoken_time?: string; caller_number?: string };
  webhookLog(body, "[sarvam webhook] callback requested");
  recordEvent({ type: "callback", ...body });

  if (body.spoken_time && body.caller_number) {
    void scheduleCallbackFromSpeech(body.caller_number, body.spoken_time, createLiveProvider(), webhookLog).catch(
      (err) => webhookLog({ err }, "callback scheduling failed"),
    );
  }

  return reply.send({ ok: true });
});

/**
 * Fires once, when the call ends — an `on_end` lifecycle tool in Sarvam's
 * agent config (see docs/sarvam-agent-prompt.txt setup notes). This is the
 * other scored requirement (assignment brief, Section 06): a WhatsApp
 * follow-up carrying real conversation context, the candidate's number, and
 * the architecture image — separate from the mid-call HOT ping above, and
 * composed here because this is the point where the whole call's discovery
 * data is actually available.
 */
app.post("/webhooks/call-ended", async (request, reply) => {
  if (!checkWebhookAuth(request)) return reply.code(401).send({ ok: false, error: "unauthorized" });
  const body = request.body as {
    caller_number?: string;
    session_id?: string;
    classification?: CallOutcome["classification"];
    call_summary?: string;
    budget?: string;
    business_type?: string;
    product_count?: string;
    timeline?: string;
    features?: string;
    callback_requested?: boolean;
    callback_time?: string;
  };
  webhookLog(body, "[sarvam webhook] call ended");
  recordEvent({ type: "call_ended", ...body });

  if (!body.caller_number) {
    webhookLog(body, "call ended with no caller_number — cannot send follow-up");
    return reply.send({ ok: true });
  }

  const dedupeKey = body.session_id ?? body.caller_number;
  if (callEndedAlreadyHandled.has(dedupeKey)) {
    webhookLog(body, "call-ended already handled for this call — skipping duplicate follow-up");
    return reply.send({ ok: true });
  }
  callEndedAlreadyHandled.add(dedupeKey);

  const outcome: CallOutcome = {
    callerNumber: body.caller_number,
    classification: body.classification,
    summary: body.call_summary,
    budget: body.budget,
    business: body.business_type,
    productCount: body.product_count,
    timeline: body.timeline,
    features: body.features,
    callbackRequested: body.callback_requested,
    callbackTime: body.callback_time,
  };

  void sendFollowUp(outcome, createDeepReasoningProvider(), webhookLog).catch((err) =>
    webhookLog({ err }, "follow-up send failed"),
  );

  return reply.send({ ok: true });
});

/**
 * Fires directly from Sarvam's call-completion infrastructure, not the
 * agent's on_end tool — added because that on_end tool (call_ended, see
 * the /webhooks/call-ended route above) never fired once across repeated
 * live tests despite being correctly configured, so the resume/architecture
 * follow-up never sent. This path is set via webhook_config on every call
 * we place ourselves (telephony/sarvam.ts) and doesn't depend on the
 * agent's tool system at all. Bonus: it also carries a real transcript and
 * interaction_id, which the on_end tool never could.
 */
const callCompletedAlreadyHandled = new Set<string>();

app.post("/webhooks/call-completed", async (request, reply) => {
  const body = request.body as {
    attempt_id?: string;
    status?: string;
    duration?: number | null;
    interaction_id?: string | null;
    failure_reason?: string | null;
    final_agent_variables?: Record<string, unknown> | null;
    webhook_config?: { metadata?: { secret?: string } | null };
    interaction_transcript?: { role: string; en_text: string }[] | null;
  };

  if (env.WEBHOOK_SECRET && body.webhook_config?.metadata?.secret !== env.WEBHOOK_SECRET) {
    return reply.code(401).send({ ok: false, error: "unauthorized" });
  }

  webhookLog({ attempt_id: body.attempt_id, status: body.status }, "[sarvam webhook] call completed");

  const vars = (body.final_agent_variables ?? {}) as Record<string, string | undefined>;
  const callerNumber = vars.caller_number;

  recordEvent({
    type: "call_ended",
    caller_number: callerNumber ?? "",
    session_id: body.interaction_id ?? body.attempt_id ?? "",
    classification: vars.classification ?? "",
    call_summary: vars.call_summary ?? "",
    budget: vars.budget ?? "",
    business_type: vars.business_type ?? "",
    product_count: vars.product_count ?? "",
    timeline: vars.timeline ?? "",
    features: vars.features ?? "",
    callback_requested: vars.callback_requested ?? "",
    callback_time: vars.callback_time ?? "",
    status: body.status ?? "",
    duration: body.duration ?? null,
    transcript: body.interaction_transcript ?? null,
  });

  if (!callerNumber) {
    webhookLog(body, "call completed with no caller_number in final_agent_variables — cannot send follow-up");
    return reply.send({ ok: true });
  }

  const dedupeKey = body.attempt_id ?? body.interaction_id ?? callerNumber;
  if (callCompletedAlreadyHandled.has(dedupeKey)) {
    return reply.send({ ok: true });
  }
  callCompletedAlreadyHandled.add(dedupeKey);

  const outcome: CallOutcome = {
    callerNumber,
    classification: vars.classification as CallOutcome["classification"],
    summary: vars.call_summary,
    budget: vars.budget,
    business: vars.business_type,
    productCount: vars.product_count,
    timeline: vars.timeline,
    features: vars.features,
    callbackRequested: vars.callback_requested === "true" || vars.callback_requested === "yes",
    callbackTime: vars.callback_time,
  };

  void sendFollowUp(outcome, createDeepReasoningProvider(), webhookLog).catch((err) =>
    webhookLog({ err }, "follow-up send failed (call-completed path)"),
  );

  return reply.send({ ok: true });
});

await app.listen({ port: env.PORT, host: "0.0.0.0" });
app.log.info(`voice-server listening on :${env.PORT}`);
