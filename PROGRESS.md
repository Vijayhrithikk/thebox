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
| 1 | Calls & holds a conversation | 25 | 🟡 TTS layer proven live (251ms TTFB); phone hasn't rung yet |
| 2 | Language handling (TE/HI/EN + mixed) | 10 | 🟡 Telugu TTS audible and real; ASR/LLM code-complete, untested live |
| 3 | Discovery quality | 10 | 🟡 tools + prompt written, untuned |
| 4 | Intent classification from indirect answers | 15 | 🟡 LLM path written; deterministic scorer not started |
| 5 | Mid-call WhatsApp action | 15 | ⬜ not started (Phase 4) |
| 6 | Callback scheduling from speech | 10 | 🟡 tool captures raw phrase; resolver not built |
| 7 | Follow-up + WhatsApp quality | 10 | ⬜ not started (Phase 4) |
| 8 | Engineering judgement | 5 | 🟢 architecture defensible — see Decisions table |

---

## CURRENT STATE

**First real audio out of the pipeline, measured, not simulated.** Twilio, Soniox, and
Sarvam are live credentials now (Monish). `pnpm say` — the offline TTS diagnostic — ran
against the actual streaming path and returned **251ms time-to-first-byte** (down from
1693ms on the batch REST endpoint before the rewrite — see decisions table). DeepSeek key
still missing, so the live-call path isn't testable yet; the TTS-only path is proven.
Still no phone has actually rung — that's the next real milestone, not this one.

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
- [x] Multi-provider brain: agent.ts refactored to a provider-agnostic orchestrator over
  an `LLMProvider` interface (brain/providers/). Claude Opus 5 and DeepSeek V4 Pro both
  implemented; swapping is one env var (`LLM_PROVIDER`), zero code changes elsewhere.
  Monish is running DeepSeek live (see decisions table for the reasoning-effort latency
  guard that makes this safe).
- [x] Config decoupling fix: standalone diagnostics (say.ts) no longer blocked by an LLM
  provider key they never touch — see decisions table.
- [x] **Sarvam TTS rewritten from batch REST to a persistent streaming WebSocket**, using
  the official `sarvamai` SDK. Measured, not estimated: 1693ms -> 251ms time-to-first-byte.
  Requests mu-law @ 8kHz directly from Sarvam, eliminating our own codec conversion for the
  TTS path entirely. First real live-credential test of the project — see decisions table.

## WHAT'S NEXT

1. Sign up for Twilio **trial** (no card, 75 free voice minutes) + verify TEST_PHONE as a
   caller ID -> first live `pnpm call` to TEST_PHONE, judge whether the Telugu opener
   sounds human and the conversation loop actually holds up on a real line. Zero spend.
2. Soniox + Sarvam + Anthropic keys land -> same live test, full loop. All free-tier.
3. Phase 3: tune the deterministic intent scorer and discovery slot-filling against real
   rehearsal transcripts (Monish is fluent in Telugu + Hindi -- no external testers needed)
4. Phase 7 only: Twilio account upgrade (~₹1,700) — the single moment real money is spent,
   right before the real call to 8688664337 (see Decisions row on telephony cost below)

## OPEN BLOCKERS

- ⛔ Twilio trial signup not yet done (no cost — see decision below)
- ⛔ Soniox / Sarvam / Anthropic API keys not yet in .env (no cost — free tiers)
- ⛔ Resume PDF still needed

---

## DECISIONS + RATIONALE (interview ammunition)

