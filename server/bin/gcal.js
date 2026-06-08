#!/usr/bin/env node
// calendarBin: lists upcoming events from the user's primary Google
// Calendar in the line-oriented format glance's server expects:
//
//   <start_iso> <summary> [<event_id>]
//
// Reads OAuth tokens from ~/.config/glance/google-token.json (written
// by gcal-auth.js) and refreshes the access token on demand. Output
// lines with newlines in the summary are normalized to single spaces
// so the parsing regex in server.js doesn't break across events.
//
// Usage:
//   node server/bin/gcal.js list <days>
//   node server/bin/gcal.js attendees <days>     # TSV: <start_iso>\t<email>\t<summary>

const fs    = require("fs");
const os    = require("os");
const path  = require("path");
const https = require("https");

const TOKEN_FILE = path.join(os.homedir(), ".config", "glance", "google-token.json");

function loadToken() {
  return JSON.parse(fs.readFileSync(TOKEN_FILE, "utf8"));
}

function saveToken(tok) {
  const tmp = TOKEN_FILE + ".tmp-" + process.pid;
  fs.writeFileSync(tmp, JSON.stringify(tok, null, 2) + "\n", { mode: 0o600 });
  fs.renameSync(tmp, TOKEN_FILE);
}

function refreshAccessToken(tok) {
  return new Promise((resolve, reject) => {
    const body = new URLSearchParams({
      client_id:     tok.client_id,
      client_secret: tok.client_secret,
      refresh_token: tok.refresh_token,
      grant_type:    "refresh_token",
    }).toString();
    const req = https.request({
      hostname: "oauth2.googleapis.com",
      path:     "/token",
      method:   "POST",
      headers:  {
        "content-type":   "application/x-www-form-urlencoded",
        "content-length": Buffer.byteLength(body),
      },
      timeout:  10000,
    }, (r) => {
      const chunks = [];
      r.on("data", (c) => chunks.push(c));
      r.on("end", () => {
        try {
          const data = JSON.parse(Buffer.concat(chunks).toString("utf8"));
          if (data.error) return reject(new Error(data.error_description || data.error));
          tok.access_token = data.access_token;
          tok.expires_at   = Date.now() + (data.expires_in || 3600) * 1000;
          saveToken(tok);
          resolve(tok);
        } catch (e) { reject(e); }
      });
    });
    req.on("error", reject);
    req.on("timeout", () => { req.destroy(new Error("token refresh timed out")); });
    req.write(body);
    req.end();
  });
}

// Refresh ~60s before the documented expiry so a slow API call doesn't
// race the token clock and 401 mid-flight.
async function ensureFresh(tok) {
  if (!tok.expires_at || Date.now() > tok.expires_at - 60_000) {
    return refreshAccessToken(tok);
  }
  return tok;
}

function listEvents(tok, days) {
  return new Promise((resolve, reject) => {
    const now    = new Date();
    const future = new Date(now.getTime() + days * 86400 * 1000);
    const qs = new URLSearchParams({
      timeMin:      now.toISOString(),
      timeMax:      future.toISOString(),
      singleEvents: "true",
      orderBy:      "startTime",
      maxResults:   "100",
    }).toString();
    const req = https.request({
      hostname: "www.googleapis.com",
      path:     `/calendar/v3/calendars/primary/events?${qs}`,
      method:   "GET",
      headers:  { authorization: `Bearer ${tok.access_token}` },
      timeout:  10000,
    }, (r) => {
      const chunks = [];
      r.on("data", (c) => chunks.push(c));
      r.on("end", () => {
        if (r.statusCode === 401) {
          const err = new Error("Calendar API 401 unauthorized");
          err.status = 401;
          return reject(err);
        }
        try {
          const data = JSON.parse(Buffer.concat(chunks).toString("utf8"));
          if (data.error) return reject(new Error(data.error.message || "Calendar API error"));
          resolve(data.items || []);
        } catch (e) { reject(e); }
      });
    });
    req.on("error", reject);
    req.on("timeout", () => { req.destroy(new Error("list events timed out")); });
    req.end();
  });
}

// The pre-expiry refresh in ensureFresh can still race the token clock (skew,
// a token revoked server-side, a slow call). On a 401 refresh once and retry
// before giving up, so a single stale token doesn't blank the CALENDAR column.
async function listEventsWithRetry(tok, days) {
  try {
    return await listEvents(tok, days);
  } catch (e) {
    if (e.status !== 401) throw e;
    await refreshAccessToken(tok);
    return listEvents(tok, days);
  }
}

(async () => {
  const [cmd, daysArg] = process.argv.slice(2);
  if (cmd !== "list" && cmd !== "attendees") {
    console.error("usage: gcal.js list <days> | attendees <days>");
    process.exit(2);
  }
  const days = Math.max(1, Math.min(30, Number(daysArg) || 7));

  let tok;
  try {
    tok = loadToken();
  } catch (e) {
    console.error("No token file. Run: node server/bin/google-auth.js --calendar");
    process.exit(1);
  }

  tok = await ensureFresh(tok);
  const events = await listEventsWithRetry(tok, days);

  if (cmd === "list") {
    for (const ev of events) {
      const start = ev.start && (ev.start.dateTime || ev.start.date);
      if (!start || !ev.id) continue;
      const summary = (ev.summary || "(untitled)").replace(/\s+/g, " ").trim();
      console.log(`${start} ${summary} [${ev.id}]`);
    }
    return;
  }

  for (const ev of events) {
    const start = ev.start && (ev.start.dateTime || ev.start.date);
    if (!start) continue;
    const summary = (ev.summary || "(untitled)").replace(/\s+/g, " ").trim();
    const attendees = Array.isArray(ev.attendees) ? ev.attendees : [];
    const seen = new Set();
    if (ev.organizer && ev.organizer.email) attendees.push({ email: ev.organizer.email });
    for (const a of attendees) {
      const email = (a.email || "").toLowerCase().trim();
      if (!email || seen.has(email)) continue;
      seen.add(email);
      process.stdout.write(`${start}\t${email}\t${summary}\n`);
    }
  }
})().catch((e) => { console.error("Error:", e.message); process.exit(1); });
