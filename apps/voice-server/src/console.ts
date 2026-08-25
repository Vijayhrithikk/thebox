/**
 * The monitoring frontend, in full. Served directly by this server rather
 * than as a separate Next.js app — the actual requirement is "see what the
 * agent is doing," which is one polling fetch against /events and a list;
 * standing up and deploying a second service for that would be complexity
 * this project doesn't need. If it ever needs real interactivity (manual
 * call triggers, filtering, auth), that's the point to split it out.
 */
export const CONSOLE_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>ElevateBox voice agent — console</title>
<style>
  :root {
    --bg: #FAF7F3; --surface: #F1ECE4; --ink: #1D1912; --muted: #6B6459;
    --line: #D9D0C2; --accent: #D9701C; --hot: #C0392B; --warm: #C98A1D; --cold: #6B6459;
  }
  @media (prefers-color-scheme: dark) {
    :root { --bg: #15120E; --surface: #1C1812; --ink: #F2EDE4; --muted: #948A79; --line: #3A3226; --accent: #F0924A; --hot: #E06455; --warm: #E0AA55; --cold: #948A79; }
  }
  * { box-sizing: border-box; }
  body { margin: 0; background: var(--bg); color: var(--ink); font-family: -apple-system, "Segoe UI", sans-serif; }
  header { padding: 24px 28px 16px; border-bottom: 1px solid var(--line); }
  h1 { font-size: 20px; margin: 0 0 4px; }
  .sub { color: var(--muted); font-size: 13px; }
  .stats { display: flex; gap: 12px; padding: 16px 28px; flex-wrap: wrap; }
  .stat { background: var(--surface); border: 1px solid var(--line); border-radius: 6px; padding: 10px 16px; min-width: 90px; }
  .stat .n { font-size: 22px; font-weight: 700; font-variant-numeric: tabular-nums; }
  .stat .l { font-size: 11px; color: var(--muted); text-transform: uppercase; letter-spacing: 0.04em; }
  main { padding: 8px 28px 40px; max-width: 900px; }
  .event { display: flex; gap: 12px; padding: 12px 0; border-bottom: 1px solid var(--line); align-items: flex-start; }
  .pill { font-size: 10.5px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.04em; padding: 3px 8px; border-radius: 999px; white-space: nowrap; }
  .pill.classify { background: color-mix(in srgb, var(--accent) 18%, transparent); color: var(--accent); }
  .pill.discovery { background: color-mix(in srgb, var(--muted) 18%, transparent); color: var(--muted); }
  .pill.callback { background: color-mix(in srgb, var(--warm) 18%, transparent); color: var(--warm); }
  .pill.call_ended { background: color-mix(in srgb, var(--ink) 12%, transparent); color: var(--ink); }
  .hot { color: var(--hot); font-weight: 700; }
  .warm { color: var(--warm); font-weight: 700; }
  .cold { color: var(--cold); font-weight: 700; }
  .detail { font-size: 13.5px; flex: 1; }
  .time { font-size: 11px; color: var(--muted); white-space: nowrap; font-variant-numeric: tabular-nums; }
  .empty { color: var(--muted); padding: 40px 0; font-size: 14px; }
</style>
</head>
<body>
<header>
  <h1>ElevateBox voice agent — live console</h1>
  <div class="sub">Sarvam Voice Agent runs the call; this shows what its tools reported back.</div>
</header>
<div class="stats" id="stats"></div>
<main><div id="feed"><div class="empty">Loading…</div></div></main>
<script>
function pill(type) {
  const label = { classify: "classification", discovery: "discovery", callback: "callback", call_ended: "call ended" }[type] || type;
  return '<span class="pill ' + type + '">' + label + '</span>';
}
function detail(e) {
  if (e.type === "classify") {
    const cls = e.classification ? '<span class="' + e.classification + '">' + e.classification.toUpperCase() + '</span>' : "";
    return cls + (e.evidence ? " — \\"" + e.evidence + "\\"" : "") + (e.caller_number ? " (" + e.caller_number + ")" : "");
  }
  if (e.type === "discovery") return (e.slot || "") + ": " + (e.value || "");
  if (e.type === "callback") return "\\"" + (e.spoken_time || "") + "\\"" + (e.caller_number ? " — " + e.caller_number : "");
  if (e.type === "call_ended") {
    const cls = e.classification ? '<span class="' + e.classification + '">' + e.classification.toUpperCase() + '</span> — ' : "";
    return cls + (e.call_summary || "call ended") + (e.caller_number ? " (" + e.caller_number + ")" : "");
  }
  return JSON.stringify(e);
}
async function refresh() {
  const res = await fetch("/events");
  const { events } = await res.json();
  const stats = { hot: 0, warm: 0, cold: 0, callbacks: 0, calls: 0 };
  for (const e of events) {
    if (e.type === "classify" || e.type === "call_ended") {
      if (e.classification === "hot") stats.hot++;
      else if (e.classification === "warm") stats.warm++;
      else if (e.classification === "cold") stats.cold++;
    }
    if (e.type === "callback") stats.callbacks++;
    if (e.type === "call_ended") stats.calls++;
  }
  document.getElementById("stats").innerHTML = [
    ["calls ended", stats.calls], ["hot", stats.hot], ["warm", stats.warm], ["cold", stats.cold], ["callbacks", stats.callbacks],
  ].map(([l, n]) => '<div class="stat"><div class="n">' + n + '</div><div class="l">' + l + '</div></div>').join("");

  const feed = document.getElementById("feed");
  if (events.length === 0) {
    feed.innerHTML = '<div class="empty">No calls yet — this fills in as Sarvam\\'s tools call the webhooks below.</div>';
    return;
  }
  feed.innerHTML = events.map((e) =>
    '<div class="event">' + pill(e.type) + '<div class="detail">' + detail(e) + '</div><div class="time">' + new Date(e.at).toLocaleTimeString() + '</div></div>'
  ).join("");
}
refresh();
setInterval(refresh, 4000);
</script>
</body>
</html>`;