| Decision | Why | Alternative rejected because |
|---|---|---|
| Custom orchestrator over Twilio Media Streams, not Vapi/Retell | We own the turn loop, so mid-call WhatsApp timing is provable and barge-in is tunable | Managed platforms make the 15-pt mid-call requirement a black box and every submission looks identical |
| Twilio (US number) for telephony | Only Tier-1 provider permitting India outbound without an Indian-entity KYC. Twilio dropped India (+91) numbers Aug 2024 but calling *to* Indian mobiles from a non-India number is explicitly permitted with recipient consent — which the brief itself grants | Exotel/Ozonetel need GST + business KYC. Plivo viable, kept as documented fallback |
| Twilio **trial** account through Phase 6; upgrade (~₹1,700) deferred to Phase 7 only | Trial gives 75 free voice minutes with no card, enough for every rehearsal — restricted only to *verified* numbers, and every rehearsal targets our own verified test number. The recruiter's number is the one call that needs an unverified line, so that's the only moment upgrading matters | Checked Plivo (min. upgrade $25, worse), Vonage, Telnyx — every legitimate provider gates unrestricted outbound behind a paid upgrade as anti-fraud regulation, not a Twilio-specific cost. Provider-shopping doesn't find cheaper |
| Rejected: physical GSM module / SIM800 or spare-Android-phone telephony bridge | Would mean discarding an already-working, typechecked Twilio WebSocket integration to hand-solder analog audio lines (module) or fight Android's OS-level restrictions on live call-audio access (phone), plus rebuilding ring/answer/hangup detection that Twilio gives for free via webhooks | Real zero-recurring-cost path, and legitimate — but the incremental saving is only the ₹1,700 already deferred to the last step, for genuine multi-day hardware/audio-debugging risk on a tight timeline. Decided with the user 2026-08-25 |
| Soniox for ASR | 8.2% Telugu WER vs Google's 37%. True streaming, automatic language ID, mid-sentence Telugu↔English code-switching with zero config | Deepgram has no real Telugu. Whisper is not streaming |
| Sarvam Bulbul v3 for TTS | Native Telugu with Tenglish code-switching, sub-250ms TTFB, Indian female voice (the brief says female lands better on outbound here), ₹30/10k chars | ElevenLabs is fine but not natively Tenglish; kept as fallback |
| Claude Opus 5 + **fast mode** in-call | `speed:"fast"` gives up to 2.5x output tokens/sec — the single biggest LLM latency lever. Best-in-class tool use, which the mid-call action depends on | — |
| Adaptive thinking at `effort:"low"`, NOT `thinking:disabled` | On Opus 5, disabled thinking can emit a tool call as **plain text** — the call silently never runs and no error is raised. In a voice agent that means the WhatsApp never fires. Unacceptable risk on a 15-point requirement | `thinking:disabled` looked like the obvious latency win; it isn't |
| Multi-provider brain — `LLMProvider` interface, Claude + DeepSeek both implemented | Monish wants to run DeepSeek V4 Pro personally (far cheaper per token than Claude). `agent.ts` owns only the turn loop/tool dispatch/barge-in-abort against a neutral `Turn[]` history; each provider translates that into its own wire format. Switching costs one env var, zero code | A single hard-coded Anthropic client would have meant a real rewrite to switch, not a config flag — the whole point of the abstraction |
| DeepSeek live-call turns forced to `reasoning_effort:"low"`, never higher | The flagship (`deepseek-v4-pro`) at high/max reasoning is independently benchmarked at 12-30s to first token — a dead call, not a slow one. `deepseek.ts`'s constructor takes the effort level explicitly so the live-call factory can hard-code "low" regardless of any other config, the same defense-in-depth pattern as the Claude thinking-disabled guard above | Letting `reasoning_effort` be freely configurable risked exactly the failure mode the Claude guard exists to prevent, just from a different provider |
| Provider API keys removed from config.ts's eager schema; moved to `assertProviderConfigured()` in brain/providers/index.ts, called once at server.ts boot | The global env schema was blocking `say.ts` — a pure TTS diagnostic — on a DeepSeek key it never uses, just because both modules imported the same monolithic config. Moved the check to point of use instead: standalone scripts stay unblocked, the real server still fails at boot, not mid-call | Telling the user to paste a fake key to unblock testing would have been a workaround for a real coupling bug, not a fix |
| Empty-string env vars (`KEY=`) stripped before Zod validation | dotenv parses an unset `KEY=` as `""`, not `undefined` — Zod's `.optional()` only treats `undefined` as absent, so `ANTHROPIC_API_KEY=` failed its own `.min(5)` check even though it was correctly meant to be "not set". Caught live: this blocked the first real `pnpm say` run | A one-line default anyone editing `.env` would trip over otherwise |
| Sarvam TTS: persistent streaming WebSocket per call, not one REST POST per sentence | First live test measured 1693ms time-to-first-byte on the batch endpoint — each sentence paid a fresh TLS handshake plus waited for the *entire* clip before any audio was usable. Rewrote against the official `sarvamai` SDK's streaming client, one socket opened per call and reused for every sentence. Re-measured: **251ms**, a 6.7x cut, matching Sarvam's own advertised streaming latency. Also requests `output_audio_codec:"mulaw"` + `speech_sample_rate:8000` directly, so Sarvam's output needs zero conversion before hitting Twilio | Would have shipped the 1.7s version if `pnpm say` hadn't been run against real credentials before wiring it into the live call path — validated by measurement, not assumption |
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
