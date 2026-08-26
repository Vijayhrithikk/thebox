/**
 * The monitoring frontend, in full. Served directly by this server rather
 * than as a separate Next.js app — the actual requirement is "see what the
 * agent is doing," which is one polling fetch against /events; standing up
 * and deploying a second service for that would be complexity this project
 * doesn't need. If it ever needs real interactivity (manual call triggers,
 * filtering, auth), that's the point to split it out.
 *
 * Groups the flat /events feed into per-call cards (keyed by session_id,
 * falling back to caller_number) — the flat list this replaced made it
 * hard to see, at a glance, what happened on any one call. Call audio and
 * raw transcripts aren't shown here: those live in Sarvam's own portal,
 * not in anything this server captures.
 */
export const CONSOLE_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>ElevateBox voice agent — console</title>
<style>
  :root {
    --bg: #F6F5F1; --surface: #FFFFFF; --surface-2: #EFEEE8; --ink: #1B1D1A; --muted: #6D7168;
    --line: #E1DFD6; --accent: #2E5C50; --accent-soft: #E4EEEA;
    --hot: #C0392B; --hot-soft: #FBEAE7; --warm: #B7791F; --warm-soft: #FCF1DE; --cold: #6D7168; --cold-soft: #EEEDE7;
    --mono: "SFMono-Regular", Consolas, "Liberation Mono", Menlo, monospace;
  }
  @media (prefers-color-scheme: dark) {
    :root {
      --bg: #141613; --surface: #1C1E1A; --surface-2: #232620; --ink: #EDEEE8; --muted: #9A9D8F;
      --line: #33362E; --accent: #6FBFA8; --accent-soft: #1E2F29;
      --hot: #E5695A; --hot-soft: #33201D; --warm: #E3B15C; --warm-soft: #332813; --cold: #9A9D8F; --cold-soft: #24261F;
    }
  }
  * { box-sizing: border-box; }
  body { margin: 0; background: var(--bg); color: var(--ink); font-family: -apple-system, "Segoe UI", sans-serif; }
  header { padding: 22px 28px 18px; border-bottom: 1px solid var(--line); position: sticky; top: 0; background: var(--bg); z-index: 5; }
  h1 { font-size: 19px; margin: 0 0 4px; letter-spacing: -0.01em; }
  .sub { color: var(--muted); font-size: 13px; }
  .stats { display: flex; gap: 10px; padding: 16px 28px 4px; flex-wrap: wrap; }
  .stat { background: var(--surface); border: 1px solid var(--line); border-radius: 8px; padding: 10px 16px; min-width: 84px; }
  .stat .n { font-size: 21px; font-weight: 700; font-variant-numeric: tabular-nums; font-family: var(--mono); }
  .stat .l { font-size: 10.5px; color: var(--muted); text-transform: uppercase; letter-spacing: 0.05em; margin-top: 2px; }
  main { padding: 12px 28px 48px; max-width: 860px; margin: 0 auto; }
  .note { font-size: 12px; color: var(--muted); background: var(--surface-2); border: 1px solid var(--line); border-radius: 8px; padding: 10px 14px; margin-bottom: 18px; }
  .note a { color: var(--accent); }
  .call { background: var(--surface); border: 1px solid var(--line); border-radius: 10px; margin-bottom: 14px; overflow: hidden; }
  .call-head { display: flex; align-items: center; gap: 10px; padding: 13px 16px; border-bottom: 1px solid var(--line); flex-wrap: wrap; }
  .badge { font-size: 10.5px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.05em; padding: 3px 9px; border-radius: 999px; white-space: nowrap; }
  .badge.hot { background: var(--hot-soft); color: var(--hot); }
  .badge.warm { background: var(--warm-soft); color: var(--warm); }
  .badge.cold { background: var(--cold-soft); color: var(--cold); }
  .badge.pending { background: var(--surface-2); color: var(--muted); border: 1px dashed var(--line); }
  .caller { font-family: var(--mono); font-size: 13px; }
  .call-time { margin-left: auto; font-size: 11.5px; color: var(--muted); font-variant-numeric: tabular-nums; white-space: nowrap; }
  .call-body { padding: 14px 16px 16px; display: flex; flex-direction: column; gap: 10px; }
  .evidence { font-size: 13px; color: var(--ink); background: var(--surface-2); border-left: 3px solid var(--accent); padding: 8px 12px; border-radius: 0 6px 6px 0; }
  .evidence .lbl { font-size: 10px; text-transform: uppercase; letter-spacing: 0.05em; color: var(--muted); display: block; margin-bottom: 3px; }
  .slots { display: grid; grid-template-columns: repeat(auto-fill, minmax(200px, 1fr)); gap: 8px; }
  .slot { font-size: 12.5px; background: var(--surface-2); border-radius: 6px; padding: 7px 10px; }
  .slot .k { color: var(--muted); text-transform: uppercase; font-size: 10px; letter-spacing: 0.04em; display: block; margin-bottom: 2px; }
  .row { display: flex; gap: 8px; align-items: baseline; font-size: 13px; }
  .row .k { color: var(--muted); min-width: 92px; font-size: 11.5px; text-transform: uppercase; letter-spacing: 0.04em; }
  .status-line { display: flex; align-items: center; gap: 6px; font-size: 12.5px; color: var(--muted); }
  .dot { width: 7px; height: 7px; border-radius: 50%; background: var(--line); flex-shrink: 0; }
  .dot.done { background: var(--accent); }
  details { margin-top: 2px; }
  summary { font-size: 11.5px; color: var(--muted); cursor: pointer; user-select: none; }
  pre { font-size: 11px; background: var(--surface-2); border-radius: 6px; padding: 10px; overflow-x: auto; margin: 6px 0 0; font-family: var(--mono); }
  .empty { color: var(--muted); padding: 60px 0; text-align: center; font-size: 14px; }
  .panel { background: var(--surface); border: 1px solid var(--line); border-radius: 10px; padding: 16px; margin-bottom: 18px; }
  .panel h2 { font-size: 13.5px; margin: 0 0 12px; text-transform: uppercase; letter-spacing: 0.04em; color: var(--muted); }
  .dial-row { display: flex; gap: 8px; flex-wrap: wrap; }
  input[type=text], input[type=file] { font: inherit; font-size: 13px; padding: 8px 10px; border: 1px solid var(--line); border-radius: 6px; background: var(--bg); color: var(--ink); }
  input[type=text] { flex: 1; min-width: 140px; }
  button { font: inherit; font-size: 13px; font-weight: 600; padding: 8px 16px; border-radius: 6px; border: none; background: var(--accent); color: white; cursor: pointer; }
  button:hover { filter: brightness(1.08); }
  button:disabled { opacity: 0.5; cursor: default; }
  button.secondary { background: var(--surface-2); color: var(--ink); border: 1px solid var(--line); }
  .csv-row { display: flex; gap: 10px; align-items: center; margin-top: 10px; flex-wrap: wrap; }
  .hint { font-size: 11.5px; color: var(--muted); margin-top: 6px; }
  .msg { font-size: 12.5px; margin-top: 8px; }
  .msg.ok { color: var(--accent); }
  .msg.err { color: var(--hot); }
  .campaign { border: 1px solid var(--line); border-radius: 8px; margin-top: 10px; overflow: hidden; }
  .campaign-head { display: flex; gap: 10px; align-items: center; padding: 10px 14px; background: var(--surface-2); font-size: 12.5px; }
  .campaign-head .lbl { font-weight: 700; }
  .campaign-head .n { margin-left: auto; color: var(--muted); font-variant-numeric: tabular-nums; }
  .contact-row { display: flex; gap: 10px; align-items: center; padding: 8px 14px; font-size: 12.5px; border-top: 1px solid var(--line); }
  .contact-row .num { font-family: var(--mono); min-width: 130px; }
  .contact-row .nm { color: var(--muted); flex: 1; }
  .cstatus { font-size: 10px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.04em; padding: 2px 8px; border-radius: 999px; }
  .cstatus.queued { background: var(--surface-2); color: var(--muted); }
  .cstatus.calling { background: var(--warm-soft); color: var(--warm); }
  .cstatus.placed { background: var(--accent-soft); color: var(--accent); }
  .cstatus.connected { background: var(--accent-soft); color: var(--accent); }
  .cstatus.failed { background: var(--hot-soft); color: var(--hot); }
  .cstatus.no_answer { background: var(--warm-soft); color: var(--warm); }
  .transcript { display: flex; flex-direction: column; gap: 6px; margin-top: 8px; max-height: 320px; overflow-y: auto; }
  .turn { display: flex; gap: 8px; font-size: 12.5px; padding: 6px 10px; border-radius: 8px; }
  .turn.agent { background: var(--accent-soft); }
  .turn.user { background: var(--surface-2); }
  .turn .role { text-transform: uppercase; font-size: 9.5px; font-weight: 700; color: var(--muted); min-width: 40px; flex-shrink: 0; padding-top: 1px; }
  .turn .txt { flex: 1; }
  .turn .en { display: block; font-size: 11px; color: var(--muted); margin-top: 2px; font-style: italic; }
  .rec-status { margin-left: 8px; }
