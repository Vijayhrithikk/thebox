Built an outbound AI voice agent: Exotel places the call, Sarvam's Voice Agent runs the
live conversation (speech-to-text, reasoning, text-to-speech, and the tool-calling that
decides when to act), and a small backend of mine receives those tool calls to fire a
WhatsApp the moment a lead reads Hot, book a real callback from spoken time like "call me
tomorrow morning," and send a full post-call follow-up — real conversation context, my
number, the architecture image, and my resume — as soon as the call ends.

What works: the call places itself and holds a real bilingual conversation (Telugu-first,
switches languages naturally), classification and discovery fire correctly off indirect
phrasing, the mid-call WhatsApp lands while the call is still connected, callback scheduling
resolves vague spoken time into an actual re-dial, and the full follow-up (text + image +
resume) sends automatically. Deployed and live, not running off my laptop.

What doesn't yet: the callback scheduler is in-memory, not database-backed, so it doesn't
survive a restart. Voicemail/answering-machine detection isn't built.

What's next: persistence for scheduling, and wider rehearsal on pure Hindi and heavier
Telugu-English code-switching, tested less than the Telugu-first path so far.
