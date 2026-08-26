import { randomUUID } from "node:crypto";
import { placeCall, isTelephonyConfigured } from "./telephony/index.js";

/**
 * Calling numbers one at a time, from our own console, instead of Sarvam's
 * portal — a CSV upload or a single quick-dial both become a "campaign"
 * (a list of contacts to dial), processed sequentially by one dispatcher
 * loop below. In-memory only, same tradeoff as monitoring.ts: this doesn't
 * need to survive a restart to be useful for a demo. Per-call outcomes
 * (classification, discovery, follow-up) still come from the existing
 * webhook events — this module only owns "did we place the call."
 */

export type ContactStatus = "queued" | "calling" | "placed" | "failed";

export interface CampaignContact {
  id: string;
  number: string;
  name?: string;
  status: ContactStatus;
  attemptId?: string;
  error?: string;
  calledAt?: string;
}

export interface Campaign {
  id: string;
  createdAt: string;
  label: string;
  contacts: CampaignContact[];
}

const campaigns = new Map<string, Campaign>();
const order: string[] = [];

/** Loose E.164-ish normalization for CSV rows that dropped the country code — assumes India (+91) for bare 10-digit numbers, since that's this project's whole audience. Anything already starting with "+" is trusted as-is. */
function normalizeNumber(raw: string): string {
  const trimmed = raw.trim().replace(/[\s-]/g, "");
  if (trimmed.startsWith("+")) return trimmed;
  const digits = trimmed.replace(/\D/g, "");
  if (digits.length === 10) return `+91${digits}`;
  if (digits.length === 12 && digits.startsWith("91")) return `+${digits}`;
  return trimmed;
}

export function createCampaign(label: string, rawContacts: { number: string; name?: string }[]): Campaign {
  const contacts: CampaignContact[] = rawContacts
    .map((c) => ({ number: normalizeNumber(c.number), name: c.name?.trim() }))
    .filter((c) => c.number.length >= 8)
    .map((c) => ({ id: randomUUID(), number: c.number, name: c.name, status: "queued" as const }));

  const campaign: Campaign = { id: randomUUID(), createdAt: new Date().toISOString(), label, contacts };
  campaigns.set(campaign.id, campaign);
  order.unshift(campaign.id);
  return campaign;
}

/** Newest campaign first, as created. */
export function listCampaigns(): Campaign[] {
  return order.map((id) => campaigns.get(id)).filter((c): c is Campaign => Boolean(c));
}

export function getCampaign(id: string): Campaign | undefined {
  return campaigns.get(id);
}

/** One rented number, one call at a time — overlapping outbound attempts would just collide on it. Fixed spacing between dials rather than waiting for the previous call to end, since call duration varies and we don't get a live "call finished" push from Sarvam mid-loop. */
const DIAL_SPACING_MS = 25_000;
const IDLE_POLL_MS = 3_000;
const UNCONFIGURED_RETRY_MS = 10_000;

function findNextQueued(): CampaignContact | undefined {
  for (const id of order) {
    const contact = campaigns.get(id)?.contacts.find((c) => c.status === "queued");
    if (contact) return contact;
  }
  return undefined;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

let started = false;

/** Fire-and-forget background loop, started once at boot — mirrors initWhatsApp's pattern in server.ts. */
export function startCampaignDispatcher(log: (obj: unknown, msg: string) => void): void {
  if (started) return;
  started = true;
  void runLoop(log);
}

async function runLoop(log: (obj: unknown, msg: string) => void): Promise<void> {
  for (;;) {
    if (!isTelephonyConfigured()) {
      await sleep(UNCONFIGURED_RETRY_MS);
      continue;
    }
    const next = findNextQueued();
    if (!next) {
      await sleep(IDLE_POLL_MS);
      continue;
    }
    next.status = "calling";
    try {
      const result = await placeCall({ to: next.number, sessionId: randomUUID() });
      next.status = "placed";
      next.attemptId = (result as { attempt_id?: string }).attempt_id;
      next.calledAt = new Date().toISOString();
      log({ number: next.number, attemptId: next.attemptId }, "campaign call placed");
    } catch (err) {
      next.status = "failed";
      next.error = err instanceof Error ? err.message : String(err);
      next.calledAt = new Date().toISOString();
      log({ number: next.number, err }, "campaign call failed");
    }
    await sleep(DIAL_SPACING_MS);
  }
}
