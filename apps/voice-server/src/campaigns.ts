import { randomUUID } from "node:crypto";
import { placeCall, isTelephonyConfigured } from "./telephony/index.js";

/**
 * Calling numbers one at a time, from our own console, instead of Sarvam's
 * portal — a CSV upload or a single quick-dial both become a "campaign"
 * (a list of contacts to dial), processed sequentially by one dispatcher
 * loop below. In-memory only, same tradeoff as monitoring.ts: this doesn't
 * need to survive a restart to be useful for a demo.
 *
 * Retries: "placed" only means the API accepted the request — it says
 * nothing about whether the person actually answered. recordCallOutcome()
 * is fed by the /webhooks/call-completed route (which gets a real
 * connected/no_answer/busy/failed status from Sarvam's call infra) and
 * requeues no-answer/busy/failed contacts for another attempt, up to a cap.
 */

export type ContactStatus = "queued" | "calling" | "placed" | "connected" | "no_answer" | "failed";

export interface CampaignContact {
  id: string;
  number: string;
  name?: string;
  status: ContactStatus;
  attemptId?: string;
  attempts: number;
  error?: string;
  calledAt?: string;
  /** Set when requeued after a no-answer/busy/failed outcome — the dispatcher won't pick this contact up again before this time, so retries don't hammer the number back-to-back. */
  retryAfter?: string;
}

export interface Campaign {
  id: string;
  createdAt: string;
  label: string;
  contacts: CampaignContact[];
}

const campaigns = new Map<string, Campaign>();
const order: string[] = [];
/** attempt_id -> which contact placed it, so the call-completed webhook (keyed by attempt_id) can update the right contact and decide whether to retry. */
const attemptIndex = new Map<string, { campaignId: string; contactId: string }>();

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
    .map((c) => ({ id: randomUUID(), number: c.number, name: c.name, status: "queued" as const, attempts: 0 }));

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

/**
 * Called from the call-completed webhook once Sarvam reports what actually
 * happened on a placed call. "connected" is terminal (success, whatever
 * happens on the call from there is tracked via the classify/discovery
 * webhooks). Anything else is a no-answer/busy/failed outcome, and gets
 * requeued up to MAX_ATTEMPTS with a cooldown between tries.
 */
const MAX_ATTEMPTS = 3;
const RETRY_DELAY_MS = 3 * 60_000;

export function recordCallOutcome(attemptId: string | undefined, status: string | undefined): void {
  if (!attemptId) return;
  const ref = attemptIndex.get(attemptId);
  if (!ref) return;
  const contact = campaigns.get(ref.campaignId)?.contacts.find((c) => c.id === ref.contactId);
  if (!contact) return;

  if (status === "connected") {
    contact.status = "connected";
    return;
  }

  if (contact.attempts < MAX_ATTEMPTS) {
    contact.status = "queued";
    contact.retryAfter = new Date(Date.now() + RETRY_DELAY_MS).toISOString();
  } else {
    contact.status = "failed";
    contact.error = `not answered after ${contact.attempts} attempt(s) — last status: ${status ?? "unknown"}`;
  }
}

/** One rented number, one call at a time — overlapping outbound attempts would just collide on it. */
const DIAL_SPACING_MS = 25_000;
const IDLE_POLL_MS = 3_000;
const UNCONFIGURED_RETRY_MS = 10_000;

function findNextQueued(): { campaign: Campaign; contact: CampaignContact } | undefined {
  const now = Date.now();
  for (const id of order) {
    const campaign = campaigns.get(id);
    if (!campaign) continue;
    const contact = campaign.contacts.find(
      (c) => c.status === "queued" && (!c.retryAfter || new Date(c.retryAfter).getTime() <= now),
    );
    if (contact) return { campaign, contact };
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
    const { campaign, contact } = next;
    contact.status = "calling";
    contact.attempts += 1;
    contact.retryAfter = undefined;
    try {
      const result = await placeCall({ to: contact.number, sessionId: randomUUID() });
      const attemptId = (result as { attempt_id?: string }).attempt_id;
      contact.status = "placed";
      contact.attemptId = attemptId;
      contact.calledAt = new Date().toISOString();
      contact.error = undefined;
      if (attemptId) attemptIndex.set(attemptId, { campaignId: campaign.id, contactId: contact.id });
      log({ number: contact.number, attemptId, attempt: contact.attempts }, "campaign call placed");
    } catch (err) {
      contact.error = err instanceof Error ? err.message : String(err);
      contact.calledAt = new Date().toISOString();
      if (contact.attempts < MAX_ATTEMPTS) {
        contact.status = "queued";
        contact.retryAfter = new Date(Date.now() + RETRY_DELAY_MS).toISOString();
      } else {
        contact.status = "failed";
      }
      log({ number: contact.number, err, attempt: contact.attempts }, "campaign call failed to place");
    }
    await sleep(DIAL_SPACING_MS);
  }
}
