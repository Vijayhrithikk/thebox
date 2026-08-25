import Fastify from "fastify";
import websocket from "@fastify/websocket";
import formbody from "@fastify/formbody";
import { env } from "./config.js";
import { CallSession } from "./call/session.js";
import { OutboundAudio } from "./call/media-stream.js";
import { mulawToPcm16 } from "./call/audio.js";
import { assertProviderConfigured } from "./brain/providers/index.js";
import { assertTelephonyConfigured } from "./telephony/index.js";
import { TelnyxAudioSink } from "./telephony/telnyx.js";
import { ExotelAudioSink } from "./telephony/exotel.js";
import { initWhatsApp, sendWhatsApp } from "./actions/whatsapp.js";
import { buildHotLeadMessage } from "./brain/liveActionSink.js";
import { scheduleCallbackFromSpeech } from "./brain/callbackScheduler.js";
import { createLiveProvider } from "./brain/providers/index.js";

// Fail loudly at boot, not three seconds into a live call — the actual point
// of validating env in the first place. Standalone scripts (say.ts) skip
// this on purpose; the real server never should.
assertProviderConfigured();
assertTelephonyConfigured();

const app = Fastify({
  logger: { level: env.LOG_LEVEL, transport: { target: "pino-pretty" } },
});

await app.register(websocket);
// Twilio's status callbacks POST application/x-www-form-urlencoded, which
// Fastify has no parser for by default — every /call-status hit 415 until
// this was added, discovered on the very first live call attempt. Telnyx's
// webhooks are plain JSON, which Fastify parses natively — no plugin needed
// for /telnyx/webhook.
await app.register(formbody);

app.get("/health", async () => ({ ok: true, at: new Date().toISOString() }));

// Not awaited — pairing (scanning a QR the first time) is a one-off manual
// step that shouldn't hold up the HTTP/WS server from listening. Once
// paired, .baileys-auth/ persists the session so this reconnects silently
// on every future boot.
void initWhatsApp((obj, msg) => app.log.info(obj as object, msg));

/**
 * Webhook targets for Sarvam's Voice Agent "API tool" calls — the mid-call
 * action layer when Sarvam's own managed agent (not our CallSession) is
 * running the conversation. Same underlying actions
 * (sendWhatsApp/scheduleCallbackFromSpeech) as the in-process path in
 * liveActionSink.ts; the only real difference is where the caller's phone
 * number comes from — there it's read from telephony/index.ts's
 * sessionId->number map (populated by our own placeCall()), here Sarvam
 * has to pass it explicitly in the tool call body, since Sarvam places the
 * call itself and that map is never populated for those calls. See the
 * Sarvam agent's tool config for how each field gets mapped from the
 * call's built-in/custom variables.
 */
const webhookLog = (obj: unknown, msg: string) => app.log.info(obj as object, msg);
// In-memory, per-process guard so a HOT verdict called more than once in
// the same conversation (Sarvam's agent can call the tool again as
// confidence increases) only sends one WhatsApp — same intent as
// dedupeHotClassification() in tools.ts, just keyed by whatever session
// identifier Sarvam passes since there's no persistent CallSession object
// to hold that state on this path.
const hotAlreadyFired = new Set<string>();

app.post("/webhooks/classify", async (request, reply) => {
  const body = request.body as {
    classification?: "hot" | "warm" | "cold";
    evidence?: string;
    caller_number?: string;
    session_id?: string;
  };
  app.log.info(body, "[sarvam webhook] classify");

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
  app.log.info(request.body as object, "[sarvam webhook] discovery");
  return reply.send({ ok: true });
});

app.post("/webhooks/callback", async (request, reply) => {
  const body = request.body as { spoken_time?: string; caller_number?: string };
  app.log.info(body, "[sarvam webhook] callback requested");

  if (body.spoken_time && body.caller_number) {
    void scheduleCallbackFromSpeech(body.caller_number, body.spoken_time, createLiveProvider(), webhookLog).catch(
      (err) => webhookLog({ err }, "callback scheduling failed"),
    );
  }

  return reply.send({ ok: true });
});

app.post("/call-status", async (request) => {
  const body = request.body as Record<string, string>;
  app.log.info(
    { callSid: body.CallSid, status: body.CallStatus, answeredBy: body.AnsweredBy },
    "call status",
  );
  return "";
});

/**
 * Twilio's bidirectional media stream — one socket per call.
 *
 * Message shapes we care about:
 *   start  — carries streamSid and any <Parameter> values from the TwiML
 *   media  — 20 ms of inbound mu-law from the caller, base64
 *   mark   — echo of a mark we sent, meaning that queued audio finished playing
 *   stop   — the call ended
 */
app.get("/media", { websocket: true }, (socket) => {
  let session: CallSession | null = null;

  socket.on("message", (raw: Buffer) => {
    let msg: any;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return;
    }

    switch (msg.event) {
      case "start": {
        const sessionId = msg.start?.customParameters?.sessionId ?? msg.start.streamSid;
        const audio = new OutboundAudio(socket as any, msg.start.streamSid);
        session = new CallSession(audio, sessionId, app.log);
        app.log.info({ sessionId, streamSid: msg.start.streamSid }, "media stream open — call is live");
        break;
      }

      case "media": {
        if (session && msg.media?.payload) {
          session.handleInboundFrame(mulawToPcm16(Buffer.from(msg.media.payload, "base64")));
        }
        break;
      }

      case "mark": {
        session?.onMark(msg.mark?.name);
        break;
      }

      case "stop": {
        app.log.info({ sessionId: session?.sessionId }, "media stream closed by Twilio");
        session?.close();
        break;
      }
    }
  });

  socket.on("close", () => {
    app.log.info({ sessionId: session?.sessionId }, "socket closed");
    session?.close();
  });
  socket.on("error", (err: Error) => app.log.error({ err, sessionId: session?.sessionId }, "socket error"));
});

