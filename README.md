# ElevateBox Voice Agent Backend

This repository contains the backend and operations layer for an autonomous outbound voice-sales workflow built for the ElevateBox SDE Intern assignment.

The **live conversation engine runs inside Sarvam Voice Agents**.  
This codebase handles the surrounding actions and orchestration:

- webhook endpoints called by the agent during/after calls
- mid-call and post-call WhatsApp follow-ups
- callback-time resolution from natural speech and scheduled re-dials
- campaign queueing/retries
- monitoring console and event history persistence

## Repository layout

- `/apps/voice-server` — Fastify + TypeScript service (main runtime)
- `/docs` — setup, build notes, architecture artefacts, and submission notes
- `/assets` — architecture images used in follow-ups (`resume.pdf` is intentionally gitignored)
- `/.github/workflows/deploy.yml` — EC2 Docker deploy workflow
- `/PROGRESS.md` — detailed project history, decisions, and current status

## Architecture at a glance

1. Call is placed through Sarvam Instant Outbound API.
2. Sarvam agent runs the live bilingual conversation.
3. Sarvam tool calls hit this server:
   - `POST /webhooks/classify`
   - `POST /webhooks/discovery`
   - `POST /webhooks/callback`
   - `POST /webhooks/call-ended`
4. This server:
   - sends immediate WhatsApp for HOT signals
   - resolves callback phrases (e.g. “tomorrow morning”) to a datetime
   - schedules re-dial via Sarvam
   - sends post-call WhatsApp (message + architecture image + resume when present)
5. `POST /webhooks/call-completed` can also ingest Sarvam call-completion callbacks directly.

## Prerequisites

- Node.js `>=22`
- pnpm `10.x` (repo uses `pnpm@10.18.2`)
- A configured Sarvam Voice Agent + outbound connection
- A WhatsApp account to pair via QR (Baileys)

## Setup

Detailed instructions: `/home/runner/work/thebox/thebox/docs/SETUP.md`

1. Install dependencies:
   ```bash
   pnpm install
   ```
2. Create `/home/runner/work/thebox/thebox/.env` and fill required values from `docs/SETUP.md`:
   - `DEEPSEEK_API_KEY` (required)
   - `SARVAM_*` values (required for placing calls/re-dials)
   - `WEBHOOK_SECRET` (recommended for production)
   - `CANDIDATE_*`, `RESUME_PATH`, `ARCHITECTURE_IMAGE_PATH`
3. Place your local resume at:
   - `/home/runner/work/thebox/thebox/assets/resume.pdf` (gitignored)
4. Start the service:
   ```bash
   pnpm --filter voice-server dev
   ```
5. Pair WhatsApp from the QR shown in terminal (also saved as `.whatsapp-qr.png`).

## Common commands

From repository root (`/home/runner/work/thebox/thebox`):

```bash
pnpm dev              # run voice-server in watch mode
pnpm build            # build workspace
pnpm typecheck        # typecheck workspace
pnpm call             # trigger outbound call (voice-server script)
```

Direct package scripts:

```bash
pnpm --filter voice-server call
pnpm --filter voice-server schedule "tomorrow morning"
```

## Runtime endpoints

- `GET /health` — health check
- `GET /` — monitoring console (optional Basic Auth)
- `GET /events` — recent webhook/call events
- `GET /campaigns` — campaign list
- `POST /campaigns` — create campaign
- `POST /campaigns/retry-config` — update retry policy
- `POST /backfill` — import historical interactions from Sarvam analytics
- `GET /recordings/:interactionId` — proxy recording stream from Sarvam analytics

## Security and auth

- `WEBHOOK_SECRET` protects `/webhooks/*` via `X-Webhook-Secret`.
- Admin mutating routes use `X-Admin-Secret` (same value as `WEBHOOK_SECRET`).
- Console routes can be protected with `CONSOLE_USERNAME` + `CONSOLE_PASSWORD`.

## Persistence model

Current persistence is file-backed under `apps/voice-server/data/` (gitignored):

- `events.json` — monitoring feed
- `campaigns.json` — campaigns, attempt index, retry config

Callback scheduling itself is in-process (`setTimeout`) and does **not** survive restart unless migrated to DB-backed jobs.

## Deployment

- Dockerfile: `/home/runner/work/thebox/thebox/apps/voice-server/Dockerfile`
- CI deploy workflow: `/home/runner/work/thebox/thebox/.github/workflows/deploy.yml`
- Current workflow deploys to EC2 over SSH, rebuilds image, and runs container with persistent mounts for:
  - `.baileys-auth`
  - `data/`

## Documentation index

- Setup guide: `/home/runner/work/thebox/thebox/docs/SETUP.md`
- Sarvam agent full build spec: `/home/runner/work/thebox/thebox/docs/sarvam-agent-full-build.md`
- Architecture page: `/home/runner/work/thebox/thebox/docs/architecture.html`
- Submission summary: `/home/runner/work/thebox/thebox/docs/submission-note.md`
- Detailed build history: `/home/runner/work/thebox/thebox/PROGRESS.md`
