import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { resolve, dirname } from "node:path";

/**
 * The whole "backend to monitor calls" requirement: an in-memory ring
 * buffer of everything the webhooks receive, mirrored to disk so a
 * container restart (a redeploy, an env change, a crash) doesn't wipe it
 * — this was pure in-memory originally ("doesn't need to survive a
 * restart for a demo"), which stopped being true the moment the console
 * became the actual system of record. The file lives under this
 * process's cwd (apps/voice-server), same pattern as QR_IMAGE_PATH — in
 * production that path is bind-mounted to a host directory so it
 * survives `docker rm` + `docker run`, not just `docker restart`.
 */

export type EventType = "classify" | "discovery" | "callback" | "call_ended";

export interface NewMonitoringEvent {
  type: EventType;
  [key: string]: unknown;
}

export interface MonitoringEvent extends NewMonitoringEvent {
  at: string;
}

const MAX_EVENTS = 2000;
const DATA_FILE = resolve(process.cwd(), "data/events.json");

function loadEvents(): MonitoringEvent[] {
  try {
    if (existsSync(DATA_FILE)) return JSON.parse(readFileSync(DATA_FILE, "utf8"));
  } catch {
    // corrupt or unreadable — start fresh rather than crash the boot
  }
  return [];
}

function persist(): void {
  try {
    mkdirSync(dirname(DATA_FILE), { recursive: true });
    writeFileSync(DATA_FILE, JSON.stringify(events));
  } catch (err) {
    console.error("failed to persist events to disk", err);
  }
}

const events: MonitoringEvent[] = loadEvents();

/** `atOverride` lets the Sarvam-history backfill insert events at their real historical timestamp instead of "now". */
export function recordEvent(event: NewMonitoringEvent, atOverride?: string): void {
  events.push({ ...event, at: atOverride ?? new Date().toISOString() });
  if (events.length > MAX_EVENTS) events.shift();
  persist();
}

/** Used by the backfill to skip interactions it's already imported or that a live webhook already captured. */
export function hasCallEndedFor(sessionId: string): boolean {
  return events.some((e) => e.type === "call_ended" && e.session_id === sessionId);
}

/** Newest first — what the console actually wants to render. */
export function getEvents(): MonitoringEvent[] {
  return [...events].reverse();
}
