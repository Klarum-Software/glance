#!/usr/bin/env node
// One-time OAuth setup for Google APIs (Calendar + Gmail).
//
// glance uses your own OAuth client (a "Desktop app" client created once in a
// Google Cloud project, e.g. klarum-internal-tools). Google has stopped letting
// third-party tools borrow shared/default client IDs for Calendar and Gmail
// scopes, so bring-your-own-client is the only durable path.
//
// To avoid pasting client_id/client_secret on every machine, this helper
// auto-loads the client from, in order:
//
//   1. $GLANCE_GOOGLE_CLIENT_FILE, if set
//   2. ~/.config/glance/google-client.json   (the client_secret_*.json you
//      download from the Cloud Console, renamed or copied here)
//   3. the client_id/client_secret already in ~/.config/glance/google-token.json
//   4. interactive prompt (last resort)
//
// So the one-time org setup is: create the Desktop client once, drop its
// downloaded JSON at the path above on each machine, then run this helper.
// It also enables the backing APIs (best-effort, via gcloud if present) and
// writes calendarBin/gmailBin into ~/.config/glance/config.json so the column
// lights up after a restart.
//
// Run:
//   node server/bin/google-auth.js               # both scopes
//   node server/bin/google-auth.js --calendar    # calendar.readonly only
//   node server/bin/google-auth.js --gmail       # gmail.modify only
//
// Saves { client_id, client_secret, refresh_token, access_token, expires_at,
//        scopes } to ~/.config/glance/google-token.json (mode 600).

const fs       = require("fs");
const os       = require("os");
const path     = require("path");
const http     = require("http");
const https    = require("https");
const crypto   = require("crypto");
const readline = require("readline");
const { URL }  = require("url");
const { spawn, spawnSync } = require("child_process");

const config = require("../config");

const TOKEN_DIR     = path.join(os.homedir(), ".config", "glance");
const TOKEN_FILE    = path.join(TOKEN_DIR, "google-token.json");
const CLIENT_FILE   = process.env.GLANCE_GOOGLE_CLIENT_FILE
  || path.join(TOKEN_DIR, "google-client.json");
const REDIRECT_PORT = 8765;
const REDIRECT_URI  = `http://127.0.0.1:${REDIRECT_PORT}`;

const SCOPES = {
  calendar: "https://www.googleapis.com/auth/calendar.readonly",
  gmail:    "https://www.googleapis.com/auth/gmail.modify",
};

// The Google API services backing each scope; enabled on the client's project
// so tokens don't 403 with "API has not been used in project before".
const API_SERVICES = {
  calendar: "calendar-json.googleapis.com",
  gmail:    "gmail.googleapis.com",
};

function parseFlags() {
  const args = process.argv.slice(2);
  if (!args.length) return { calendar: true, gmail: true };
  const out = { calendar: false, gmail: false };
  for (const a of args) {
    if (a === "--calendar") out.calendar = true;
    else if (a === "--gmail") out.gmail = true;
    else if (a === "--all") { out.calendar = true; out.gmail = true; }
    else { console.error(`unknown flag: ${a}`); process.exit(2); }
  }
  if (!out.calendar && !out.gmail) { console.error("no scopes selected"); process.exit(2); }
  return out;
}

function ask(prompt) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => rl.question(prompt, (ans) => { rl.close(); resolve(ans.trim()); }));
}

// Pull client_id/client_secret/project_id out of a Cloud Console client-secrets
// download, which wraps the fields under "installed" (Desktop) or "web".
function parseClientSecrets(raw) {
  const inner = raw.installed || raw.web || raw;
  if (!inner || !inner.client_id || !inner.client_secret) return null;
  return {
    clientId:     inner.client_id,
    clientSecret: inner.client_secret,
    projectId:    inner.project_id || null,
  };
}

