import { resolve } from "node:path";
import { existsSync } from "node:fs";
import { env } from "../config.js";
import type { LLMProvider } from "../brain/providers/types.js";
import { sendImage, sendDocument, sendWhatsApp } from "./whatsapp.js";

/**
 * The post-call follow-up — a separate, explicitly scored requirement
 * (assignment brief, Section 06) from the mid-call HOT ping in
 * liveActionSink's replacement (server.ts's /webhooks/classify). That one
 * has to exist within milliseconds of a tool call and is a filled template;
 * this one fires once, after the call actually ends, has the whole
 * conversation to draw on, and must carry all four required things:
 *   1. Real context from the call (not a generic summary)
 *   2. Written the way a person would write it, not a log dump
 *   3. The candidate's mobile number
 *   4. An image of the architecture
 * Resume goes with it too, per the brief, though it's not one of the four.
 */

export interface CallOutcome {
  callerNumber: string;
  classification?: "hot" | "warm" | "cold";
  summary?: string;
  budget?: string;
  business?: string;
  productCount?: string;
  timeline?: string;
  features?: string;
  callbackRequested?: boolean;
  callbackTime?: string;
}

const COMPOSER_PROMPT = `You write a single WhatsApp follow-up message after a real sales call, on
behalf of ${"${name}"} — a software developer in Hyderabad who builds e-commerce websites.

You are given a summary of what was actually discussed on the call. Write like a person
texting after a real conversation, not a CRM export: reference the specific things they
said (their business, budget, timeline — whatever is actually known), never invent details
that weren't given, and never use placeholder-sounding phrasing like "your business" if the
business type is known. Keep it warm, short, and human — a few sentences, not a report.
End with an invitation to reach out, and the phone number will be added separately so do
not repeat it yourself. No markdown, no bullet points, no emoji.`;

export async function composeFollowUpText(outcome: CallOutcome, provider: LLMProvider): Promise<string> {
  const name = env.CANDIDATE_NAME || "the developer";
  const facts = [
    outcome.summary && `Call summary: ${outcome.summary}`,
    outcome.business && `Business: ${outcome.business}`,
    outcome.budget && `Budget mentioned: ${outcome.budget}`,
    outcome.productCount && `Product count: ${outcome.productCount}`,
    outcome.timeline && `Timeline: ${outcome.timeline}`,
    outcome.features && `Features wanted: ${outcome.features}`,
    outcome.classification && `Read on the lead: ${outcome.classification}`,
    outcome.callbackRequested && `They asked to be called back: ${outcome.callbackTime ?? "time given"}`,
  ]
    .filter(Boolean)
    .join("\n");

  const result = await provider.streamTurn({
    systemPrompt: COMPOSER_PROMPT.replace("${name}", name),
    history: [{ role: "user", text: facts || "No specific details were captured on this call." }],
    tools: [],
    onSentence: () => {},
    signal: new AbortController().signal,
  });

  return result.text.trim();
}

/**
 * Sends the full follow-up: the composed text (context + framing + number),
 * the architecture image, and the resume — three separate WhatsApp messages,
 * since Baileys sends one attachment per message the same way a person would.
 */
export async function sendFollowUp(
  outcome: CallOutcome,
  provider: LLMProvider,
  log: (obj: unknown, msg: string) => void,
): Promise<void> {
  const text = await composeFollowUpText(outcome, provider);
  const number = env.CANDIDATE_PHONE ? `\n\nYou can reach ${env.CANDIDATE_NAME || "me"} directly at ${env.CANDIDATE_PHONE}.` : "";
  await sendWhatsApp(outcome.callerNumber, text + number, log);

  const imagePath = resolve(process.cwd(), env.ARCHITECTURE_IMAGE_PATH);
  if (existsSync(imagePath)) {
    await sendImage(outcome.callerNumber, imagePath, "How the system that just called you was built.", log);
  } else {
    log({ imagePath }, "architecture image not found — skipping");
  }

  const resumePath = resolve(process.cwd(), env.RESUME_PATH);
  if (existsSync(resumePath)) {
    await sendDocument(outcome.callerNumber, resumePath, "application/pdf", `${env.CANDIDATE_NAME || "resume"}.pdf`, log);
  } else {
    log({ resumePath }, "resume not found — skipping");
  }
}
