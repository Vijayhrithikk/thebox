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
| 1 | Calls & holds a conversation | 25 | 🟡 code complete, untested live |
| 2 | Language handling (TE/HI/EN + mixed) | 10 | 🟡 code complete, untested live |
| 3 | Discovery quality | 10 | 🟡 tools + prompt written, untuned |
| 4 | Intent classification from indirect answers | 15 | 🟡 LLM path written; deterministic scorer not started |
| 5 | Mid-call WhatsApp action | 15 | ⬜ not started (Phase 4) |
| 6 | Callback scheduling from speech | 10 | 🟡 tool captures raw phrase; resolver not built |
| 7 | Follow-up + WhatsApp quality | 10 | ⬜ not started (Phase 4) |
| 8 | Engineering judgement | 5 | 🟢 architecture defensible — see Decisions table |

---

## CURRENT STATE

**Phase 2 code complete, typechecked clean. Blocked on live credentials for the real test.**
Twilio signup in progress (Monish). Nothing in Phase 1/2 can be *proven* until a real call
connects — code compiling is necessary, not sufficient. Per our own rule: a phase is not
done until a live call to the test number confirms it.

## WHAT'S DONE

- [x] Assignment parsed, scorecard extracted, plan approved
- [x] Stack chosen and justified (see Decisions)
- [x] Monorepo scaffolded
- [x] Candidate identity set: M. Monish Vijay, +91 7330671778 (doubles as test number)
- [x] Phase 1: Twilio telephony spine — dial-out, TwiML <Connect><Stream>, mu-law codec,
      barge-in-capable outbound audio queue with mark tracking
- [x] Phase 2: full realtime loop, code-complete and typechecked —
  - Soniox streaming ASR wired for Telugu/Hindi/English with auto language ID
  - Energy-based VAD for same-frame barge-in speed, backed by ASR partials for confirmation
  - Claude Opus 5 in fast mode, adaptive thinking at low effort (never disabled — see
    decisions table), sentence-chunked streaming into TTS, tool-use round trips that never
    block audio, and a genuine abort-on-barge-in so an interrupted turn stops generating
    server-side, not just stops being audible
  - Sarvam TTS with synthesis-ahead-of-playback pipelining
  - Sales system prompt (Telugu-first opener), 3 tools: classify_lead, note_discovery,
    request_callback — wired to a console sink for now, real dispatch is Phase 4
  - Bumped @anthropic-ai/sdk 0.70 -> 0.120: the pinned version had no idea Opus 5's
    adaptive thinking existed and the build would have silently used the wrong shape

## WHAT'S NEXT

1. Twilio upgrade completes -> first live `pnpm call` to TEST_PHONE, judge whether the
   Telugu opener sounds human and the conversation loop actually holds up on a real line
2. Soniox + Sarvam + Anthropic keys land -> same live test, full loop
3. Phase 3: tune the deterministic intent scorer and discovery slot-filling against real
   rehearsal transcripts (Monish is fluent in Telugu + Hindi -- no external testers needed)

## OPEN BLOCKERS

- ⛔ Twilio account upgrade in progress — nothing can be live-tested until this lands
- ⛔ Soniox / Sarvam / Anthropic API keys not yet in .env
- ⛔ Resume PDF still needed

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
| Spend ₹2-4k upfront on real tiers, not free/trial | Brief states cost is not the filter and reimburses on join. A Twilio *trial* account cannot call an unverified number at all and prepends a disclosure message — that alone fails requirement #1 regardless of everything else built | The ₹500-600 free-tier path looked safer but is not actually viable for this specific requirement |

---

## CHANGELOG

- **2026-08-25** — Assignment received. Plan approved. Repo scaffolded, stack locked.
- **2026-08-25** — Candidate identity confirmed (M. Monish Vijay, +91 7330671778, doubling as test number). Budget decision: real paid tiers, not free/trial. Phase 1 telephony spine committed.
- **2026-08-25** — Phase 2 realtime loop written and typechecked clean: Soniox ASR, dual-signal barge-in (VAD + ASR partials), Claude Opus 5 fast-mode agent with sentence-streamed TTS and non-blocking tool calls. Blocked on live credentials for the real test — code compiling is not the bar, a working call is.
