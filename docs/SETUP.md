# Setup

Two separate things need setting up: the Sarvam agent itself (the live call), and this
repo's backend (the webhook/WhatsApp/scheduler action layer Sarvam's tools call into).

## 1. The Sarvam agent

Everything — agent creation, voice, pronunciation dictionary, instructions, all four tools
— is in one place: **`docs/sarvam-agent-full-build.md`**. Follow it top to bottom.

Telephony: the agent's Exotel connection previously hit a real bug (Sarvam's campaign
dialer landing on Exotel's two-leg bridging mode instead of single-leg dialing, dropping
calls at ~7 seconds) — the number moved to one rented directly through Sarvam, which
sidesteps it. See `PROGRESS.md`'s "STATUS AS OF" banner for the full history.

## 2. This repo's backend (`apps/voice-server`)

Copy `.env.example` to `.env` in the repo root and fill in:

- `EXOTEL_*` — **optional now.** Only used for the scheduled-callback re-dial. Leave blank
  if you're not running Exotel at all; the server logs a warning at boot and callbacks still
  resolve and get logged, they just don't auto-redial.
- `DEEPSEEK_API_KEY` — required. Used only for two things: resolving spoken callback times
  ("tomorrow morning") into real datetimes, and composing the post-call WhatsApp follow-up.
  Neither is on the call's critical path, so DeepSeek's flagship reasoning mode is fine here
  (unlike a live conversational turn, which is what killed a fully custom pipeline earlier
  in this project — see PROGRESS.md).
- `CANDIDATE_NAME`, `CANDIDATE_PHONE` — appear in every WhatsApp message.
- `RESUME_PATH`, `ARCHITECTURE_IMAGE_PATH` — default to `../../assets/resume.pdf` and
  `../../assets/architecture.png` (relative to `apps/voice-server`, so they resolve to the
  repo-root `assets/` folder). `resume.pdf` is gitignored — put a real file there locally;
  it won't come from a fresh `git clone`.
- `WEBHOOK_SECRET` — a random string, checked against the `X-Webhook-Secret` header on all
  `/webhooks/*` routes. Generate one (`node -e "console.log(require('crypto').randomBytes(24).toString('hex'))"`)
  and configure the exact same value on all four tools in the Sarvam agent build doc.
- WhatsApp needs no credentials — first boot prints a QR (also written to
  `.whatsapp-qr.png`) to scan from WhatsApp → Linked Devices. Session persists in
  `.baileys-auth/` (gitignored) across restarts.

Then: `pnpm install`, `pnpm --filter voice-server dev` to run locally, or build/deploy the
Docker image (`apps/voice-server/Dockerfile`) — currently running on an EC2 instance behind
Caddy for automatic HTTPS via an sslip.io hostname (see `PROGRESS.md` for the exact deploy
commands used).

## What's needed from you

1. **Resume PDF** at `assets/resume.pdf` locally (not tracked in git)
2. Confirm the four webhook tool URLs in Sarvam actually point at the live deployment, not
   a dead ngrok tunnel
