# PROGRESS — ElevateBox SDE Intern build

> Living state file. Updated at every phase boundary. This is the memory of the project:
> what the goal is, what is done, what is next, and *why* each decision was made.
> The "why" column is interview ammunition — they score 5 points on defending your choices.

---

## THE GOAL

Build an AI voice system that **autonomously calls +91 8688664337**, speaks Telugu /
Hindi / English, sells e-commerce website development, qualifies the buyer, classifies
them Hot / Warm / Cold, **fires a WhatsApp while the call is still live**, books a
callback from vague spoken time, and follows up with real conversational context plus
resume, mobile number and an architecture image.

**Selection process is one thing: the call has to work.** 60+ / 100 gets a callback.
Target: not 60. The best submission they receive.

### Scorecard we are optimising against

| # | Criterion | Pts | Status |
|---|-----------|-----|--------|
| 1 | Calls & holds a conversation | 25 | ⬜ not started |
| 2 | Language handling (TE/HI/EN + mixed) | 10 | ⬜ not started |
| 3 | Discovery quality | 10 | ⬜ not started |
| 4 | Intent classification from indirect answers | 15 | ⬜ not started |
| 5 | Mid-call WhatsApp action | 15 | ⬜ not started |
| 6 | Callback scheduling from speech | 10 | ⬜ not started |
| 7 | Follow-up + WhatsApp quality | 10 | ⬜ not started |
| 8 | Engineering judgement | 5 | ⬜ not started |

---

## CURRENT STATE

**Phase 0 — scaffold + credentials.** Repo structure created. Waiting on API keys.

## WHAT'S DONE

- [x] Assignment parsed, scorecard extracted, plan approved
- [x] Stack chosen and justified (see Decisions)
- [x] Monorepo scaffolded

## WHAT'S NEXT

1. User completes the credential checklist (see `docs/SETUP.md`)
2. Phase 1: make a phone ring and speak Telugu

## OPEN BLOCKERS

- ⛔ API credentials not yet provisioned — blocks everything from Phase 1 onward
- ⛔ Need user's full name, mobile number, resume PDF

---

## DECISIONS + RATIONALE (interview ammunition)

| Decision | Why | Alternative rejected because |
|---|---|---|
| Custom orchestrator over Twilio Media Streams, not Vapi/Retell | We own the turn loop, so mid-call WhatsApp timing is provable and barge-in is tunable | Managed platforms make the 15-pt mid-call requirement a black box and every submission looks identical |
| Twilio (US number) for telephony | Only Tier-1 provider permitting India outbound without an Indian-entity KYC. Twilio dropped India (+91) numbers Aug 2024 but calling *to* Indian mobiles from a non-India number is explicitly permitted with recipient consent — which the brief itself grants | Exotel/Ozonetel need GST + business KYC. Plivo viable, kept as documented fallback |
| Soniox for ASR | 8.2% Telugu WER vs Google's 37%. True streaming, automatic language ID, mid-sentence Telugu↔English code-switching with zero config | Deepgram has no real Telugu. Whisper is not streaming |
| Sarvam Bulbul v3 for TTS | Native Telugu with Tenglish code-switching, sub-250ms TTFB, Indian female voice (the brief says female lands better on outbound here), ₹30/10k chars | ElevenLabs is fine but not natively Tenglish; kept as fallback |
| Claude Opus 5 + **fast mode** in-call | `speed:"fast"` gives up to 2.5x output tokens/sec — the single biggest LLM latency lever. Best-in-class tool use, which the mid-call action depends on | — |
| Adaptive thinking at `effort:"low"`, NOT `thinking:disabled` | On Opus 5, disabled thinking can emit a tool call as **plain text** — the call silently never runs and no error is raised. In a voice agent that means the WhatsApp never fires. Unacceptable risk on a 15-point requirement | `thinking:disabled` looked like the obvious latency win; it isn't |
| Mid-conversation system messages for live state | Opus 5 accepts `role:"system"` inside `messages[]`, so we inject elapsed time / intent score / "WhatsApp already sent" without invalidating the cached prefix | Rebuilding the system prompt each turn would cold-cache every turn |
| Dual-path intent detection | A deterministic signal scorer runs in parallel with the LLM; whichever crosses the threshold first fires the WhatsApp | Sole reliance on an LLM tool call means one missed call = 15 points gone |
| Fly.io `bom` (Mumbai) | Physically closest region to Indian carriers and to Sarvam. Every ms of RTT is scored under "latency kills the conversation" | Vercel can't hold long-lived WebSockets; US regions add ~200ms round trip |
| TypeScript end to end | One language across realtime server and console; every line has to be defensible in the interview | — |

---

## CHANGELOG

- **2026-08-25** — Assignment received. Plan approved. Repo scaffolded, stack locked.
