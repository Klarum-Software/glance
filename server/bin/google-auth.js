#!/usr/bin/env node
// One-time OAuth setup for Google APIs (Calendar + Gmail) from the terminal.
// The browser dashboard's Settings -> Accounts page does the same thing with a
// button; this helper is the CLI path (and the only option for a headless or
// remote instance). Shared OAuth logic lives in google-oauth.js.
//
// glance uses your own OAuth client, created once in a Google Cloud project
// (e.g. the klarum-dev client in klarum-internal-tools). Google has stopped
// letting third-party tools borrow shared/default client IDs for Calendar and
// Gmail scopes, so bring-your-own-client is the only durable path.
//
// Both "Desktop app" and "Web application" clients work. Desktop clients accept
// any loopback redirect; for a Web client the helper reuses a localhost redirect
// URI already registered on the client, so that client needs one (any
// http://localhost[:port][/path]) in its Authorized redirect URIs.
//
// The client is auto-loaded from $GLANCE_GOOGLE_CLIENT_FILE, then
// ~/.config/glance/google-client.json, then a prior token, then an interactive
// prompt. It also enables the backing APIs (best-effort, via gcloud) and writes
// calendarBin/gmailBin into config.json so the columns light up after a restart.
//
// Run:
//   node server/bin/google-auth.js               # both scopes
//   node server/bin/google-auth.js --calendar    # calendar.readonly only
//   node server/bin/google-auth.js --gmail       # gmail.modify only

const http       = require("http");
const crypto     = require("crypto");
const readline   = require("readline");
const { URL }    = require("url");
const { spawn, spawnSync } = require("child_process");

const config = require("../config");
const goauth = require("./google-oauth");

const REDIRECT_PORT = 8765;
const REDIRECT_URI  = `http://127.0.0.1:${REDIRECT_PORT}`;

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

// Decide where Google sends the auth code back. Desktop clients accept any
// loopback port, so we use our own. Web clients (e.g. klarum-dev) only accept a
// redirect URI registered in the Console, so we reuse a registered loopback one
// verbatim: same host, port, and path Google will redirect to.
function resolveRedirect(client) {
  if (client.type !== "web") {
    return { uri: REDIRECT_URI, host: "127.0.0.1", port: REDIRECT_PORT };
  }
  const loopback = (client.redirectUris || []).find((u) => {
    try {
      const x = new URL(u);
      return x.protocol === "http:" && (x.hostname === "localhost" || x.hostname === "127.0.0.1");
    } catch { return false; }
  });
  if (!loopback) {
    throw new Error("this Web client has no http://localhost redirect URI registered. "
      + "Add one in the Console (APIs & Services -> Credentials -> the client -> Authorized "
      + "redirect URIs), or use a Desktop client.");
  }
  const x = new URL(loopback);
  return { uri: loopback, host: x.hostname, port: Number(x.port) || 80 };
}

// Auto-load the client; only prompt as a last resort.
async function loadClient() {
  const auto = goauth.loadClientFromFiles();
  if (auto) {
    console.log(`Using OAuth client ...${auto.clientId.slice(-24)} (${auto.type})`);
    return auto;
  }
  console.log("\nNo client file found. Create an OAuth client in your Cloud project");
  console.log("and either paste it here or save its JSON to:");
  console.log("  " + goauth.CLIENT_FILE);
  console.log("See docs/CALENDAR-SETUP.md.\n");
  const clientId     = await ask("client_id: ");
  const clientSecret = await ask("client_secret: ");
  if (!clientId || !clientSecret) {
    console.error("client_id and client_secret are required");
    process.exit(1);
  }
  return { clientId, clientSecret, projectId: null, type: "installed", redirectUris: [] };
}

// Best-effort: turn on the Calendar/Gmail APIs so the first request doesn't
// 403. Uses gcloud when present; a failure here is non-fatal (the operator may
// lack serviceusage rights, or the APIs may already be on).
function enableApis(flags, projectId) {
  if (spawnSync("gcloud", ["version"], { stdio: "ignore" }).status !== 0) return;
  const services = [];
  if (flags.calendar) services.push(goauth.API_SERVICES.calendar);
  if (flags.gmail)    services.push(goauth.API_SERVICES.gmail);
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

function waitForCode(expectedState, redirect) {
  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      const u = new URL(req.url, redirect.uri);
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
    server.listen(redirect.port, redirect.host);
  });
}

(async () => {
  const flags  = parseFlags();
  const scopes = goauth.scopesForFlags(flags);

  console.log("Google OAuth setup for glance.\n");
  console.log("Requesting scopes:");
  for (const s of scopes) console.log("  " + s);
  console.log("");

  const client   = await loadClient();
  const redirect = resolveRedirect(client);
  console.log(`Redirect: ${redirect.uri}\n`);
  enableApis(flags, client.projectId);

  const state   = crypto.randomBytes(16).toString("hex");
  const authUrl = goauth.buildAuthUrl({ clientId: client.clientId, redirectUri: redirect.uri, scopes, state });

  console.log("Opening your browser to authorize. If it doesn't open, visit:\n" + authUrl + "\n");
  openUrl(authUrl);

  const code = await waitForCode(state, redirect);
  console.log("Got authorization code, exchanging for tokens...");

  const tokens = await goauth.exchangeCode({
    clientId: client.clientId, clientSecret: client.clientSecret, code, redirectUri: redirect.uri,
  });
  if (!tokens.refresh_token) {
    console.error("\nNo refresh_token returned. This usually means you've authorized this");
    console.error("client before. Revoke at https://myaccount.google.com/permissions");
    console.error("(find your app, remove access) and rerun.");
    process.exit(1);
  }

  goauth.writeToken(goauth.tokenFromResponse(client, tokens, scopes, goauth.readToken()));
  console.log(`\nSaved token to ${goauth.TOKEN_FILE}`);

  goauth.setBins(flags, true);
  console.log(`Wired ${[flags.calendar && "calendarBin", flags.gmail && "gmailBin"].filter(Boolean).join(" + ")} into ${config.CONFIG_FILE}`);
  console.log("\nRestart the glance backend (kill `node server/server.js`, or disable/enable the extension).");
})().catch((e) => { console.error("Error:", e.message); process.exit(1); });
