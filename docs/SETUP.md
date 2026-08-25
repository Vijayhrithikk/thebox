# Credential checklist — do these in order

Everything below runs in parallel with the build. **Item 1 is the critical path** — nothing
can ring a phone until Twilio is live. **Spend today: ₹0.** Every provider here has a free
tier that covers the entire build-and-rehearse phase. The one real cost (~₹1,700, Twilio's
account upgrade) is deliberately deferred to Phase 7, the day we're ready to place the actual
call to the recruiter — see the note at the end of item 1. It's reimbursed either way.

Paste each key into `.env` (copy `.env.example` first). Never commit `.env`.

---

## 1. Twilio — telephony ⛔ CRITICAL PATH

**Stay on the free trial for now — do not upgrade yet.**

1. Sign up at **https://www.twilio.com/try-twilio** — no card required
2. Verify your email and your mobile number
3. Buy a **US local number** with **Voice** capability:
   Console → Phone Numbers → Buy a number → Country: United States → check **Voice** → Buy.
   Free on trial. (Do **not** buy an Indian number — Twilio stopped supporting +91 numbers for
   outbound in Aug 2024. Calling *into* India from a US number is the supported, consented path.)
4. **Verify your own second number** as a caller ID so trial calls can actually reach it:
   Console → Phone Numbers → Verified Caller IDs → Add a new number → enter your test
   number → answer the call/read back the code. Takes under a minute, unlocks every
   rehearsal call for free.
5. From the Console dashboard copy:
   - `TWILIO_ACCOUNT_SID` (starts `AC…`)
   - `TWILIO_AUTH_TOKEN`
   - `TWILIO_PHONE_NUMBER` (the number you just bought, E.164 format e.g. `+15551234567`)

The trial gives **75 free voice minutes** — plenty for the whole build. Its only two
restrictions are (a) it can only call numbers you've verified, which is fine since every
rehearsal targets your own number, and (b) it prepends a short disclaimer message, which
doesn't matter for a test call to yourself. Neither restriction blocks anything before
Phase 7. **The real call to 8688664337 is the one call that needs an unverified number** —
that's the single moment we upgrade (Console → top-right → Upgrade, ~$20/₹1,700), right
before we place it, not before.

## 2. Soniox — speech to text

1. Sign up at **https://soniox.com** → Console
2. Create an API key
3. Copy `SONIOX_API_KEY`

New accounts get free credits. This is the piece doing the Telugu heavy lifting.

## 3. Sarvam AI — text to speech

1. Sign up at **https://dashboard.sarvam.ai**
2. API Keys → create a subscription key
3. Copy `SARVAM_API_KEY`

New users get ₹100 free credits, which is a lot of speech at ₹30 per 10,000 characters.

## 4. Anthropic — the brain

1. Sign up at **https://console.claude.com**
2. Add credits (start with $20)
3. Settings → API Keys → Create key
4. Copy `ANTHROPIC_API_KEY`

## 5. Neon — Postgres

1. Sign up at **https://neon.tech** (free tier is plenty)
2. Create a project, region **Singapore** (closest to Mumbai they offer)
3. Copy the pooled connection string → `DATABASE_URL`

## 6. Fly.io — hosting the voice server

1. Sign up at **https://fly.io** and add a card
2. Install the CLI (run this in PowerShell):
   ```powershell
   iwr https://fly.io/install.ps1 -useb | iex
   ```
3. `fly auth login`

We deploy to the **Mumbai (`bom`)** region — closest to Indian carriers and to Sarvam.

## 7. WhatsApp — two drivers, do BOTH

### 7a. Own-number session (fast path, unblocks everything)
Nothing to sign up for. When we run it the first time, a QR code appears in the terminal —
scan it from WhatsApp on your phone (Settings → Linked Devices → Link a Device).
Messages then send **from your own number**, which is the number he'd reply to anyway.

### 7b. Meta Cloud API (the production path)
Needs your **spare SIM** — the one with no WhatsApp account on it.

1. Go to **https://developers.facebook.com** → My Apps → Create App → **Business**
2. Add the **WhatsApp** product
3. Business Portfolio → create one if prompted
4. WhatsApp → API Setup → **Add phone number** → register your spare SIM → verify by OTP
5. Copy `WHATSAPP_PHONE_NUMBER_ID`, `WHATSAPP_BUSINESS_ACCOUNT_ID`
6. Generate a **permanent** access token:
   Business Settings → System Users → Add → assign the app with full control →
   Generate token → select `whatsapp_business_messaging` + `whatsapp_business_management`
7. Copy `WHATSAPP_ACCESS_TOKEN`

Templates get submitted for approval on day one so they're ready by call day. I'll write and
submit them — you just need the account to exist.

---

## What I need from you directly

1. **Full name** — goes in the agent's script and every WhatsApp
2. **Mobile number** — the number he calls back
3. **A second phone number you can answer** — for test calls, so we never rehearse on the recruiter
4. **Resume PDF** — attached to the follow-up. If you don't have a strong one, say so and I'll build it
