import Fastify from "fastify";
import { env } from "./config.js";
import { assertProviderConfigured, createLiveProvider, createDeepReasoningProvider } from "./brain/providers/index.js";
import { assertTelephonyConfigured } from "./telephony/index.js";
import { initWhatsApp, sendWhatsApp } from "./actions/whatsapp.js";
import { sendFollowUp, type CallOutcome } from "./actions/followup.js";
import { scheduleCallbackFromSpeech } from "./brain/callbackScheduler.js";
import { recordEvent, getEvents } from "./monitoring.js";
import { CONSOLE_HTML } from "./console.js";

/**
 * This server no longer runs the live call — Sarvam's Voice Agent does,
 * with its own STT, LLM, and TTS. What's left here is the action backend
 * Sarvam's tools call mid-call and at call end (see docs/sarvam-agent-*
 * for the portal setup this pairs with), a monitoring console, and a small
 * in-memory event feed backing it. See PROGRESS.md for why the pipeline
 * that used to live in this file was removed.
 */
assertProviderConfigured();
assertTelephonyConfigured();

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

// In-memory, per-process guard so a HOT verdict called more than once in the
// same conversation (Sarvam's agent can call the tool again as confidence
// increases) only sends one WhatsApp, keyed by whatever session identifier
// Sarvam passes.
const hotAlreadyFired = new Set<string>();

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
  webhookLog(request.body as object, "[sarvam webhook] discovery");
  recordEvent({ type: "discovery", ...(request.body as object) });
  return reply.send({ ok: true });
});

app.post("/webhooks/callback", async (request, reply) => {
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
  const body = request.body as {
    caller_number?: string;
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

await app.listen({ port: env.PORT, host: "0.0.0.0" });
app.log.info(`voice-server listening on :${env.PORT}`);
