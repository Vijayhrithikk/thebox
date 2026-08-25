import { resolve } from "node:path";
import makeWASocket, { useMultiFileAuthState, DisconnectReason, type WASocket } from "@whiskeysockets/baileys";
import qrcodeTerminal from "qrcode-terminal";
import * as qrcode from "qrcode";

/**
 * WhatsApp via a paired web session (Baileys) — the user's own number,
 * scanned in once like WhatsApp Web, not the Meta Cloud API. Chosen over
 * Cloud API because it needs no business verification or template
 * approval wait: free-form messages, live the moment the QR is scanned.
 *
 * One socket for the whole server process, not per-call — WhatsApp session
 * state is global, unlike the telephony/ASR/TTS connections which are
 * genuinely one-per-call.
 *
 * `printQRInTerminal` (shown in Baileys' own README examples) is
 * deprecated in the installed 7.0 release — confirmed by reading
 * lib/Socket/socket.js directly: it now only logs a warning and prints
 * nothing. The QR has to be handled manually off `connection.update`,
 * which is what this does.
 */

const AUTH_DIR = resolve(process.cwd(), ".baileys-auth");
/** Rewritten every time a fresh QR is issued — the ASCII version prints fine in a real terminal, but doesn't render reliably piped through other tools, so a scannable image is kept alongside it. */
export const QR_IMAGE_PATH = resolve(process.cwd(), ".whatsapp-qr.png");

let sock: WASocket | null = null;
let readyResolve: (() => void) | null = null;
let readyPromise = new Promise<void>((resolve) => {
  readyResolve = resolve;
});

export async function initWhatsApp(log: (obj: unknown, msg: string) => void): Promise<void> {
  const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
  const socket = makeWASocket({ auth: state });
  sock = socket;

  socket.ev.on("creds.update", saveCreds);

  socket.ev.on("connection.update", (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      log({}, "WhatsApp not paired yet — scan this QR with WhatsApp > Linked Devices > Link a Device");
      qrcodeTerminal.generate(qr, { small: true });
      qrcode.toFile(QR_IMAGE_PATH, qr, { width: 400 }).catch((err) => {
        log({ err }, "failed to write QR image");
      });
    }

    if (connection === "open") {
      log({}, "WhatsApp connected");
      readyResolve?.();
    }

    if (connection === "close") {
      // output?.statusCode duck-typed off the Boom error Baileys throws here —
      // avoids an explicit @hapi/boom dependency for one field, since it's
      // already a transitive dependency of baileys itself.
      const statusCode = (lastDisconnect?.error as { output?: { statusCode?: number } } | undefined)?.output
        ?.statusCode;
      const loggedOut = statusCode === DisconnectReason.loggedOut;
      log({ statusCode, loggedOut }, "WhatsApp connection closed");

      if (!loggedOut) {
        // Fresh ready-gate for the reconnect — the old one may already be
        // resolved from a prior successful connection.
        readyPromise = new Promise((resolve) => {
          readyResolve = resolve;
        });
        void initWhatsApp(log);
      }
    }
  });
}

function toJid(phoneNumber: string): string {
  const digitsOnly = phoneNumber.replace(/\D/g, "");
  return `${digitsOnly}@s.whatsapp.net`;
}

/**
 * Fire-and-forget from the caller's perspective — never blocks the call
 * that triggered it. Waits briefly for pairing to complete if the server
 * just started and the QR hasn't been scanned yet; gives up rather than
 * hanging the whole action pipeline on a WhatsApp session nobody's paired.
 */
export async function sendWhatsApp(to: string, text: string, log: (obj: unknown, msg: string) => void): Promise<void> {
  if (!sock) {
    log({ to }, "WhatsApp not initialized — message not sent");
    return;
  }

  try {
    await Promise.race([
      readyPromise,
      new Promise((_, reject) => setTimeout(() => reject(new Error("WhatsApp not connected (timeout)")), 5000)),
    ]);
    await sock.sendMessage(toJid(to), { text });
    log({ to }, "WhatsApp sent");
  } catch (err) {
    log({ err, to }, "WhatsApp send failed");
  }
}