</style>
</head>
<body>
<header>
  <h1>ElevateBox voice agent — console</h1>
  <div class="sub">Sarvam's Voice Agent runs the call; this is everything our own backend controls and captures — no Sarvam portal needed.</div>
</header>
<div class="stats" id="stats"></div>
<main>
  <div class="panel">
    <h2>Call a number</h2>
    <div class="dial-row">
      <input type="text" id="dialNumber" placeholder="+91XXXXXXXXXX" />
      <input type="text" id="dialName" placeholder="Name (optional)" />
      <button id="dialBtn">Call now</button>
    </div>
    <div class="hint">Places one call immediately through Sarvam's Instant Outbound API, straight to this agent.</div>
    <div id="dialMsg"></div>
  </div>

  <div class="panel">
    <h2>Campaign from CSV</h2>
    <div class="csv-row">
      <input type="file" id="csvFile" accept=".csv,text/csv" />
      <input type="text" id="csvLabel" placeholder="Campaign label (optional)" style="flex:1;min-width:140px" />
      <button id="csvBtn" class="secondary" disabled>Start campaign</button>
    </div>
    <div class="hint">One contact per row: <code>number,name</code> (name optional). Bare 10-digit numbers are assumed +91. Dialed one at a time, ~25s apart.</div>
    <div id="csvMsg"></div>
  </div>

  <div class="panel">
    <h2>Campaigns</h2>
    <div id="campaignFeed"><div class="hint">No campaigns yet.</div></div>
  </div>

  <div class="note">Call audio and full transcripts live in Sarvam's own portal, not here — the feed below only shows what our four webhooks captured (discovery answers, classification, callback requests, end-of-call summary).</div>
  <div id="feed"><div class="empty">Loading…</div></div>
