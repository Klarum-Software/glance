#!/usr/bin/env node
// One-time OAuth setup for Google APIs (Calendar + Gmail).
//
// Two ways to get credentials:
//
//   --gcloud  borrows the gcloud CLI's own OAuth client. You only need
//             `gcloud auth login` done once; this drives
//             `gcloud auth application-default login --scopes=...`, reads the
//             resulting ADC file, and copies the credentials into glance's
//             token. No Cloud Console clicks, no client_id/secret to paste.
//
//   (default) you supply your own OAuth client (created in your own Google
//             Cloud project) and paste its client_id/secret. See
//             docs/CALENDAR-SETUP.md and docs/GMAIL-SETUP.md for the walkthrough.
//
// Either way it also writes calendarBin/gmailBin into
// ~/.config/glance/config.json so the column lights up after a restart.
//
// Run once:
//   node server/bin/google-auth.js --gcloud      # easiest: via gcloud, both scopes
//   node server/bin/google-auth.js               # manual client, both scopes
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
const REDIRECT_PORT = 8765;
const REDIRECT_URI  = `http://127.0.0.1:${REDIRECT_PORT}`;

const SCOPES = {
  calendar: "https://www.googleapis.com/auth/calendar.readonly",
  gmail:    "https://www.googleapis.com/auth/gmail.modify",
};

// gcloud's ADC login always grants these two; we ask for them explicitly so the
// scope list we send fully replaces gcloud's default set rather than appending.
const GCLOUD_BASE_SCOPES = [
  "openid",
  "https://www.googleapis.com/auth/userinfo.email",
];

// The Google API services backing each scope, enabled on the active gcloud
// project so the borrowed client's tokens don't 403 with "API not enabled".
const API_SERVICES = {
  calendar: "calendar-json.googleapis.com",
  gmail:    "gmail.googleapis.com",
};

function parseFlags() {
  const args = process.argv.slice(2);
  const out = { calendar: false, gmail: false, gcloud: false };
  const scopeArgs = args.filter((a) => a !== "--gcloud");
  if (args.includes("--gcloud")) out.gcloud = true;
  if (!scopeArgs.length) { out.calendar = true; out.gmail = true; return out; }
  for (const a of scopeArgs) {
    if (a === "--calendar") out.calendar = true;
    else if (a === "--gmail") out.gmail = true;
    else if (a === "--all") { out.calendar = true; out.gmail = true; }
    else { console.error(`unknown flag: ${a}`); process.exit(2); }
  }
  if (!out.calendar && !out.gmail) { console.error("no scopes selected"); process.exit(2); }
  return out;
}

function gcloud(args, opts = {}) {
  return spawnSync("gcloud", args, { encoding: "utf8", ...opts });
}

// Resolve the ADC file path from gcloud itself so we honor CLOUDSDK_CONFIG and
// any non-default config dir, falling back to the documented default.
function adcPath() {
  const r = gcloud(["info", "--format=value(config.paths.global_config_dir)"]);
  const dir = (r.status === 0 && r.stdout.trim())
    ? r.stdout.trim()
    : path.join(os.homedir(), ".config", "gcloud");
  return path.join(dir, "application_default_credentials.json");
}

