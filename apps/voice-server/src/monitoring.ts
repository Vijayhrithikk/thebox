/**
 * The whole "backend to monitor calls" requirement, kept deliberately
 * small: an in-memory ring buffer of everything the webhooks receive, and
 * one GET route (server.ts's /events) for the console to poll. No
 * database — this doesn't need to survive a restart to be useful for a
 * demo, and DATABASE_URL is still a placeholder. If this needs to persist
 * later, this is the one place that changes.
 */

export type EventType = "classify" | "discovery" | "callback" | "call_ended";

export interface NewMonitoringEvent {
  type: EventType;
  [key: string]: unknown;
}

export interface MonitoringEvent extends NewMonitoringEvent {
  at: string;
}

const MAX_EVENTS = 500;
const events: MonitoringEvent[] = [];

export function recordEvent(event: NewMonitoringEvent): void {
  events.push({ ...event, at: new Date().toISOString() });
  if (events.length > MAX_EVENTS) events.shift();
}

/** Newest first — what the console actually wants to render. */
export function getEvents(): MonitoringEvent[] {
  return [...events].reverse();
}