</main>
<script>
const SLOT_LABELS = { budget: "Budget", business: "Business", business_type: "Business", product_count: "Products", timeline: "Timeline", features: "Features" };

function fmtTime(iso) {
  const d = new Date(iso);
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric" }) + " · " + d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
}

/**
 * Groups the flat event list into per-call cards. Not every tool sends a
 * correlating id — note_discovery's body is just {slot, value}, no
 * caller_number or session_id at all — so pure key-based bucketing splits
 * a single real call into several cards (one per keyless discovery event).
 * Instead: walk events oldest-first and attach each one to the most
 * recently active call unless it's been quiet too long, already ended, or
 * clearly belongs to a different caller — good enough for this system's
 * one-line-at-a-time calling pattern, imperfect only if two calls are
 * genuinely concurrent AND the second one's first event happens to be a
 * keyless discovery call (rare, and undetectable without a real id).
 */
function groupByCall(events) {
  const chrono = [...events].sort((a, b) => (a.at < b.at ? -1 : 1));
  const GAP_MS = 6 * 60 * 1000;
  const calls = [];
  let current = null;

  for (const e of chrono) {
    const key = e.session_id || e.caller_number || null;
    const t = new Date(e.at).getTime();
    let target = null;

    if (current && !current.ended) {
      const withinGap = t - new Date(current.lastAt).getTime() < GAP_MS;
      const sameKey = key && current.key && key === current.key;
      const conflictingCaller = e.caller_number && current.caller && e.caller_number !== current.caller;
      const keylessOrUnkeyed = !key || !current.key;
      if (withinGap && !conflictingCaller && (sameKey || keylessOrUnkeyed)) target = current;
    }

    if (!target) {
      target = { key, caller: "", classification: "", evidence: "", slots: {}, callback: null, ended: null, firstAt: e.at, lastAt: e.at, raw: [], transcript: null, duration: null, status: "" };
      calls.push(target);
    }
    current = target;

    if (!target.key && key) target.key = key;
    target.raw.push(e);
    if (e.at < target.firstAt) target.firstAt = e.at;
    if (e.at > target.lastAt) target.lastAt = e.at;
    if (e.caller_number && !target.caller) target.caller = e.caller_number;
    if (e.type === "classify") { target.classification = e.classification || target.classification; target.evidence = e.evidence || target.evidence; }
    if (e.type === "discovery" && e.slot) target.slots[e.slot] = e.value;
    if (e.type === "callback") target.callback = e.spoken_time;
    if (e.type === "call_ended") {
      target.ended = e;
      target.classification = e.classification || target.classification;
      target.caller = e.caller_number || target.caller;
      for (const k of ["budget", "business_type", "product_count", "timeline", "features"]) if (e[k]) target.slots[k] = e[k];
      if (e.callback_time) target.callback = e.callback_time;
      if (e.transcript) target.transcript = e.transcript;
      if (typeof e.duration === "number") target.duration = e.duration;
      if (e.status) target.status = e.status;
      current = null;
    }
  }
  return calls.sort((a, b) => (a.lastAt < b.lastAt ? 1 : -1));
}