// Find the OAuth client without making the user paste it where we can avoid it.
async function loadClient() {
  try {
    const c = parseClientSecrets(JSON.parse(fs.readFileSync(CLIENT_FILE, "utf8")));
    if (c) { console.log(`Using OAuth client from ${CLIENT_FILE}`); return c; }
    console.error(`${CLIENT_FILE} is not a recognizable client-secrets file; ignoring.`);
  } catch { /* no client file, fall through */ }

  let existing = null;
  try { existing = JSON.parse(fs.readFileSync(TOKEN_FILE, "utf8")); } catch {}
  if (existing && existing.client_id && existing.client_secret) {
    const reuse = await ask(`Reuse client_id ending in ...${existing.client_id.slice(-12)}? [Y/n] `);
    if (!reuse || /^y/i.test(reuse)) {
      return { clientId: existing.client_id, clientSecret: existing.client_secret, projectId: null };
    }
  }

  console.log("\nNo client file found. Create a 'Desktop app' OAuth client in your");
  console.log("Cloud project and either paste it here or save its JSON to:");
  console.log("  " + CLIENT_FILE);
  console.log("See docs/CALENDAR-SETUP.md.\n");
  const clientId     = await ask("client_id: ");
  const clientSecret = await ask("client_secret: ");
  if (!clientId || !clientSecret) {
    console.error("client_id and client_secret are required");
    process.exit(1);
  }
  return { clientId, clientSecret, projectId: null };
}

// Best-effort: turn on the Calendar/Gmail APIs so the first request doesn't
// 403. Uses gcloud when present; a failure here is non-fatal (the operator may
// lack serviceusage rights, or the APIs may already be on).
function enableApis(flags, projectId) {
  if (spawnSync("gcloud", ["version"], { stdio: "ignore" }).status !== 0) return;
  const services = [];
  if (flags.calendar) services.push(API_SERVICES.calendar);
  if (flags.gmail)    services.push(API_SERVICES.gmail);
  if (!services.length) return;
  const args = ["services", "enable", ...services];
  if (projectId) args.push("--project", projectId);
  console.log(`Enabling APIs${projectId ? ` on ${projectId}` : ""}: ${services.join(", ")}`);
  const r = spawnSync("gcloud", args, { stdio: "inherit" });
  if (r.status !== 0) {
    console.warn("Could not enable APIs automatically; enable them by hand if events never load.\n");
  } else {
    console.log("");
  }
}

function openUrl(url) {
  const opener = process.platform === "linux"  ? "xdg-open"
              :  process.platform === "darwin" ? "open"
              :  process.platform === "win32"  ? "cmd"
              :  "xdg-open";
  const args = process.platform === "win32" ? ["/c", "start", "", url] : [url];
  try { spawn(opener, args, { detached: true, stdio: "ignore" }).unref(); } catch {}
}

function waitForCode(expectedState) {
  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      const u = new URL(req.url, REDIRECT_URI);
      const code  = u.searchParams.get("code");
      const state = u.searchParams.get("state");
      const err   = u.searchParams.get("error");
      if (err) {
        res.writeHead(400, { "content-type": "text/html; charset=utf-8" });
        res.end(`<h1>Auth failed</h1><p>${err}</p>`);
        server.close();
        return reject(new Error(err));
      }
      if (!code) {
        res.writeHead(404);
        res.end();
        return;
      }
      if (state !== expectedState) {
        res.writeHead(400, { "content-type": "text/html; charset=utf-8" });
        res.end("<h1>State mismatch</h1>");
        server.close();
        return reject(new Error("state mismatch (possible CSRF)"));
      }
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end("<h1>Authorized</h1><p>You can close this tab and return to the terminal.</p>");
      server.close();
      resolve(code);
    });
    server.on("error", reject);
    server.listen(REDIRECT_PORT, "127.0.0.1");
  });
}

