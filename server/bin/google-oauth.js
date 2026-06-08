// Shared Google OAuth primitives, used by both the CLI helper (google-auth.js,
// loopback flow) and the backend (server.js, browser redirect flow). Keeping
// the client-loading, token I/O, and code-exchange in one place means the two
// front ends can't drift on token shape or scope handling.
//
// Token shape written to ~/.config/glance/google-token.json (mode 600):
//   { client_id, client_secret, refresh_token, access_token, expires_at,
//     scopes: [...], email? }

const fs    = require("fs");
const os    = require("os");
const path  = require("path");
const https = require("https");
const { URL } = require("url");

const config = require("../config");

const TOKEN_DIR   = path.join(os.homedir(), ".config", "glance");
const TOKEN_FILE  = path.join(TOKEN_DIR, "google-token.json");
const CLIENT_FILE = process.env.GLANCE_GOOGLE_CLIENT_FILE
  || path.join(TOKEN_DIR, "google-client.json");

const SCOPES = {
  calendar: "https://www.googleapis.com/auth/calendar.readonly",
  gmail:    "https://www.googleapis.com/auth/gmail.modify",
};

// openid + email let us record which account connected, shown in the UI.
const ID_SCOPES = ["openid", "https://www.googleapis.com/auth/userinfo.email"];

const API_SERVICES = {
  calendar: "calendar-json.googleapis.com",
  gmail:    "gmail.googleapis.com",
};

function scopesForFlags(flags) {
  const out = [...ID_SCOPES];
  if (flags.calendar) out.push(SCOPES.calendar);
  if (flags.gmail)    out.push(SCOPES.gmail);
  return out;
}

// Pull client_id/client_secret/project_id out of a Cloud Console client-secrets
// download, which wraps the fields under "installed" (Desktop) or "web".
function parseClientSecrets(raw) {
  const type  = raw.installed ? "installed" : raw.web ? "web" : "flat";
  const inner = raw.installed || raw.web || raw;
  if (!inner || !inner.client_id || !inner.client_secret) return null;
  return {
    clientId:     inner.client_id,
    clientSecret: inner.client_secret,
    projectId:    inner.project_id || null,
    type,
    redirectUris: inner.redirect_uris || (inner.redirect_uri ? [inner.redirect_uri] : []),
  };
}

// Non-interactive client lookup: the client-secrets file, else the client
// already baked into a prior token. Returns null if neither exists (callers
// decide whether to prompt or surface an error).
function loadClientFromFiles() {
  try {
    const c = parseClientSecrets(JSON.parse(fs.readFileSync(CLIENT_FILE, "utf8")));
    if (c) return c;
  } catch { /* no/invalid client file */ }
  const tok = readToken();
  if (tok && tok.client_id && tok.client_secret) {
    return { clientId: tok.client_id, clientSecret: tok.client_secret, projectId: null, type: "installed", redirectUris: [] };
  }
  return null;
}

function buildAuthUrl({ clientId, redirectUri, scopes, state }) {
  return "https://accounts.google.com/o/oauth2/v2/auth?" + new URLSearchParams({
    client_id:     clientId,
    redirect_uri:  redirectUri,
    response_type: "code",
    scope:         scopes.join(" "),
    access_type:   "offline",
    prompt:        "consent",
    state,
  }).toString();
}

function postToken(form) {
  return new Promise((resolve, reject) => {
    const body = new URLSearchParams(form).toString();
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
    req.on("timeout", () => { req.destroy(new Error("token request timed out")); });
    req.write(body);
    req.end();
  });
}

function exchangeCode({ clientId, clientSecret, code, redirectUri }) {
  return postToken({
    code,
    client_id:     clientId,
    client_secret: clientSecret,
    redirect_uri:  redirectUri,
    grant_type:    "authorization_code",
  });
}

function refreshAccessToken({ clientId, clientSecret, refreshToken }) {
  return postToken({
    client_id:     clientId,
    client_secret: clientSecret,
    refresh_token: refreshToken,
    grant_type:    "refresh_token",
  });
}

