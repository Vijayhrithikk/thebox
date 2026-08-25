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
| 1 | Calls & holds a conversation | 25 | 🟡 Phone rings and connects for real (Twilio); full pipeline unheard live — blocked on Telnyx account clearing payment review (see blockers) |
| 2 | Language handling (TE/HI/EN + mixed) | 10 | 🟡 Telugu TTS audible and real; ASR/LLM code-complete, untested live |
| 3 | Discovery quality | 10 | 🟡 tools + prompt written, untuned |
| 4 | Intent classification from indirect answers | 15 | 🟡 Extraction path live-tested and working (correct warm/hot + evidence quotes); deterministic second path not started |
| 5 | Mid-call WhatsApp action | 15 | ⬜ not started (Phase 4) |
| 6 | Callback scheduling from speech | 10 | 🟢 resolver live-tested: relative dates, festival anchors, ambiguous times all correct |
| 7 | Follow-up + WhatsApp quality | 10 | ⬜ not started (Phase 4) |
| 8 | Engineering judgement | 5 | 🟢 architecture defensible — see Decisions table |

---

## CURRENT STATE

**The brain is now proven live too, and a real latency bug was found and fixed by testing,
not assumed.** All four credentials landed (Twilio, Soniox, Sarvam, DeepSeek). `pnpm chat`
— the offline brain diagnostic — surfaced that giving the live conversational turn tool
access (classify_lead/note_discovery/request_callback) made DeepSeek go completely silent
for a full extra API round trip before speaking a word: **6.4s** first-sentence on the
flagship, **3.6s** even on the fast model — both blowing past the brief's explicit "three
seconds and the conversation is dead" bar. Fixed architecturally: the live agent now never
sees tools at all (guaranteeing exactly one API call per turn), and all tool-calling moved
to a separate parallel side-channel (`signalExtractor.ts`) that reads the same transcript
without ever blocking the spoken reply. Re-measured: **~2-3s** first-sentence, consistent
across four runs. Also found the flagship (`deepseek-v4-pro`) is ~5x slower than
`deepseek-v4-flash` even with tools removed, and showed weaker JSON-schema adherence on
tool calls — so the live path is now hard-coded to flash regardless of `DEEPSEEK_MODEL`,
with the flagship reserved for the offline post-call composition where its slowness
genuinely doesn't matter. TTS layer: `pnpm say` still measures 251ms time-to-first-byte.
Callback scheduling (`pnpm schedule`) also live-tested and correct — relative dates,
festival anchors, ambiguous times all resolve right, after one prompt-tuning pass.

**Deployment: ngrok recovered via a Microsoft Store install** (signed/vetted, sidesteps the
Defender false-positive that blocked the WinGet copy and a fresh manual download) — tunnel
came up clean, so we used it for the first live call instead of waiting on Fly.io.

**Two real phone calls placed 2026-08-25, same result both times, root cause now confirmed
via Twilio's own documentation.** Phone rang, Monish answered, heard Twilio's trial prompt,
pressed a key, call ended — no Telugu greeting, `/media` never hit. Second call (after
fixing the `/call-status` 415 bug) gave full status visibility: `initiated -> ringing ->
in-progress -> completed`, ~13s connected both times, zero `/media` hits both times.
**Definitive mechanism, confirmed via Twilio docs, not just inference:** `<Stream>` — the
verb this whole architecture is built on — is explicitly blocked on trial accounts,
replaced with a spoken "the Stream verb is not available on trial accounts" message. Our
TwiML has nothing after `<Connect><Stream>`, so the call ends right after that message.
Also found and fixed a real, separate bug along the way: `/call-status` was hitting 415
(Fastify had no form-urlencoded parser), fixed with `@fastify/formbody`.

