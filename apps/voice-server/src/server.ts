import Fastify from "fastify";
import websocket from "@fastify/websocket";
import { env } from "./config.js";
import { OutboundAudio } from "./call/media-stream.js";
import { synthesize } from "./providers/sarvam.js";

const app = Fastify({
  logger: { level: env.LOG_LEVEL, transport: { target: "pino-pretty" } },
});

await app.register(websocket);

app.get("/health", async () => ({ ok: true, at: new Date().toISOString() }));

app.post("/call-status", async (request) => {
  const body = request.body as Record<string, string>;
  app.log.info(
    { callSid: body.CallSid, status: body.CallStatus, answeredBy: body.AnsweredBy },
    "call status",
  );
  return "";
});

/**
 * Twilio's bidirectional media stream.
 *
 * Message shapes we care about:
 *   start  — carries streamSid and any <Parameter> values from the TwiML
 *   media  — 20 ms of inbound μ-law from the caller, base64
 *   mark   — echo of a mark we sent, meaning our audio finished playing
 *   stop   — the call ended
 */
app.get("/media", { websocket: true }, (socket) => {
  let out: OutboundAudio | null = null;
  let sessionId = "unknown";

  socket.on("message", async (raw: Buffer) => {
    let msg: any;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return;
    }

    switch (msg.event) {
      case "start": {
        sessionId = msg.start?.customParameters?.sessionId ?? msg.start.streamSid;
        out = new OutboundAudio(socket as any, msg.start.streamSid);
        app.log.info({ sessionId, streamSid: msg.start.streamSid }, "media stream open");

        // Phase 1 exit criterion: the phone rings and a human hears natural Telugu.
        // Phase 2 replaces this with the full ASR → LLM → TTS loop.
        const greeting =
          "నమస్కారం! నేను వర్షిత తరఫున మాట్లాడుతున్నాను. " +
          "మీ e-commerce website గురించి ఒక్క నిమిషం మాట్లాడొచ్చా?";
        try {
          const speech = await synthesize(greeting, "te-IN");
          app.log.info({ ttsMs: speech.latencyMs, durationMs: speech.durationMs }, "greeting ready");
          await out.play(speech.frames);
          app.log.info({ sessionId }, "greeting finished playing");
        } catch (err) {
          app.log.error({ err }, "TTS failed — caller would hear silence");
        }
        break;
      }

      case "media": {
        // Phase 2 pipes this into Soniox. Ignored for now.
        break;
      }

      case "mark": {
        out?.onMark(msg.mark?.name);
        break;
      }

      case "stop": {
        app.log.info({ sessionId }, "media stream closed by Twilio");
        break;
      }
    }
  });

  socket.on("close", () => app.log.info({ sessionId }, "socket closed"));
  socket.on("error", (err: Error) => app.log.error({ err, sessionId }, "socket error"));
});

await app.listen({ port: env.PORT, host: "0.0.0.0" });
app.log.info(`voice-server listening on :${env.PORT}`);