function badge(cls) {
  if (!cls) return '<span class="badge pending">no verdict yet</span>';
  return '<span class="badge ' + cls + '">' + cls + '</span>';
}

function renderCall(c) {
  const slotEntries = Object.entries(c.slots).filter(([, v]) => v);
  const slotsHtml = slotEntries.length
    ? '<div class="slots">' + slotEntries.map(([k, v]) => '<div class="slot"><span class="k">' + (SLOT_LABELS[k] || k) + '</span>' + v + '</div>').join("") + '</div>'
    : "";
  const evidenceHtml = c.evidence ? '<div class="evidence"><span class="lbl">Evidence</span>' + c.evidence + '</div>' : "";
  const callbackHtml = c.callback ? '<div class="row"><span class="k">Callback</span>"' + c.callback + '"</div>' : "";
  const summaryHtml = c.ended && c.ended.call_summary ? '<div class="row"><span class="k">Summary</span>' + c.ended.call_summary + '</div>' : "";
  const durationTxt = typeof c.duration === "number" ? Math.round(c.duration) + "s" : "";
  const statusTxt = c.ended
    ? "call ended" + (c.status ? " · " + c.status : "") + (durationTxt ? " · " + durationTxt : "")
    : "call in progress or awaiting completion webhook";
  const status = '<div class="status-line"><span class="dot ' + (c.ended ? "done" : "") + '"></span>' + statusTxt + '</div>';

  const recordingHtml = c.ended && c.key
    ? '<div class="row"><button class="secondary play-recording" data-key="' + encodeURIComponent(c.key) + '">▶ Play recording</button><span class="rec-status hint"></span></div>'
    : "";

  const transcriptHtml = c.transcript && c.transcript.length
    ? '<details><summary>transcript (' + c.transcript.length + ' turns)</summary><div class="transcript">' +
      c.transcript.map((t) =>
        '<div class="turn ' + t.role + '"><span class="role">' + t.role + '</span><span class="txt">' + (t.indic_text || t.en_text || "") + (t.indic_text && t.en_text ? '<span class="en">' + t.en_text + '</span>' : '') + '</span></div>'
      ).join("") + '</div></details>'
    : "";

  return '<div class="call">'
    + '<div class="call-head">' + badge(c.classification) + '<span class="caller">' + (c.caller || "unknown number") + '</span><span class="call-time">' + fmtTime(c.firstAt) + '</span></div>'
    + '<div class="call-body">' + evidenceHtml + slotsHtml + callbackHtml + summaryHtml + recordingHtml + status + transcriptHtml
    + '<details><summary>raw events (' + c.raw.length + ')</summary><pre>' + JSON.stringify(c.raw, null, 2).replace(/</g, "&lt;") + '</pre></details>'
    + '</div></div>';
}

