import Fastify from "fastify";
import websocket from "@fastify/websocket";
import { env } from "./config.js";
import { CallSession } from "./call/session.js";

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
        session = new CallSession(socket as any, msg.start.streamSid, sessionId, app.log);
        app.log.info({ sessionId, streamSid: msg.start.streamSid }, "media stream open — call is live");
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

await app.listen({ port: env.PORT, host: "0.0.0.0" });
app.log.info(`voice-server listening on :${env.PORT}`);