**Two corrections to earlier assumptions, both recorded plainly in the decisions table**
rather than silently revised: first that the trial disclaimer was passive (wrong — it's
interactive), then that the block was "just" the disclaimer (wrong — Media Streams itself
is hard-refused on trial, confirmed by the user directly questioning the first explanation
and prompting a check of Twilio's actual docs).

**Pivoted telephony provider to Telnyx 2026-08-25.** Monish declined to spend Twilio's
$20 trial-removal fee. Researched alternatives (Plivo needs a $25 minimum, worse); Telnyx
has no forced minimum deposit, at the cost of a possible up-to-48h payment review before
outbound calls actually place — Monish explicitly accepted that tradeoff. Built a full
`AudioSink` abstraction so `CallSession` no longer knows which provider it's talking to,
implemented `telephony/telnyx.ts` (Call Control Dial API — streaming params go directly on
the outbound dial, not declarative TwiML) against field names read straight from the
official `telnyx` SDK's `.d.ts` files (guessed doc URLs 404'd), and a provider factory
(`telephony/index.ts`) so Twilio stays fully wired as a fallback behind one env var.
`server.ts` now runs both providers' routes side by side. Typechecked clean, committed.
Two gaps are flagged in code, not hidden: no confirmed Telnyx equivalent of Twilio's `mark`
(playback-complete is inferred from elapsed time) or `clear` (barge-in flush) — both
unverifiable until a real call gets through. Fly.io Dockerfile/fly.toml still ready as the
eventual production target. The immediate next step is Monish finishing Telnyx signup and
the account clearing review, then the first live call attempt over Telnyx.

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
- [x] **Telephony provider abstraction + Telnyx adapter.** `AudioSink` interface decouples
  `CallSession` from the specific provider; `telephony/telnyx.ts` implements outbound
  dialing + bidirectional streaming via Telnyx's Call Control API; `telephony/index.ts`
  factory picks Twilio or Telnyx off `TELEPHONY_PROVIDER`. Both providers' routes live in
  `server.ts` side by side. Typechecked, committed.

## WHAT'S NEXT

1. **Blocked on Monish: finish Telnyx signup** (steps in `docs/SETUP.md` §1a), then wait
   out the payment review (up to 48h). Once `TELNYX_API_KEY`/`TELNYX_PHONE_NUMBER`/
   `TELNYX_CONNECTION_ID` are real, retry `pnpm call` to TEST_PHONE over the already-working
   ngrok tunnel. This is the real milestone: TTS and brain are separately proven over
   text/audio, but nothing has confirmed the full ASR -> brain -> TTS loop holds up on an
   actual phone line yet. First live Telnyx call is also the first check on the two
   documented gaps (mark/clear equivalents) — see decisions table.