async function refresh() {
  const res = await fetch("/events");
  const { events } = await res.json();
  const calls = groupByCall(events);

  const stats = { calls: calls.length, hot: 0, warm: 0, cold: 0, callbacks: 0 };
  for (const c of calls) {
    if (c.classification === "hot") stats.hot++;
    else if (c.classification === "warm") stats.warm++;
    else if (c.classification === "cold") stats.cold++;
    if (c.callback) stats.callbacks++;
  }
  document.getElementById("stats").innerHTML = [
    ["calls", stats.calls], ["hot", stats.hot], ["warm", stats.warm], ["cold", stats.cold], ["callbacks", stats.callbacks],
  ].map(([l, n]) => '<div class="stat"><div class="n">' + n + '</div><div class="l">' + l + '</div></div>').join("");

  if (audioPlaying) return; // don't blow away a playing <audio> element mid-refresh
  const feed = document.getElementById("feed");
  if (calls.length === 0) {
    feed.innerHTML = '<div class="empty">No calls yet — this fills in as Sarvam\\'s tools call the webhooks below.</div>';
    return;
  }
  feed.innerHTML = calls.map(renderCall).join("");
}
let audioPlaying = false;
refresh();
setInterval(refresh, 4000);

document.getElementById("feed").addEventListener("click", async (e) => {
  const btn = e.target.closest(".play-recording");
  if (!btn) return;
  const statusEl = btn.nextElementSibling;
  const key = decodeURIComponent(btn.dataset.key);
  btn.disabled = true;
  statusEl.textContent = "loading…";
  try {
    const res = await fetch("/recordings/" + encodeURIComponent(key), { headers: { "X-Admin-Secret": adminSecret() } });
    if (res.status === 401) { localStorage.removeItem("adminSecret"); throw new Error("wrong admin key"); }
    if (!res.ok) throw new Error("not available yet");
    const blob = await res.blob();
    const audioEl = document.createElement("audio");
    audioEl.controls = true;
    audioEl.autoplay = true;
    audioEl.src = URL.createObjectURL(blob);
    audioPlaying = true;
    audioEl.addEventListener("ended", () => { audioPlaying = false; });
    audioEl.addEventListener("pause", () => { audioPlaying = false; });
    btn.replaceWith(audioEl);
    statusEl.textContent = "";
  } catch (err) {
    statusEl.textContent = err.message;
    btn.disabled = false;
  }
});

function adminSecret() {
  let s = localStorage.getItem("adminSecret");
  if (s === null) {
    s = window.prompt("Console admin key (set once, stored only in this browser):") || "";
    localStorage.setItem("adminSecret", s);
  }
  return s;
}

async function postJSON(url, body) {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Admin-Secret": adminSecret() },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (res.status === 401) { localStorage.removeItem("adminSecret"); throw new Error("wrong admin key — try again"); }
  if (!res.ok || data.ok === false) throw new Error(data.error || ("request failed (" + res.status + ")"));
  return data;
}