// Best-effort: decode the email out of an OIDC id_token without verifying the
// signature (we just received it over TLS from Google's token endpoint).
function emailFromIdToken(idToken) {
  try {
    const payload = idToken.split(".")[1];
    const json = Buffer.from(payload, "base64url").toString("utf8");
    return JSON.parse(json).email || null;
  } catch { return null; }
}

function readToken() {
  try { return JSON.parse(fs.readFileSync(TOKEN_FILE, "utf8")); }
  catch { return null; }
}

function writeToken(out) {
  fs.mkdirSync(TOKEN_DIR, { recursive: true });
  const tmp = TOKEN_FILE + ".tmp-" + process.pid;
  fs.writeFileSync(tmp, JSON.stringify(out, null, 2) + "\n", { mode: 0o600 });
  fs.renameSync(tmp, TOKEN_FILE);
}

function deleteToken() {
  try { fs.unlinkSync(TOKEN_FILE); } catch { /* already gone */ }
}

// Assemble the on-disk token from a fresh token-endpoint response, carrying the
// refresh_token forward if Google omits it on a re-consent.
function tokenFromResponse(client, tokens, requestedScopes, prev) {
  const granted = (tokens.scope ? tokens.scope.split(/\s+/) : requestedScopes).filter(Boolean);
  return {
    client_id:     client.clientId,
    client_secret: client.clientSecret,
    refresh_token: tokens.refresh_token || (prev && prev.refresh_token) || null,
    access_token:  tokens.access_token,
    expires_at:    Date.now() + (tokens.expires_in || 3600) * 1000,
    scopes:        granted,
    email:         (tokens.id_token && emailFromIdToken(tokens.id_token)) || (prev && prev.email) || null,
  };
}

function revokeToken(token) {
  return new Promise((resolve) => {
    if (!token) return resolve(false);
    const body = new URLSearchParams({ token }).toString();
    const req = https.request({
      hostname: "oauth2.googleapis.com",
      path:     "/revoke",
      method:   "POST",
      headers:  {
        "content-type":   "application/x-www-form-urlencoded",
        "content-length": Buffer.byteLength(body),
      },
      timeout:  10000,
    }, (r) => { r.resume(); r.on("end", () => resolve(r.statusCode === 200)); });
    req.on("error", () => resolve(false));
    req.on("timeout", () => { req.destroy(); resolve(false); });
    req.write(body);
    req.end();
  });
}

// Point glance's config at (or away from) the calendar/gmail bins. Setting a
// bin makes the matching column go live on the next state cycle; nulling it
// stops the column without touching the token, so re-enabling is instant.
function setBins({ calendar, gmail }, on) {
  const gcal  = path.join(__dirname, "gcal.js");
  const gmbin = path.join(__dirname, "gmail.js");
  config.mutate((cur) => {
    if (calendar) cur.calendarBin = on ? gcal  : null;
    if (gmail)    cur.gmailBin    = on ? gmbin : null;
    return cur;
  });
}

// One snapshot of connection state for the dashboard: which client is present,
// which account is linked, and per-surface authorized (token has the scope) vs
// wired (the bin is set, so glance actually reads it).
function status() {
  const tok    = readToken();
  const client = loadClientFromFiles();
  const c      = config.load();
  const scopes = (tok && Array.isArray(tok.scopes)) ? tok.scopes : [];
  return {
    client_present: !!client,
    client_type:    client ? client.type : null,
    email:          (tok && tok.email) || null,
    calendar: { authorized: scopes.includes(SCOPES.calendar), wired: !!c.calendarBin },
    gmail:    { authorized: scopes.includes(SCOPES.gmail),    wired: !!c.gmailBin },
  };
}

module.exports = {
  TOKEN_DIR, TOKEN_FILE, CLIENT_FILE, SCOPES, ID_SCOPES, API_SERVICES,
  scopesForFlags, parseClientSecrets, loadClientFromFiles, buildAuthUrl,
  exchangeCode, refreshAccessToken, emailFromIdToken, readToken, writeToken,
  deleteToken, tokenFromResponse, revokeToken, setBins, status,
};