/**
 * Telnyx's Call Control lifecycle webhook. We don't act on these — streaming
 * starts automatically once the call is answered because stream_url was set
 * directly on the Dial request (see telephony/telnyx.ts) — but Telnyx still
 * requires a webhook URL configured on the Call Control Application, and
 * logging every event here is the cheapest way to see what actually
 * happened on a call, the same role /call-status plays for Twilio.
 */
app.post("/telnyx/webhook", async (request) => {
  const body = request.body as { data?: { event_type?: string; payload?: Record<string, unknown> } };
  app.log.info(
    { eventType: body.data?.event_type, callControlId: body.data?.payload?.call_control_id },
    "telnyx webhook",
  );
  return "";
});

/**
 * Telnyx's bidirectional media stream. Unverified against live traffic —
 * the account is pending Telnyx's payment review as of this writing — so
 * this is written from documented message shapes, not confirmed byte-exact
 * like the Twilio route above. Two things specifically to check the moment
 * a real call gets through:
 *   1. Whether a "start"/"connected" event exists before the first "media"
 *      event, or whether media just starts arriving — this builds the
 *      session lazily off the first message carrying a stream_id either way,
 *      so it works under both assumptions.
 *   2. The exact `track` field values, to confirm the inbound-only filter
 *      below actually excludes our own echoed-back TTS audio rather than
 *      silently including it (which would corrupt the ASR feed).
 */
app.get("/telnyx/media", { websocket: true }, (socket) => {
  let session: CallSession | null = null;

  socket.on("message", (raw: Buffer) => {
    let msg: any;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return;
    }

    if (msg.event === "media" && msg.stream_id) {
      if (!session) {
        let sessionId = msg.stream_id;
        try {
          const state = msg.client_state ? JSON.parse(Buffer.from(msg.client_state, "base64").toString("utf-8")) : null;
          if (state?.sessionId) sessionId = state.sessionId;
        } catch {
          /* client_state is best-effort correlation, not required */
        }
        const audio = new TelnyxAudioSink(socket as any, msg.stream_id);
        session = new CallSession(audio, sessionId, app.log);
        app.log.info({ sessionId, streamId: msg.stream_id }, "telnyx media stream open — call is live");
      }

      const track = String(msg.media?.track ?? "").toLowerCase();
      const isOwnEcho = track.includes("outbound");
      if (session && msg.media?.payload && !isOwnEcho) {
        session.handleInboundFrame(mulawToPcm16(Buffer.from(msg.media.payload, "base64")));
      }
      return;
    }

    if (msg.event === "stop" || msg.event === "streaming.stopped") {
      app.log.info({ sessionId: session?.sessionId }, "telnyx media stream closed");
      session?.close();
    }
  });

  socket.on("close", () => {
    app.log.info({ sessionId: session?.sessionId }, "telnyx socket closed");
    session?.close();
  });
  socket.on("error", (err: Error) =>
    app.log.error({ err, sessionId: session?.sessionId }, "telnyx socket error"),
  );
});

/**
 * Exotel's AgentStream media socket, wired through the Voicebot Applet
 * configured once in App Bazaar (see telephony/exotel.ts's placeCall doc
 * for why the WSS URL can't be passed per-call the way Twilio/Telnyx do).
 *
 * Unlike Telnyx, Exotel's event sequence is explicitly documented: a
 * "start" event (carrying stream_sid, call_sid, custom_parameters) always
 * precedes "media", so the session is built eagerly here rather than
 * lazily off the first media frame. Audio arrives as raw linear16 PCM
 * already — no μ-law decode needed on this leg at all.
 */
app.get("/exotel/media", { websocket: true }, (socket) => {
  let session: CallSession | null = null;

  socket.on("message", (raw: Buffer) => {
    let msg: any;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return;
    }

    switch (msg.event) {
      case "start": {
        const sessionId = msg.start?.custom_parameters?.CustomField ?? msg.start?.call_sid ?? msg.stream_sid;
        const audio = new ExotelAudioSink(socket as any, msg.start?.stream_sid ?? msg.stream_sid);
        session = new CallSession(audio, sessionId, app.log);
        app.log.info({ sessionId, streamSid: msg.start?.stream_sid }, "exotel media stream open — call is live");
        break;
      }

      case "media": {
        if (session && msg.media?.payload) {
          session.handleInboundFrame(Buffer.from(msg.media.payload, "base64"));
        }
        break;
      }

      case "mark": {
        session?.onMark(msg.mark?.name);
        break;
      }

      case "stop": {
        app.log.info({ sessionId: session?.sessionId }, "exotel media stream closed");
        session?.close();
        break;
      }
    }
  });

  socket.on("close", () => {
    app.log.info({ sessionId: session?.sessionId }, "exotel socket closed");
    session?.close();
  });
  socket.on("error", (err: Error) =>
    app.log.error({ err, sessionId: session?.sessionId }, "exotel socket error"),
  );
});

await app.listen({ port: env.PORT, host: "0.0.0.0" });
app.log.info(`voice-server listening on :${env.PORT} (telephony=${env.TELEPHONY_PROVIDER})`);