// Borrow the gcloud CLI's OAuth client: drive an ADC login for the wanted
// scopes, then read back the client_id/secret/refresh_token it stored.
async function credsViaGcloud(wantedScopes) {
  if (gcloud(["version"]).status !== 0) {
    throw new Error("gcloud CLI not found on PATH. Install the Google Cloud SDK or drop --gcloud and supply your own OAuth client.");
  }

  const acct = gcloud(["config", "get-value", "account"]);
  const proj = gcloud(["config", "get-value", "project"]);
  const account = acct.status === 0 ? acct.stdout.trim() : "";
  const project = proj.status === 0 ? proj.stdout.trim() : "";
  if (!account || account === "(unset)") {
    throw new Error("no active gcloud account. Run `gcloud auth login` first.");
  }
  console.log(`gcloud account: ${account}`);
  console.log(`gcloud project: ${project || "(unset)"}\n`);

  // Best-effort: the borrowed client's tokens call these APIs against the
  // active project's quota, which 403s if the API was never enabled there.
  if (project && project !== "(unset)") {
    const services = [];
    if (wantedScopes.includes(SCOPES.calendar)) services.push(API_SERVICES.calendar);
    if (wantedScopes.includes(SCOPES.gmail))    services.push(API_SERVICES.gmail);
    if (services.length) {
      console.log(`Enabling APIs on ${project}: ${services.join(", ")}`);
      const en = gcloud(["services", "enable", ...services], { stdio: "inherit" });
      if (en.status !== 0) {
        console.warn("Could not enable APIs (insufficient permission?). Continuing; if events never load, enable them by hand.\n");
      } else {
        console.log("");
      }
    }
  }

  console.log("Launching gcloud ADC login. Authorize in the browser, then return here.\n");
  const login = gcloud([
    "auth", "application-default", "login",
    "--scopes=" + [...GCLOUD_BASE_SCOPES, ...wantedScopes].join(","),
  ], { stdio: "inherit" });
  if (login.status !== 0) {
    throw new Error("gcloud ADC login failed or was cancelled.");
  }

  let adc;
  try { adc = JSON.parse(fs.readFileSync(adcPath(), "utf8")); }
  catch { throw new Error(`could not read ADC credentials at ${adcPath()}`); }
  if (!adc.client_id || !adc.client_secret || !adc.refresh_token) {
    throw new Error("ADC file is missing client_id/client_secret/refresh_token.");
  }
  return { clientId: adc.client_id, clientSecret: adc.client_secret, refreshToken: adc.refresh_token };
}