function exchangeCode(clientId, clientSecret, code) {
  return new Promise((resolve, reject) => {
    const body = new URLSearchParams({
      code,
      client_id:     clientId,
      client_secret: clientSecret,
      redirect_uri:  REDIRECT_URI,
      grant_type:    "authorization_code",
    }).toString();
    const req = https.request({
      hostname: "oauth2.googleapis.com",
      path:     "/token",
      method:   "POST",
      headers:  {
        "content-type":   "application/x-www-form-urlencoded",
        "content-length": Buffer.byteLength(body),
      },
      timeout:  15000,
    }, (r) => {
      const chunks = [];
      r.on("data", (c) => chunks.push(c));
      r.on("end", () => {
        try {
          const data = JSON.parse(Buffer.concat(chunks).toString("utf8"));
          if (data.error) return reject(new Error(data.error_description || data.error));
          resolve(data);
        } catch (e) { reject(e); }
      });
    });
    req.on("error", reject);
    req.on("timeout", () => { req.destroy(new Error("token exchange timed out")); });
    req.write(body);
    req.end();
  });
}

function writeToken(out) {
  fs.mkdirSync(TOKEN_DIR, { recursive: true });
  const tmp = TOKEN_FILE + ".tmp-" + process.pid;
  fs.writeFileSync(tmp, JSON.stringify(out, null, 2) + "\n", { mode: 0o600 });
  fs.renameSync(tmp, TOKEN_FILE);
}

// Point glance's config at the calendar/gmail bins so the columns populate on
// the next restart, replacing the old "paste this into config.json by hand" step.
function wireConfig(flags) {
  const wired = [];
  config.mutate((cur) => {
    if (flags.calendar) { cur.calendarBin = path.resolve(__dirname, "gcal.js"); wired.push("calendarBin"); }
    if (flags.gmail)    { cur.gmailBin    = path.resolve(__dirname, "gmail.js"); wired.push("gmailBin"); }
    return cur;
  });
  return wired;
}

(async () => {
  const flags = parseFlags();
  const wanted = [];
  if (flags.calendar) wanted.push(SCOPES.calendar);
  if (flags.gmail)    wanted.push(SCOPES.gmail);
  const scopeStr = wanted.join(" ");

  console.log("Google OAuth setup for glance.\n");
  console.log("Requesting scopes:");
  for (const s of wanted) console.log("  " + s);
  console.log("");

  const client = await loadClient();
  enableApis(flags, client.projectId);

  const state = crypto.randomBytes(16).toString("hex");
  const authUrl = "https://accounts.google.com/o/oauth2/v2/auth?" + new URLSearchParams({
    client_id:     client.clientId,
    redirect_uri:  REDIRECT_URI,
    response_type: "code",
    scope:         scopeStr,
    access_type:   "offline",
    prompt:        "consent",
    state,
  }).toString();

  console.log("Opening your browser to authorize. If it doesn't open, visit:\n" + authUrl + "\n");
  openUrl(authUrl);

  const code = await waitForCode(state);
  console.log("Got authorization code, exchanging for tokens...");

  const tokens = await exchangeCode(client.clientId, client.clientSecret, code);
  if (!tokens.refresh_token) {
    console.error("\nNo refresh_token returned. This usually means you've authorized this");
    console.error("client before. Revoke at https://myaccount.google.com/permissions");
    console.error("(find your app, remove access) and rerun.");
    process.exit(1);
  }

  writeToken({
    client_id:     client.clientId,
    client_secret: client.clientSecret,
    refresh_token: tokens.refresh_token,
    access_token:  tokens.access_token,
    expires_at:    Date.now() + (tokens.expires_in || 3600) * 1000,
    scopes:        (tokens.scope || scopeStr).split(/\s+/).filter(Boolean),
  });
  console.log(`\nSaved token to ${TOKEN_FILE}`);

  const wired = wireConfig(flags);
  console.log(`Wired ${wired.join(" + ")} into ${config.CONFIG_FILE}`);
  console.log("\nRestart the glance backend (kill `node server/server.js`, or disable/enable the extension).");
})().catch((e) => { console.error("Error:", e.message); process.exit(1); });