function showMsg(el, text, ok) {
  el.innerHTML = '<div class="msg ' + (ok ? "ok" : "err") + '">' + text + '</div>';
}

document.getElementById("dialBtn").addEventListener("click", async () => {
  const numberEl = document.getElementById("dialNumber");
  const nameEl = document.getElementById("dialName");
  const msgEl = document.getElementById("dialMsg");
  const number = numberEl.value.trim();
  if (!number) return showMsg(msgEl, "enter a number first", false);
  const btn = document.getElementById("dialBtn");
  btn.disabled = true;
  try {
    await postJSON("/campaigns", { label: "Quick dial", contacts: [{ number, name: nameEl.value.trim() || undefined }] });
    showMsg(msgEl, "queued — should dial within a few seconds", true);
    numberEl.value = ""; nameEl.value = "";
    refreshCampaigns();
  } catch (err) {
    showMsg(msgEl, err.message, false);
  } finally {
    btn.disabled = false;
  }
});

function parseCsv(text) {
  const lines = text.split(/\\r?\\n/).map((l) => l.trim()).filter(Boolean);
  const contacts = [];
  for (const line of lines) {
    const [rawNumber, rawName] = line.split(",").map((s) => (s || "").trim());
    if (!rawNumber || /[a-zA-Z]/.test(rawNumber.replace(/^\\+/, ""))) continue; // skip header / non-numeric rows
    contacts.push({ number: rawNumber, name: rawName || undefined });
  }
  return contacts;
}

let pendingContacts = [];
document.getElementById("csvFile").addEventListener("change", async (e) => {
  const file = e.target.files[0];
  const btn = document.getElementById("csvBtn");
  const msgEl = document.getElementById("csvMsg");
  if (!file) { btn.disabled = true; return; }
  const text = await file.text();
  pendingContacts = parseCsv(text);
  btn.disabled = pendingContacts.length === 0;
  showMsg(msgEl, pendingContacts.length + " contact(s) found", pendingContacts.length > 0);
});

document.getElementById("csvBtn").addEventListener("click", async () => {
  const msgEl = document.getElementById("csvMsg");
  const labelEl = document.getElementById("csvLabel");
  const btn = document.getElementById("csvBtn");
  if (pendingContacts.length === 0) return;
  btn.disabled = true;
  try {
    const { campaign } = await postJSON("/campaigns", { label: labelEl.value.trim() || "CSV campaign", contacts: pendingContacts });
    showMsg(msgEl, "campaign started — " + campaign.contacts.length + " queued", true);
    pendingContacts = [];
    document.getElementById("csvFile").value = "";
    refreshCampaigns();
  } catch (err) {
    showMsg(msgEl, err.message, false);
    btn.disabled = false;
  }
});

function renderCampaign(c) {
  const rows = c.contacts.map((ct) =>
    '<div class="contact-row"><span class="cstatus ' + ct.status + '">' + ct.status.replace("_", " ") + '</span><span class="num">' + ct.number + '</span><span class="nm">' + (ct.name || "") + (ct.attempts > 1 ? " · attempt " + ct.attempts + "/3" : "") + (ct.error ? " — " + ct.error : "") + '</span></div>'
  ).join("");
  return '<div class="campaign"><div class="campaign-head"><span class="lbl">' + c.label + '</span><span class="n">' + c.contacts.length + ' contact(s) · ' + fmtTime(c.createdAt) + '</span></div>' + rows + '</div>';
}

async function refreshCampaigns() {
  const res = await fetch("/campaigns");
  if (!res.ok) return;
  const { campaigns } = await res.json();
  const feed = document.getElementById("campaignFeed");
  feed.innerHTML = campaigns.length ? campaigns.map(renderCampaign).join("") : '<div class="hint">No campaigns yet.</div>';
}
refreshCampaigns();
setInterval(refreshCampaigns, 5000);
</script>
</body>
</html>`;