// Exchange a refresh token for a fresh access token (used by the --gcloud path,
// which already holds the long-lived refresh token from ADC).
function refreshAccessToken(clientId, clientSecret, refreshToken) {
  return new Promise((resolve, reject) => {
    const body = new URLSearchParams({
      client_id:     clientId,
      client_secret: clientSecret,
      refresh_token: refreshToken,
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
    req.on("timeout", () => { req.destroy(new Error("token refresh timed out")); });
    req.write(body);
    req.end();
  });
}

function ask(prompt) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => rl.question(prompt, (ans) => { rl.close(); resolve(ans.trim()); }));
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

// Ask Google which scopes an access token actually carries. The refresh grant
// often omits `scope` from its response, so this is how we confirm the borrowed
// gcloud client really consented to what we asked for. Resolves null on failure.
function fetchTokenInfo(accessToken) {
  return new Promise((resolve) => {
    const req = https.request({
      hostname: "oauth2.googleapis.com",
      path:     "/tokeninfo?access_token=" + encodeURIComponent(accessToken),
      method:   "GET",
      timeout:  10000,
    }, (r) => {
      const chunks = [];
      r.on("data", (c) => chunks.push(c));
      r.on("end", () => {
        try { resolve(JSON.parse(Buffer.concat(chunks).toString("utf8"))); }
        catch { resolve(null); }
      });
    });
    req.on("error", () => resolve(null));
    req.on("timeout", () => { req.destroy(); resolve(null); });
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

// Manual flow: the user's own Desktop OAuth client, browser auth-code exchange.
async function credsManual(scopeStr) {
  console.log("\nPrerequisite: a Google Cloud OAuth 2.0 Client ID of type 'Desktop app'.");
  console.log("See docs/CALENDAR-SETUP.md or docs/GMAIL-SETUP.md.\n");

  let existing = null;
  try { existing = JSON.parse(fs.readFileSync(TOKEN_FILE, "utf8")); } catch {}

  let clientId, clientSecret;
  if (existing && existing.client_id && existing.client_secret) {
    const reuse = await ask(`Reuse client_id ending in ...${existing.client_id.slice(-12)}? [Y/n] `);
    if (!reuse || /^y/i.test(reuse)) {
      clientId     = existing.client_id;
      clientSecret = existing.client_secret;
    }
  }
  if (!clientId) {
    clientId     = await ask("client_id: ");
    clientSecret = await ask("client_secret: ");
  }
  if (!clientId || !clientSecret) {
    console.error("client_id and client_secret are required");
    process.exit(1);
  }

  const state = crypto.randomBytes(16).toString("hex");
  const authUrl = "https://accounts.google.com/o/oauth2/v2/auth?" + new URLSearchParams({
    client_id:     clientId,
    redirect_uri:  REDIRECT_URI,
    response_type: "code",
    scope:         scopeStr,
    access_type:   "offline",
    prompt:        "consent",
    state,
  }).toString();

  console.log("\nOpening your browser to authorize. If it doesn't open, visit:\n" + authUrl + "\n");
  openUrl(authUrl);

  const code = await waitForCode(state);
  console.log("Got authorization code, exchanging for tokens...");

  const tokens = await exchangeCode(clientId, clientSecret, code);
  if (!tokens.refresh_token) {
    console.error("\nNo refresh_token returned. This usually means you've authorized this");
    console.error("client before. Revoke at https://myaccount.google.com/permissions");
    console.error("(find your app, remove access) and rerun.");
    process.exit(1);
  }

  return {
    client_id:     clientId,
    client_secret: clientSecret,
    refresh_token: tokens.refresh_token,
    access_token:  tokens.access_token,
    expires_at:    Date.now() + (tokens.expires_in || 3600) * 1000,
    scopes:        (tokens.scope || scopeStr).split(/\s+/).filter(Boolean),
  };
}

// gcloud flow: borrow the CLI's OAuth client, no client_id/secret to manage.
async function credsGcloud(wanted, scopeStr) {
  const creds = await credsViaGcloud(wanted);
  console.log("\nMinting an access token from the gcloud credentials...");
  const tokens = await refreshAccessToken(creds.clientId, creds.clientSecret, creds.refreshToken);

  const info = await fetchTokenInfo(tokens.access_token);
  const grantedScopes = (info && info.scope ? info.scope : scopeStr).split(/\s+/).filter(Boolean);
  const missing = wanted.filter((s) => !grantedScopes.includes(s));
  if (missing.length) {
    console.error("\ngcloud's OAuth client did not consent to: " + missing.join(", "));
    console.error("It cannot grant restricted scopes it has not been approved for.");
    console.error("Re-run without --gcloud and supply your own OAuth client for that surface.");
    process.exit(1);
  }

  return {
    client_id:     creds.clientId,
    client_secret: creds.clientSecret,
    refresh_token: creds.refreshToken,
    access_token:  tokens.access_token,
    expires_at:    Date.now() + (tokens.expires_in || 3600) * 1000,
    scopes:        grantedScopes,
  };
}

(async () => {
  const flags = parseFlags();
  const wanted = [];
  if (flags.calendar) wanted.push(SCOPES.calendar);
  if (flags.gmail)    wanted.push(SCOPES.gmail);
  const scopeStr = wanted.join(" ");

  console.log(`Google OAuth setup for glance (${flags.gcloud ? "via gcloud" : "manual client"}).\n`);
  console.log("Requesting scopes:");
  for (const s of wanted) console.log("  " + s);

  const out = flags.gcloud
    ? await credsGcloud(wanted, scopeStr)
    : await credsManual(scopeStr);

  writeToken(out);
  console.log(`\nSaved token to ${TOKEN_FILE}`);

  const wired = wireConfig(flags);
  console.log(`Wired ${wired.join(" + ")} into ${config.CONFIG_FILE}`);
  console.log("\nRestart the glance backend (kill `node server/server.js`, or disable/enable the extension).");
})().catch((e) => { console.error("Error:", e.message); process.exit(1); });