2. Phase 3: build the deterministic signal scorer as the second, non-LLM path to
   Hot/Warm/Cold (the LLM-only extraction path already works — this is the redundancy
   the plan calls for so the 15-pt mid-call requirement can't fail on one missed call)
3. Phase 4: wire real WhatsApp dispatch behind the same ActionSink interface the console
   sink already proves out; wire the callback resolver's output into an actual re-dial
4. Fly.io Mumbai deployment (Dockerfile/fly.toml ready, smoke-tested) once we're closer to
   the real call — needed for production reliability, not blocking further dev testing
   now that ngrok is working

## OPEN BLOCKERS

- ⛔ **Telnyx account pending signup/payment review** — blocks the first live end-to-end
  call. Twilio remains fully wired as a fallback (needs its own $20 upgrade to unblock,
  which Monish has declined) — see decisions table.
- ⛔ DATABASE_URL still a placeholder — needed for Phase 4 callback persistence, not before
- ⛔ Resume PDF still needed

---

## DECISIONS + RATIONALE (interview ammunition)

| Decision | Why | Alternative rejected because |
|---|---|---|
| Custom orchestrator over Twilio Media Streams, not Vapi/Retell | We own the turn loop, so mid-call WhatsApp timing is provable and barge-in is tunable | Managed platforms make the 15-pt mid-call requirement a black box and every submission looks identical |
| Twilio (US number) for telephony | Only Tier-1 provider permitting India outbound without an Indian-entity KYC. Twilio dropped India (+91) numbers Aug 2024 but calling *to* Indian mobiles from a non-India number is explicitly permitted with recipient consent — which the brief itself grants | Exotel/Ozonetel need GST + business KYC. Plivo viable, kept as documented fallback |
| ~~Twilio **trial** account through Phase 6~~ — **superseded, see row below** | ~~Trial gives 75 free voice minutes, restricted only to verified numbers, every rehearsal targets our own verified number~~ | This assumed the trial disclaimer was a passive announcement. It isn't — see the correction below |
| **Correction #2, confirmed via Twilio's own docs 2026-08-25:** `<Stream>` — Media Streams, the exact verb this entire architecture is built on — is explicitly, completely blocked on trial accounts. Twilio's docs: the verb is replaced with a spoken message, *"The Stream verb is not available on trial accounts."* Our TwiML has nothing after `<Connect><Stream>`, so that message plays and the call ends right after — exactly the "cut off after keypress" behavior observed twice, now with a documented mechanism instead of just repeated inference. Two live calls, identical timing (~13s connected, zero `/media` hits), both consistent with this. There is no code workaround; upgrading is the only path, and it blocks *any* Media-Streams-based testing, not just the disclaimer | Correction #1 (below) diagnosed the right *symptom* — trial blocks the call — but the wrong *mechanism* — an interactive disclaimer gating things, rather than the Stream verb being hard-refused outright. The user directly questioning "is this really an upgrade issue?" is what prompted checking Twilio's own docs instead of resting on the first (correct-shaped but imprecise) diagnosis | Live testing plus a user pushing back on an explanation that didn't quite fit is what surfaced the precise mechanism — worth recording that the first correction was directionally right but not fully accurate |
| **Correction #1 (superseded by #2 above), live-tested 2026-08-25:** Twilio trial's disclaimer is an *interactive* IVR prompt ("press any key to accept"), not a passive message — it blocks our TwiML from ever executing until a human presses a key, then the call ends before `<Connect><Stream>` runs. First real call attempt: phone rang, Monish answered, heard only the English Twilio trial prompt, pressed a key, call ended — our Telugu greeting never played, `/media` never saw a connection. Upgrading is no longer a Phase-7-only decision — it blocks testing the core deliverable at all, not just the final call | The original assumption (verified above, wrong) was that the trial's only two restrictions were "verified numbers only" and "a passive disclaimer," neither blocking rehearsal. Live testing is what caught this — the assumption was reasonable but incomplete, and only a real call surfaced the gap | Would have kept assuming trial was fine for all rehearsals and only discovered this blocker later, closer to the real call, with less runway to react |
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
| Live conversational turn never sends tools; classify/discovery/callback moved to a parallel `signalExtractor.ts` side-channel | Live-measured: the moment the live turn included tool schemas, DeepSeek produced a silent tool-only response with zero spoken text every time, forcing a second sequential API round trip before any audio could start — 6.4s (flagship) and 3.6s (flash) to first sentence, both past the brief's "three seconds and the conversation is dead" bar. A prompt instruction telling it to speak *and* call tools together had zero measured effect — this is how the API's tool-calling shape behaves, not a promptable preference. Splitting extraction into its own concurrent, never-awaited call cut first-sentence latency to ~2-3s, consistent across four runs, while classification/discovery still land correctly (verified: budget/timeline/business extracted, correct hot/warm/cold with real evidence quotes) | Tried the cheap fix first (a prompt instruction) and measured that it didn't work before reaching for the architectural one — this is also the exact "deterministic path runs in parallel with the LLM" design the plan already committed to for intent classification; live testing just proved it wasn't optional or Phase-3-only |
| DeepSeek live path hard-coded to `deepseek-v4-flash`, never `DEEPSEEK_MODEL`; flagship (`deepseek-v4-pro`) reserved for `createDeepReasoningProvider()` | Even with tools stripped from the live turn, the flagship measured ~10s to first token on a plain conversational reply — roughly 5x flash on the identical prompt — and showed weaker JSON-schema adherence on tool calls in the extractor (invented its own key names instead of following the declared schema). Flash is fast enough to hold a conversation; the flagship's quality is real but only usable where nobody's waiting on the line | Matches what "flagship" was actually asked for: use it, but only where its slowness is invisible — the post-call WhatsApp follow-up (Phase 4), not the live call |
| Callback resolution via a single-tool LLM call (`callbackResolver.ts`), not a date-parsing library | "After Diwali" needs calendar knowledge no date library has, and open-ended Indian-English phrasing ("next Monday around 6", "sometime, I'll let you know") doesn't fit a fixed grammar. Live-tested: correctly computed "next Monday" from the actual current date, resolved "around 6" to an approximate evening time, and correctly distinguished a real-but-vague anchor ("after Diwali") from a genuinely unusable one ("sometime") — after one prompt-tuning pass caught the model being too conservative and declining to resolve the Diwali case at all on the first try | A hand-rolled parser would need to encode Indian festival dates and open-ended phrasing rules by hand, and would still fail on phrasing nobody thought to test for |
| Fly.io Mumbai deployment instead of an ngrok dev tunnel | Attempted ngrok first (free, fastest path to a public wss:// endpoint). Its binary — both the pre-installed WinGet copy trying to self-update, and a fresh official download — got flagged and blocked by Windows Defender as a virus. Very likely a false positive, but silently bypassing antivirus on the user's machine isn't a call to make unilaterally; asked, and the user chose to skip it rather than touch Defender settings. Fly.io was always the real production target anyway (Mumbai region, closest to Indian carriers and Sarvam) — this just means we build it now instead of in Phase 6/7 | Fly.io dropped its card-free tier in 2024 — this is real, small, ongoing cost (a few $/month for one always-on shared-cpu-1x instance), not deferred like Twilio's one-time upgrade. Flagged clearly to the user given how much of this session was about avoiding upfront spend — this one genuinely can't be avoided if we need a live endpoint |
| Fly deployment kept `min_machines_running = 1`, `auto_stop_machines = "off"` | A cold-started machine adds real latency right when a call connects — directly hostile to the turn-latency budget we just spent this whole session cutting from 6-10s to 2-3s. Keeping one instance always warm is a small cost for guaranteeing the connection is live and fast the instant Twilio dials in | Fly's default auto-stop-on-idle is the cheaper choice for most apps, but wrong for a voice agent scored on responsiveness |
| Registered `@fastify/formbody` for `/call-status` | Found on the very first live call attempt: Twilio POSTs its status callback as `application/x-www-form-urlencoded`, which Fastify has no parser for by default — every callback was hitting a 415 before it ever reached our handler. Not fatal to the call itself (Twilio just logs a warning and moves on), but it meant zero visibility into real call-status transitions (ringing/answered/completed) during exactly the debugging session that needed them most | Only discoverable by actually placing a call — no amount of unit testing or code review surfaces a missing content-type parser for a webhook you've never received live |
| Mid-conversation system messages for live state | Opus 5 accepts `role:"system"` inside `messages[]`, so we inject elapsed time / intent score / "WhatsApp already sent" without invalidating the cached prefix | Rebuilding the system prompt each turn would cold-cache every turn |
| Dual-path intent detection | A deterministic signal scorer runs in parallel with the LLM; whichever crosses the threshold first fires the WhatsApp | Sole reliance on an LLM tool call means one missed call = 15 points gone |
| Fly.io `bom` (Mumbai) | Physically closest region to Indian carriers and to Sarvam. Every ms of RTT is scored under "latency kills the conversation" | Vercel can't hold long-lived WebSockets; US regions add ~200ms round trip |
| TypeScript end to end | One language across realtime server and console; every line has to be defensible in the interview | — |
| Spend ₹2-4k upfront on real tiers, not free/trial | Brief states cost is not the filter and reimburses on join. A Twilio *trial* account cannot call an unverified number at all and prepends a disclosure message — that alone fails requirement #1 regardless of everything else built | The ₹500-600 free-tier path looked safer but is not actually viable for this specific requirement |
| Switched primary telephony from Twilio to Telnyx, 2026-08-25 | Monish declined to spend the $20 needed to remove Twilio's trial restriction, even after the mechanism was confirmed to fully block the core deliverable. Researched real alternatives rather than re-arguing the point: Plivo needs a $25 minimum (worse), Telnyx has no forced minimum deposit at all. Tradeoff — up to 48h payment review before a Telnyx number can place calls — was surfaced explicitly and accepted by Monish via a direct choice between "wait it out" and other options | Kept arguing for the Twilio upgrade after a clear, repeated refusal would have been re-litigating a decision that was already made — the job was to find the actual no-cost path, not to keep selling the paid one |
| `AudioSink` interface + provider factory (`telephony/index.ts`), rather than an `if (provider === 'twilio')` branch inside `CallSession` | `CallSession` already owns enough real-time complexity (ASR, VAD, barge-in, turn state) — it shouldn't also know which telephony wire format it's talking over. Twilio and Telnyx use different message envelopes and different (or unconfirmed) playback-confirmation/buffer-flush signals; isolating that behind one interface means the swap in scripts/call.ts, server.ts's routes, and CallSession's constructor was mechanical, not a rewrite | A branch inside CallSession would have been faster to write once, but every future provider (or the eventual real WhatsApp/callback re-dial code touching call state) would have had to know about both wire formats too |
| Telnyx Call Control Dial API (stream_url on the outbound dial) over TeXML's declarative `<Stream>` verb | Confirmed via WebFetch that TeXML exists and is closer to Twilio's model, but it's still webhook-driven for an inherently simple case: we already know at dial time that we want bidirectional streaming for the whole call. Passing `stream_url`/`stream_track`/`stream_bidirectional_*` straight on `calls.dial()` (confirmed via the official `telnyx` SDK's `calls.d.ts`) starts streaming automatically the moment the call answers — no extra webhook round trip to explicitly start it | TeXML would have meant maintaining two different declarative-markup dialects (Twilio's TwiML and Telnyx's TeXML) for the same job the Call Control API does in one API call |
| Twilio's `twilioClient` eager module-scope construction converted to lazy, proactively, before it caused a live failure | Caught while making `TWILIO_ACCOUNT_SID`/`TWILIO_AUTH_TOKEN` optional in the schema: the old `export const twilioClient = twilio(sid, token)` at module scope would throw the instant this file is imported, since those vars are now legitimately empty whenever `TELEPHONY_PROVIDER=telnyx` — which is the default. Same class of bug already fixed once for the LLM provider modules (see the `assertProviderConfigured()` row above) | Waiting to hit this as a live crash would have meant a broken server on the very next boot, for a bug that was visible just from reading the diff that made the env vars optional |

---

## CHANGELOG

- **2026-08-25** — Assignment received. Plan approved. Repo scaffolded, stack locked.
- **2026-08-25** — Candidate identity confirmed (M. Monish Vijay, +91 7330671778, doubling as test number). Budget decision: real paid tiers, not free/trial. Phase 1 telephony spine committed.
- **2026-08-25** — Phase 2 realtime loop written and typechecked clean: Soniox ASR, dual-signal barge-in (VAD + ASR partials), Claude Opus 5 fast-mode agent with sentence-streamed TTS and non-blocking tool calls. Blocked on live credentials for the real test — code compiling is not the bar, a working call is.
- **2026-08-25** — Two live Twilio calls confirmed the trial account hard-blocks `<Stream>` entirely (not just a passive disclaimer — corrected in the decisions table after the user directly questioned the first explanation). Monish declined the $20 upgrade. Pivoted primary telephony to Telnyx: built `AudioSink` abstraction, `telephony/telnyx.ts` (Call Control Dial API, field names read from the official SDK's `.d.ts`), and a provider factory so Twilio stays wired as a fallback. `server.ts`, `session.ts`, `scripts/call.ts` all updated to the new abstraction; typechecked clean, committed. Blocked on Monish finishing Telnyx signup and the account clearing payment review before the first live end-to-end call can be attempted.
