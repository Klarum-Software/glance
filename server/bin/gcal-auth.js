#!/usr/bin/env node
// One-time OAuth setup for Google Calendar. Each user supplies their own
// OAuth client (created in their own Google Cloud project) so this repo
// never embeds shared credentials. See docs/CALENDAR-SETUP.md for the
// 5-step Cloud Console walkthrough.
//
// Run once:
//   node server/bin/gcal-auth.js
//
// Saves { client_id, client_secret, refresh_token, access_token, expires_at }
// to ~/.config/glance/google-token.json (mode 600). gcal.js reads this on
// every invocation and refreshes the access token when it expires.

const fs       = require("fs");
const os       = require("os");
const path     = require("path");
const http     = require("http");
const https    = require("https");
const crypto   = require("crypto");
const readline = require("readline");
const { URL }  = require("url");
const { spawn } = require("child_process");

const TOKEN_DIR     = path.join(os.homedir(), ".config", "glance");
const TOKEN_FILE    = path.join(TOKEN_DIR, "google-token.json");
const SCOPE         = "https://www.googleapis.com/auth/calendar.readonly";
const REDIRECT_PORT = 8765;
const REDIRECT_URI  = `http://127.0.0.1:${REDIRECT_PORT}`;

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

(async () => {
  console.log("Google Calendar OAuth setup for glance.\n");
  console.log("Prerequisite: a Google Cloud OAuth 2.0 Client ID of type 'Desktop app'.");
  console.log("See docs/CALENDAR-SETUP.md for the 5-step Cloud Console walkthrough.\n");

  const clientId     = await ask("client_id: ");
  const clientSecret = await ask("client_secret: ");
  if (!clientId || !clientSecret) {
    console.error("client_id and client_secret are required");
    process.exit(1);
  }

  const state = crypto.randomBytes(16).toString("hex");
  const authUrl = "https://accounts.google.com/o/oauth2/v2/auth?" + new URLSearchParams({
    client_id:     clientId,
    redirect_uri:  REDIRECT_URI,
    response_type: "code",
    scope:         SCOPE,
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

  const out = {
    client_id:     clientId,
    client_secret: clientSecret,
    refresh_token: tokens.refresh_token,
    access_token:  tokens.access_token,
    expires_at:    Date.now() + (tokens.expires_in || 3600) * 1000,
  };

  fs.mkdirSync(TOKEN_DIR, { recursive: true });
  const tmp = TOKEN_FILE + ".tmp-" + process.pid;
  fs.writeFileSync(tmp, JSON.stringify(out, null, 2) + "\n", { mode: 0o600 });
  fs.renameSync(tmp, TOKEN_FILE);
  console.log(`\nSaved token to ${TOKEN_FILE}`);
  console.log("\nNow add this to ~/.config/glance/config.json:");
  console.log(`  "calendarBin": "${path.resolve(__dirname, "gcal.js")}"\n`);
  console.log("Then restart the glance backend (disable/enable the extension).");
})().catch((e) => { console.error("Error:", e.message); process.exit(1); });
