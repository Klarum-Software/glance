#!/usr/bin/env node
// glance — single-screen operator dashboard. Reachable on localhost and,
// when host is "tailscale", on this machine's tailnet IP (and nowhere else).
//
//   GET    /                          index.html
//   GET    /<static asset>            public/...
//   GET    /api/state                 aggregated snapshot
//   GET    /api/health                { ok, version, platform }
//   POST   /api/refresh               invalidate caches, return new state
//   POST   /api/open                  body: { url } — open in default handler
//   GET    /api/config/peers          list manually-configured remote peers
//   POST   /api/config/peers          body: { name, host, port? } — add peer
//   DELETE /api/config/peers/:name    remove peer
//   GET    /api/tmux                  list windows of the configured session
//   GET    /api/tmux/capture?window=N current visible pane contents (ANSI)
//   POST   /api/tmux/send             body: { window, text? , key? } — type
//   POST   /api/tmux/select           body: { window } — switch active window
//   POST   /api/tmux/new-window       body: { name? } — open a new window
//
// Zero npm deps. Cross-platform via server/platform/{linux,macos,windows}.js.

const http        = require("http");
const https       = require("https");
const fs          = require("fs");
const path        = require("path");
const { spawn }   = require("child_process");
const { execSync } = require("child_process");

const platform   = require("./platform");
const configMod  = require("./config");
let   cfg        = configMod.load();

const PKG       = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "package.json"), "utf8"));
const PUBLIC_DIR = path.join(__dirname, "..", "public");
const CAL_CACHE  = path.join(cfg.inboxDir, ".cal-cache.json");
const GMAIL_CACHE = path.join(cfg.inboxDir, ".gmail-cache.json");

const PEER_NAME_RE = /^[a-zA-Z0-9._-]+$/;
// Gmail message IDs are lowercase hex (currently 16 chars). Allow alphanumeric
// + underscore as a forward-compatible safelist; reject everything else so a
// path like "../../etc" can never reach the spawn call.
const GMAIL_ID_RE  = /^[a-zA-Z0-9_-]{1,64}$/;
// RFC1123 hostname (letters, digits, hyphens, dots; no leading/trailing hyphen
// in any label) OR a plain IPv4 dotted-quad. IPv6 not validated here — would
// need bracket-stripping + colon parsing; not worth the surface area for a
// localhost-only admin UI.
const HOSTNAME_RE = /^(?=.{1,253}$)([a-zA-Z0-9]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)(\.[a-zA-Z0-9]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)*$/;
const IPV4_RE     = /^(?:(?:25[0-5]|2[0-4]\d|[01]?\d?\d)\.){3}(?:25[0-5]|2[0-4]\d|[01]?\d?\d)$/;

// ── helpers ────────────────────────────────────────────────────────────────

function send(res, status, body, headers = {}) {
  const isString = typeof body === "string";
  res.writeHead(status, {
    "content-type": isString ? "text/plain; charset=utf-8" : "application/json",
    "cache-control": "no-store, no-cache, must-revalidate",
    "access-control-allow-origin": "*",
    ...headers,
  });
  res.end(isString ? body : JSON.stringify(body));
}

function serveStatic(req, res) {
  let urlPath = req.url.split("?")[0];
  if (urlPath === "/") urlPath = "/index.html";
  const file = path.resolve(PUBLIC_DIR, "." + urlPath);
  if (!file.startsWith(PUBLIC_DIR)) return send(res, 403, "forbidden");
  fs.readFile(file, (err, data) => {
    if (err) return send(res, 404, "not found");
    const ext = path.extname(file).toLowerCase();
    const mime = {
      ".html": "text/html; charset=utf-8",
      ".css":  "text/css; charset=utf-8",
      ".js":   "application/javascript; charset=utf-8",
      ".svg":  "image/svg+xml",
      ".png":  "image/png",
      ".ico":  "image/x-icon",
    }[ext] || "application/octet-stream";
    res.writeHead(200, { "content-type": mime, "cache-control": "no-store" });
    res.end(data);
  });
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", c => chunks.push(c));
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      if (!raw) return resolve({});
      try { resolve(JSON.parse(raw)); } catch (e) { reject(e); }
    });
    req.on("error", reject);
  });
}

// ── data gatherers ─────────────────────────────────────────────────────────

function gatherServices() {
  const out = {};
  for (const s of cfg.services) out[s] = platform.serviceStatus(s);
  return out;
}

function fetchPresence(ip, timeoutMs = 1500, port = cfg.presencePort) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: ip, port, path: "/presence", timeout: timeoutMs },
      r => {
        const chunks = [];
        r.on("data", c => chunks.push(c));
        r.on("end", () => {
          try { resolve(JSON.parse(Buffer.concat(chunks).toString("utf8"))); }
          catch (e) { reject(e); }
        });
      }
    );
    req.on("error", reject);
    req.on("timeout", () => { req.destroy(new Error("timeout")); });
    req.end();
  });
}

async function gatherManualPeers() {
  const list = Array.isArray(cfg.peers) ? cfg.peers : [];
  if (!list.length) return [];
  return Promise.all(list.map(async (p) => {
    const port = Number(p.port) || cfg.presencePort;
    const base = {
      hostname: p.name,
      ip:       p.host,
      online:   false,
      is_self:  false,
      is_manual: true,
      port,
    };
    try {
      const snapshot = await fetchPresence(p.host, 1500, port);
      return { ...base, online: true, snapshot };
    } catch (e) {
      return { ...base, snapshot: null, fetch_error: e.message };
    }
  }));
}

// In-memory ring buffer of recent load_1m/mem_pct samples per peer, used to
// render the Unicode sparklines in the REMOTE column. Lost on restart by
// design (no DB, no deps). Keyed by hostname+ip so an IP rotation doesn't
// duplicate the series. Stale entries (peers we haven't seen for
// REMOTE_HISTORY_TTL_MS) are swept on each gather so the map can't grow
// unbounded across renamed peers or rotated IPs.
const REMOTE_HISTORY = new Map();
const REMOTE_HISTORY_LEN     = 32;
const REMOTE_HISTORY_TTL_MS  = 30 * 60_000;
const SPARK_GLYPHS = ["▁", "▂", "▃", "▄", "▅", "▆", "▇", "█"];

// Load sparkline scale: 2.0 is the "this CPU is busy" threshold for a
// single-core machine; clamp to the actual core count so a 16-core box
// doesn't render a constant ▁ when fully loaded. Cached because os.cpus()
// is a syscall on some platforms.
const os = require("os");
const LOAD_SPARK_MAX = Math.max(2.0, (os.cpus() || []).length || 2.0);

function peerKey(peer) {
  return `${peer.hostname || "?"}@${peer.ip || "?"}`;
}

function pushSample(peer) {
  if (!peer.snapshot) return;
  const key = peerKey(peer);
  let hist = REMOTE_HISTORY.get(key);
  if (!hist) { hist = { load: [], mem: [], lastSeen: 0 }; REMOTE_HISTORY.set(key, hist); }
  hist.lastSeen = Date.now();
  if (Number.isFinite(peer.snapshot.load_1m)) {
    hist.load.push(peer.snapshot.load_1m);
    if (hist.load.length > REMOTE_HISTORY_LEN) hist.load.shift();
  }
  if (Number.isFinite(peer.snapshot.mem_pct)) {
    hist.mem.push(peer.snapshot.mem_pct);
    if (hist.mem.length > REMOTE_HISTORY_LEN) hist.mem.shift();
  }
}

function sweepHistory() {
  const cutoff = Date.now() - REMOTE_HISTORY_TTL_MS;
  for (const [k, h] of REMOTE_HISTORY) {
    if (h.lastSeen < cutoff) REMOTE_HISTORY.delete(k);
  }
}

function sparkline(samples, scaleMax) {
  if (!samples || !samples.length) return null;
  const max = scaleMax != null ? scaleMax : Math.max(0.5, ...samples);
  return samples
    .map(v => {
      if (!Number.isFinite(v)) return SPARK_GLYPHS[0];
      const i = Math.max(0, Math.min(SPARK_GLYPHS.length - 1,
        Math.round((v / max) * (SPARK_GLYPHS.length - 1))));
      return SPARK_GLYPHS[i];
    })
    .join("");
}

function decorateWithSparks(peer) {
  if (!peer.snapshot) return peer;
  const hist = REMOTE_HISTORY.get(peerKey(peer));
  if (!hist) return peer;
  peer.snapshot.spark_load = sparkline(hist.load, LOAD_SPARK_MAX);
  peer.snapshot.spark_mem  = sparkline(hist.mem,  100);
  return peer;
}

async function gatherRemote() {
  const manualP = gatherManualPeers();

  let status;
  try {
    status = JSON.parse(
      execSync("tailscale status --json", { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] })
    );
  } catch {
    const manual = await manualP;
    if (manual.length) return { status: "manual-only", peers: manual };
    try {
      const snap = await fetchPresence("127.0.0.1");
      return {
        status: "no-tailscale",
        peers: [{ hostname: snap.name, ip: "127.0.0.1", online: true, is_self: true, snapshot: snap }],
      };
    } catch {
      return { status: "tailscale-unavailable", peers: [] };
    }
  }

  const nodes = [];
  if (status.Self) nodes.push({ raw: status.Self, isSelf: true });
  for (const k of Object.keys(status.Peer || {})) nodes.push({ raw: status.Peer[k], isSelf: false });

  const tsPeers = await Promise.all(nodes.map(async n => {
    const r = n.raw;
    const ip = (r.TailscaleIPs || [])[0];
    const base = {
      hostname:  r.HostName || (r.DNSName || "").split(".")[0] || "?",
      ip,
      online:    !!r.Online || n.isSelf,
      is_self:   n.isSelf,
      os:        r.OS,
      last_seen: r.LastSeen,
    };
    if (!ip || !base.online) return { ...base, snapshot: null };
    try {
      return { ...base, snapshot: await fetchPresence(ip, 1500) };
    } catch (e) {
      return { ...base, snapshot: null, fetch_error: e.message };
    }
  }));

  const manual = await manualP;
  const peers = [...tsPeers, ...manual];

  for (const p of peers) { pushSample(p); decorateWithSparks(p); }
  sweepHistory();

  peers.sort((a, b) => {
    if (a.is_self !== b.is_self) return a.is_self ? -1 : 1;
    if (a.online  !== b.online)  return a.online  ? -1 : 1;
    return (a.hostname || "").localeCompare(b.hostname || "");
  });

  return { status: "ok", peers };
}

// ── tmux web terminal ───────────────────────────────────────────────────────
// Poll-based: list/capture over GET, drive over POST. No PTY, no streaming, no
// deps — every operation is a single tmux invocation against the configured
// session, args passed as argv so nothing reaches a shell. The window index is
// the only caller-controlled value that becomes part of a target, so it is
// constrained to a small integer.

const WINDOW_IDX_RE = /^\d{1,3}$/;

function tmuxRun(args, opts = {}) {
  return new Promise((resolve) => {
    const out = [], err = [];
    const child = spawn(cfg.tmuxBin, args, { stdio: ["pipe", "pipe", "pipe"] });
    child.stdout.on("data", c => out.push(c));
    child.stderr.on("data", c => err.push(c));
    child.on("close", code => resolve({
      ok: code === 0, code,
      stdout: Buffer.concat(out).toString("utf8"),
      stderr: Buffer.concat(err).toString("utf8"),
    }));
    child.on("error", e => resolve({ ok: false, code: -1, stdout: "", stderr: e.message }));
    if (opts.stdin != null) { child.stdin.write(opts.stdin); child.stdin.end(); }
    else child.stdin.end();
  });
}

function tmuxTarget(window) {
  return `${cfg.tmuxSession}:${window}`;
}

async function tmuxListWindows() {
  const fmt = "#{window_index}\t#{window_name}\t#{window_active}\t#{window_panes}\t#{pane_current_command}\t#{pane_current_path}";
  const r = await tmuxRun(["list-windows", "-t", cfg.tmuxSession, "-F", fmt]);
  if (!r.ok) {
    const missing = /can't find session|no server running|no current session/i.test(r.stderr);
    return { ok: true, session: cfg.tmuxSession, exists: !missing && false, windows: [], error: r.stderr.trim() };
  }
  const home = process.env.HOME || "";
  const windows = [];
  for (const line of r.stdout.split("\n")) {
    if (!line.trim()) continue;
    const [index, name, active, panes, command, cwd] = line.split("\t");
    windows.push({
      index: Number(index),
      name,
      active: active === "1",
      panes: Number(panes) || 1,
      command: command || "",
      cwd_short: cwd && home && cwd.startsWith(home) ? "~" + cwd.slice(home.length) : (cwd || ""),
    });
  }
  return { ok: true, session: cfg.tmuxSession, exists: true, windows };
}

async function tmuxCapture(window) {
  if (!WINDOW_IDX_RE.test(String(window))) return { ok: false, error: "invalid window", statusCode: 400 };
  // -e keeps SGR escapes so the browser can colorize; -p writes to stdout;
  // -J joins wrapped lines so the client sees logical rows.
  const r = await tmuxRun(["capture-pane", "-ep", "-t", tmuxTarget(window)]);
  if (!r.ok) return { ok: false, error: r.stderr.trim() || "capture failed", statusCode: 500 };
  return { ok: true, window: Number(window), content: r.stdout };
}

// Keys that may be sent un-escaped (interpreted by tmux as named keys). Anything
// not on this list must travel as literal text via `send-keys -l`, so a caller
// can never smuggle an option or a second command into the argv.
const TMUX_KEY_RE = /^(Enter|Tab|Escape|Space|BSpace|Up|Down|Left|Right|Home|End|PageUp|PageDown|Delete|IC|DC|F[1-9]|F1[0-2]|C-[a-z0-9]|M-[a-z0-9]|C-Up|C-Down|C-Left|C-Right)$/;

async function tmuxSend(window, { text, key }) {
  if (!WINDOW_IDX_RE.test(String(window))) return { ok: false, error: "invalid window", statusCode: 400 };
  const target = tmuxTarget(window);
  let args;
  if (typeof key === "string" && key.length) {
    if (!TMUX_KEY_RE.test(key)) return { ok: false, error: "unsupported key", statusCode: 400 };
    args = ["send-keys", "-t", target, key];
  } else if (typeof text === "string") {
    if (text.length > 4096) return { ok: false, error: "text too long", statusCode: 400 };
    args = ["send-keys", "-t", target, "-l", "--", text];
  } else {
    return { ok: false, error: "text or key required", statusCode: 400 };
  }
  const r = await tmuxRun(args);
  if (!r.ok) return { ok: false, error: r.stderr.trim() || "send failed", statusCode: 500 };
  return { ok: true };
}

async function tmuxSelect(window) {
  if (!WINDOW_IDX_RE.test(String(window))) return { ok: false, error: "invalid window", statusCode: 400 };
  const r = await tmuxRun(["select-window", "-t", tmuxTarget(window)]);
  if (!r.ok) return { ok: false, error: r.stderr.trim() || "select failed", statusCode: 500 };
  return { ok: true };
}

async function tmuxNewWindow(name) {
  const args = ["new-window", "-t", cfg.tmuxSession];
  if (typeof name === "string" && /^[\w.\- ]{1,40}$/.test(name)) args.push("-n", name);
  const r = await tmuxRun(args);
  if (!r.ok) return { ok: false, error: r.stderr.trim() || "new-window failed", statusCode: 500 };
  return { ok: true };
}

function parseCalCache(text) {
  const events = [];
  for (const line of text.split("\n")) {
    if (!line.trim() || line === "__FETCH_FAILED__") continue;
    const m = line.match(/^(\S+)\s+(.+?)\s+\[([^\]]+)\]$/);
    if (!m) continue;
    const [_, start, summary, id] = m;
    events.push({ start, summary, id });
  }
  return events;
}

function refreshCalCache() {
  return new Promise((resolve) => {
    if (!cfg.calendarBin) {
      try { fs.writeFileSync(CAL_CACHE, ""); } catch {}
      return resolve({ ok: false, text: "" });
    }
    const out = [];
    const child = spawn("node", [cfg.calendarBin, "list", "7"], { stdio: ["ignore", "pipe", "ignore"] });
    child.stdout.on("data", c => out.push(c));
    child.on("close", code => {
      const text = Buffer.concat(out).toString("utf8");
      try {
        if (code === 0) fs.writeFileSync(CAL_CACHE, text);
        else fs.writeFileSync(CAL_CACHE, "__FETCH_FAILED__\n");
      } catch {}
      resolve({ ok: code === 0, text: code === 0 ? text : "" });
    });
    child.on("error", () => resolve({ ok: false, text: "" }));
  });
}

async function gatherCalendar() {
  if (!cfg.calendarBin) return { authed: false, fetch_failed: false, events: [], unconfigured: true };

  let needs = true;
  try {
    const st = fs.statSync(CAL_CACHE);
    if ((Date.now() - st.mtimeMs) < 60_000) needs = false;
  } catch {}
  let text = "";
  if (needs) {
    const r = await refreshCalCache();
    text = r.text;
  } else {
    try { text = fs.readFileSync(CAL_CACHE, "utf8"); } catch {}
  }
  if (!text || /^__FETCH_FAILED__/m.test(text)) {
    return {
      authed: false,
      fetch_failed: text.startsWith("__FETCH_FAILED__"),
      events: [],
    };
  }
  return { authed: true, fetch_failed: false, events: parseCalCache(text) };
}

// ── inbox (gmail) ─────────────────────────────────────────────────────────

// "*" globs: translated to a case-insensitive regex with full-string anchors.
// Any other regex metacharacters in the pattern are escaped, so a pattern
// like "[CRON]*" matches subjects literally starting with "[CRON]".
function globToRegex(pat) {
  const escaped = pat.replace(/[.+^${}()|\\[\]]/g, "\\$&").replace(/\*/g, ".*");
  return new RegExp("^" + escaped + "$", "i");
}

function buildBlacklist(bl) {
  const fromRes    = (bl && Array.isArray(bl.fromPatterns)    ? bl.fromPatterns    : []).map(globToRegex);
  const subjectRes = (bl && Array.isArray(bl.subjectPatterns) ? bl.subjectPatterns : []).map(globToRegex);
  const labelSet   = new Set((bl && Array.isArray(bl.labelExcludes) ? bl.labelExcludes : []).map(s => s.toUpperCase()));
  return { fromRes, subjectRes, labelSet };
}

function parseGmailListing(text) {
  const rows = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    const parts = line.split("\t");
    if (parts.length < 4) continue;
    const [id, ts, from, ...rest] = parts;
    rows.push({ id, ts, from, subject: rest.join("\t") });
  }
  return rows;
}

// Server-side filter: gmail.js does not see the blacklist, so the column-level
// filter runs here. Note: labelExcludes can't be applied without an extra API
// call per message (the list output omits labels for compactness), so we
// fall back to letting Gmail's query handle category exclusions by encoding
// them into the list query when configured. The labelSet field is kept for
// future use if we ever fetch labels in list output.
function filterByBlacklist(rows, bl) {
  return rows.filter(r => {
    if (bl.fromRes.some(re => re.test(r.from || ""))) return false;
    if (bl.subjectRes.some(re => re.test(r.subject || ""))) return false;
    return true;
  });
}

function runGmail(args, opts = {}) {
  return new Promise((resolve) => {
    if (!cfg.gmailBin) return resolve({ ok: false, code: -1, stdout: "", stderr: "gmailBin not configured" });
    const env = { ...process.env };
    if (Array.isArray(cfg.gmailSummarizerCmd) && cfg.gmailSummarizerCmd.length) {
      env.GLANCE_GMAIL_SUMMARIZER_CMD = JSON.stringify(cfg.gmailSummarizerCmd);
    }
    const out = [], err = [];
    const child = spawn("node", [cfg.gmailBin, ...args], { stdio: ["pipe", "pipe", "pipe"], env });
    child.stdout.on("data", c => out.push(c));
    child.stderr.on("data", c => err.push(c));
    child.on("close", code => resolve({
      ok: code === 0,
      code,
      stdout: Buffer.concat(out).toString("utf8"),
      stderr: Buffer.concat(err).toString("utf8"),
    }));
    child.on("error", e => resolve({ ok: false, code: -1, stdout: "", stderr: e.message }));
    if (opts.stdin != null) {
      child.stdin.write(opts.stdin);
      child.stdin.end();
    } else {
      child.stdin.end();
    }
  });
}

function defaultInboxQuery() {
  return cfg.gmailImportantOnly
    ? "is:unread in:inbox is:important"
    : "is:unread in:inbox";
}

function refreshGmailCache() {
  return new Promise(async (resolve) => {
    const r = await runGmail(["list", String(cfg.gmailMaxUnread || 20), defaultInboxQuery()]);
    try {
      if (r.ok) fs.writeFileSync(GMAIL_CACHE, r.stdout);
      else fs.writeFileSync(GMAIL_CACHE, "__FETCH_FAILED__\n" + (r.stderr || ""));
    } catch {}
    resolve(r);
  });
}

// Strip the address out of an RFC822 From header like '"Jane" <jane@x.com>'.
function extractEmail(headerValue) {
  if (!headerValue) return null;
  const angle = headerValue.match(/<([^>]+)>/);
  const raw = (angle ? angle[1] : headerValue).trim().toLowerCase();
  return /^[^\s@]+@[^\s@]+$/.test(raw) ? raw : null;
}

// Email -> next-upcoming-event map, refreshed on the same 60s cadence as the
// calendar list cache. Empty when calendarBin is unset or the attendees fetch
// fails; absence is silently treated as "no context to attach."
const CAL_CONTEXT = { map: new Map(), fetchedAt: 0 };

function fetchCalendarContext() {
  return new Promise((resolve) => {
    if (!cfg.calendarBin) { CAL_CONTEXT.map = new Map(); CAL_CONTEXT.fetchedAt = Date.now(); return resolve(); }
    const out = [];
    const child = spawn("node", [cfg.calendarBin, "attendees", "7"], { stdio: ["ignore", "pipe", "ignore"] });
    child.stdout.on("data", c => out.push(c));
    child.on("close", () => {
      const map = new Map();
      const text = Buffer.concat(out).toString("utf8");
      for (const line of text.split("\n")) {
        const parts = line.split("\t");
        if (parts.length < 3) continue;
        const [start, email, summary] = parts;
        if (!email || map.has(email)) continue;
        map.set(email, { start, summary });
      }
      CAL_CONTEXT.map = map;
      CAL_CONTEXT.fetchedAt = Date.now();
      resolve();
    });
    child.on("error", () => { CAL_CONTEXT.fetchedAt = Date.now(); resolve(); });
  });
}

async function ensureCalendarContext() {
  if (Date.now() - CAL_CONTEXT.fetchedAt < 60_000) return;
  await fetchCalendarContext();
}

function decorateInboxItems(items) {
  const teamSet = new Set((cfg.teamEmails || []).map(e => String(e).toLowerCase()));
  for (const m of items) {
    const email = extractEmail(m.from);
    m.from_email = email;
    m.is_team = !!(email && teamSet.has(email));
    const ctx = email ? CAL_CONTEXT.map.get(email) : null;
    m.meeting = ctx || null;
  }
  items.sort((a, b) => {
    if (a.is_team !== b.is_team) return a.is_team ? -1 : 1;
    return (b.ts || "").localeCompare(a.ts || "");
  });
  return items;
}

async function gatherInbox() {
  if (!cfg.gmailBin) {
    return { authed: false, fetch_failed: false, unread_count: 0, items: [], unconfigured: true };
  }
  let needs = true;
  try {
    const st = fs.statSync(GMAIL_CACHE);
    if ((Date.now() - st.mtimeMs) < 60_000) needs = false;
  } catch {}
  let text = "";
  if (needs) {
    const r = await refreshGmailCache();
    text = r.ok ? r.stdout : "";
  } else {
    try { text = fs.readFileSync(GMAIL_CACHE, "utf8"); } catch {}
  }
  if (!text || text.startsWith("__FETCH_FAILED__")) {
    return { authed: false, fetch_failed: text.startsWith("__FETCH_FAILED__"), unread_count: 0, items: [] };
  }
  await ensureCalendarContext();
  const bl = buildBlacklist(cfg.gmailBlacklist);
  const filtered = decorateInboxItems(filterByBlacklist(parseGmailListing(text), bl));
  return {
    authed: true,
    fetch_failed: false,
    important_only: !!cfg.gmailImportantOnly,
    unread_count: filtered.length,
    items: filtered,
  };
}

function gatherMemory() {
  return platform.memoryInfo();
}

// Discover local claude sessions and their process trees. Each top-level
// `claude` whose parent is not also `claude` is one user-facing session;
// its descendants count toward that session's RSS. Worktree detection: walk
// the session's cwd up looking for a .git pointing into a `worktrees/` gitdir.
function gatherSessions() {
  const procs = platform.processList();
  if (!procs.length) return [];

  const isClaude = (p) => {
    const first = (p.args || "").split(/\s+/)[0];
    return first === "claude" || first.endsWith("/claude") || first.endsWith("\\claude.exe") || first.endsWith("/claude.exe");
  };

  const childrenOf = new Map();
  for (const p of procs) {
    if (!childrenOf.has(p.ppid)) childrenOf.set(p.ppid, []);
    childrenOf.get(p.ppid).push(p);
  }

  const claudePids = new Set(procs.filter(isClaude).map((p) => p.pid));
  const roots = procs.filter((p) => isClaude(p) && !claudePids.has(p.ppid));

  const sessions = roots.map((root) => {
    const tree = [];
    const queue = [root];
    while (queue.length) {
      const p = queue.shift();
      tree.push(p);
      const kids = childrenOf.get(p.pid) || [];
      queue.push(...kids);
    }
    const total_rss_kb = tree.reduce((s, p) => s + p.rss_kb, 0);
    const subagents = tree.filter((p) => p !== root && isClaude(p)).length;

    const cwd = platform.processCwd(root.pid);
    let worktree = false;
    let project = null;
    if (cwd) {
      try {
        const gitDir = execSync(`git -C "${cwd}" rev-parse --git-dir`, {
          encoding: "utf8", stdio: ["ignore", "pipe", "ignore"],
        }).trim();
        worktree = /[\\/]worktrees[\\/]/.test(gitDir);
        const top = execSync(`git -C "${cwd}" rev-parse --show-toplevel`, {
          encoding: "utf8", stdio: ["ignore", "pipe", "ignore"],
        }).trim();
        project = path.basename(top);
      } catch {}
    }

    const home = process.env.HOME || process.env.USERPROFILE || "";
    const cwd_short = cwd
      ? (home && cwd.startsWith(home) ? "~" + cwd.slice(home.length) : cwd)
      : null;

    return {
      pid: root.pid,
      cwd, cwd_short, project,
      worktree,
      subagents,
      proc_count: tree.length,
      rss_kb: total_rss_kb,
      rss_mb: Math.round(total_rss_kb / 1024),
    };
  });

  sessions.sort((a, b) => b.rss_kb - a.rss_kb);
  return sessions;
}

async function gatherState() {
  const [calendar, remote, inbox, tmux] = await Promise.all([
    gatherCalendar(),
    gatherRemote(),
    gatherInbox(),
    tmuxListWindows(),
  ]);
  return {
    now: new Date().toISOString(),
    platform: platform.platformLabel,
    version: PKG.version,
    services: gatherServices(),
    memory: gatherMemory(),
    sessions: gatherSessions(),
    remote,
    calendar, inbox, tmux,
    custom: snapshotCustom(),
  };
}

// ── custom HTTP-endpoint widgets ───────────────────────────────────────────
// User-defined widgets that poll an arbitrary URL on an interval. Config is
// pushed from the extension (gsettings) via POST /api/config/custom-widgets
// and persisted to ~/.config/glance/config.json so a restart picks them up.
//
// Each entry: { id, name, url, refreshSec, view, jsonPath?, headers? }.
//   id          stable kebab-case identifier, used as widget id
//   name        display name in the column header
//   url         http(s) URL to GET; must parse as URL
//   refreshSec  poll interval in seconds (5..3600)
//   view        'auto' | 'kv' | 'list' | 'raw'
//   jsonPath    dot path into the response (e.g. "data.items"); optional
//   headers     { name: value } for Authorization etc; optional
//
// Network safety note: this is the one part of the server that talks beyond
// 127.0.0.1 / tailnet. URLs are opted-in by the user; we do not fetch
// anything until they configure it.

const CUSTOM_ID_RE = /^[a-z][a-z0-9_-]{0,31}$/;
const CUSTOM_VIEWS = new Set(["auto", "kv", "list", "raw"]);

const customResults = new Map();  // id → { ok, data, error, fetched_at, view, name }
const customTimers  = new Map();  // id → setTimeout/Interval handle

function snapshotCustom() {
  const out = {};
  for (const [id, r] of customResults) out[id] = r;
  return out;
}

function validateCustomEntry(e) {
  if (!e || typeof e !== "object") return "missing entry";
  const id = typeof e.id === "string" ? e.id.trim() : "";
  const name = typeof e.name === "string" ? e.name.trim() : "";
  const url  = typeof e.url  === "string" ? e.url.trim()  : "";
  const refreshSec = Number(e.refreshSec);
  const view = typeof e.view === "string" ? e.view : "auto";
  const jsonPath = typeof e.jsonPath === "string" ? e.jsonPath.trim() : "";
  const headers  = (e.headers && typeof e.headers === "object" && !Array.isArray(e.headers)) ? e.headers : {};

  if (!CUSTOM_ID_RE.test(id)) return `id must match ${CUSTOM_ID_RE}`;
  if (!name) return "name required";
  if (!url)  return "url required";
  try {
    const u = new URL(url);
    if (u.protocol !== "http:" && u.protocol !== "https:") return "url protocol must be http or https";
  } catch { return "url could not be parsed"; }
  if (!Number.isFinite(refreshSec) || refreshSec < 5 || refreshSec > 3600) return "refreshSec must be 5..3600";
  if (!CUSTOM_VIEWS.has(view)) return `view must be one of ${[...CUSTOM_VIEWS].join(",")}`;

  const safeHeaders = {};
  for (const [k, v] of Object.entries(headers)) {
    if (typeof k !== "string" || !/^[A-Za-z0-9-]+$/.test(k)) return `header key '${k}' invalid`;
    if (typeof v !== "string") return `header '${k}' value must be a string`;
    safeHeaders[k] = v;
  }

  return { id, name, url, refreshSec, view, jsonPath, headers: safeHeaders };
}

function fetchCustomOnce(entry) {
  return new Promise((resolve) => {
    let url;
    try { url = new URL(entry.url); } catch (e) { return resolve({ ok: false, error: "bad url: " + e.message }); }
    const lib = url.protocol === "https:" ? https : http;
    const req = lib.request({
      protocol: url.protocol,
      host:     url.hostname,
      port:     url.port || (url.protocol === "https:" ? 443 : 80),
      path:     url.pathname + (url.search || ""),
      method:   "GET",
      headers:  { accept: "application/json", ...entry.headers },
      timeout:  5000,
    }, r => {
      const chunks = [];
      r.on("data", c => chunks.push(c));
      r.on("end", () => {
        const body = Buffer.concat(chunks).toString("utf8");
        if (r.statusCode < 200 || r.statusCode >= 300) {
          return resolve({ ok: false, error: `http ${r.statusCode}`, status: r.statusCode, body: body.slice(0, 400) });
        }
        let parsed;
        try { parsed = JSON.parse(body); }
        catch { return resolve({ ok: true, data: body.length > 8192 ? body.slice(0, 8192) + "…" : body, isText: true }); }
        let data = parsed;
        if (entry.jsonPath) {
          for (const seg of entry.jsonPath.split(".")) {
            if (data == null) break;
            data = data[seg];
          }
        }
        resolve({ ok: true, data });
      });
    });
    req.on("error",   e => resolve({ ok: false, error: e.message }));
    req.on("timeout", () => { req.destroy(); resolve({ ok: false, error: "timeout" }); });
    req.end();
  });
}

async function tickCustom(entry) {
  const result = await fetchCustomOnce(entry);
  customResults.set(entry.id, {
    ...result,
    fetched_at: new Date().toISOString(),
    view: entry.view,
    name: entry.name,
  });
}

function startCustomPoller(entry) {
  stopCustomPoller(entry.id);
  // immediate fetch, then periodic
  tickCustom(entry);
  const h = setInterval(() => tickCustom(entry), entry.refreshSec * 1000);
  customTimers.set(entry.id, h);
}

function stopCustomPoller(id) {
  const h = customTimers.get(id);
  if (h) { clearInterval(h); customTimers.delete(id); }
  customResults.delete(id);
}

function applyCustomConfig(list) {
  const seen = new Set();
  for (const raw of list) {
    const v = validateCustomEntry(raw);
    if (typeof v === "string") continue;
    seen.add(v.id);
    startCustomPoller(v);
  }
  for (const id of [...customTimers.keys()]) {
    if (!seen.has(id)) stopCustomPoller(id);
  }
}

function actionSetCustomWidgets(body) {
  if (!body || !Array.isArray(body.widgets)) return { ok: false, error: "expected { widgets: [...] }" };
  const valid = [];
  const errors = [];
  const ids = new Set();
  for (const e of body.widgets) {
    const v = validateCustomEntry(e);
    if (typeof v === "string") { errors.push({ entry: e, error: v }); continue; }
    if (ids.has(v.id)) { errors.push({ entry: e, error: `duplicate id ${v.id}` }); continue; }
    ids.add(v.id);
    valid.push(v);
  }
  try {
    cfg = configMod.mutate((current) => ({ ...current, customWidgets: valid }));
  } catch (e) {
    return { ok: false, error: "could not persist: " + e.message };
  }
  applyCustomConfig(valid);
  return { ok: true, accepted: valid.length, rejected: errors };
}

if (Array.isArray(cfg.customWidgets)) applyCustomConfig(cfg.customWidgets);

// ── action handlers ────────────────────────────────────────────────────────

async function actionRefresh() {
  try { fs.unlinkSync(CAL_CACHE); } catch {}
  try { fs.unlinkSync(GMAIL_CACHE); } catch {}
  return gatherState();
}

function validPeerInput(body) {
  if (!body || typeof body !== "object") return "missing body";
  const name = typeof body.name === "string" ? body.name.trim() : "";
  const host = typeof body.host === "string" ? body.host.trim() : "";
  const port = body.port == null ? null : Number(body.port);

  if (!name) return "name required";
  if (!PEER_NAME_RE.test(name)) return "name must match [a-zA-Z0-9._-]";
  if (!host) return "host required";
  if (!HOSTNAME_RE.test(host) && !IPV4_RE.test(host)) return "host must be hostname or IPv4";
  if (port != null && (!Number.isInteger(port) || port < 1 || port > 65535)) return "port must be 1..65535";

  return { name, host, port: port == null ? null : port };
}

function actionAddPeer(body) {
  const v = validPeerInput(body);
  if (typeof v === "string") return { ok: false, error: v };

  try {
    cfg = configMod.mutate((current) => {
      const list = Array.isArray(current.peers) ? current.peers.slice() : [];
      if (list.some(p => p && p.name === v.name)) {
        const err = new Error("peer name already exists");
        err.statusCode = 409;
        throw err;
      }
      const entry = { name: v.name, host: v.host };
      if (v.port != null) entry.port = v.port;
      list.push(entry);
      return { ...current, peers: list };
    });
    return { ok: true, peers: cfg.peers };
  } catch (e) {
    return { ok: false, error: e.message, statusCode: e.statusCode || 500 };
  }
}

function actionRemovePeer(name) {
  if (!name || !PEER_NAME_RE.test(name)) return { ok: false, error: "invalid name", statusCode: 400 };
  let found = false;
  try {
    cfg = configMod.mutate((current) => {
      const list = Array.isArray(current.peers) ? current.peers : [];
      const next = list.filter(p => {
        if (p && p.name === name) { found = true; return false; }
        return true;
      });
      return { ...current, peers: next };
    });
  } catch (e) {
    return { ok: false, error: e.message, statusCode: 500 };
  }
  if (!found) return { ok: false, error: "peer not found", statusCode: 404 };
  return { ok: true, peers: cfg.peers };
}

function actionOpen(url) {
  if (!url) return { ok: false, error: "missing url" };
  const opener =
    process.platform === "linux"  ? "xdg-open" :
    process.platform === "darwin" ? "open"     :
    process.platform === "win32"  ? "cmd"      : "xdg-open";
  const args = process.platform === "win32" ? ["/c", "start", "", url] : [url];
  try {
    spawn(opener, args, { detached: true, stdio: "ignore" }).unref();
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

// ── inbox actions ──────────────────────────────────────────────────────────

async function actionInboxRead(id) {
  if (!GMAIL_ID_RE.test(id || "")) return { ok: false, error: "invalid id", statusCode: 400 };
  if (!cfg.gmailBin) return { ok: false, error: "gmailBin not configured", statusCode: 400 };
  const r = await runGmail(["read", id]);
  if (!r.ok) return { ok: false, error: r.stderr.trim() || "read failed", statusCode: 500 };
  try { return { ok: true, message: JSON.parse(r.stdout) }; }
  catch (e) { return { ok: false, error: "bad gmail.js output: " + e.message, statusCode: 500 }; }
}

async function actionInboxSummarize(id) {
  if (!GMAIL_ID_RE.test(id || "")) return { ok: false, error: "invalid id", statusCode: 400 };
  if (!cfg.gmailBin) return { ok: false, error: "gmailBin not configured", statusCode: 400 };
  const r = await runGmail(["summarize", id]);
  if (!r.ok) return { ok: false, error: r.stderr.trim() || "summarize failed", statusCode: 500 };
  return { ok: true, summary: r.stdout.trim() };
}

async function actionInboxMark(id, action) {
  if (!GMAIL_ID_RE.test(id || "")) return { ok: false, error: "invalid id", statusCode: 400 };
  if (!["read", "archive", "trash"].includes(action)) return { ok: false, error: "invalid action", statusCode: 400 };
  if (!cfg.gmailBin) return { ok: false, error: "gmailBin not configured", statusCode: 400 };
  const r = await runGmail(["mark", id, action]);
  if (!r.ok) return { ok: false, error: r.stderr.trim() || "mark failed", statusCode: 500 };
  try { fs.unlinkSync(GMAIL_CACHE); } catch {}
  return { ok: true };
}

async function actionInboxSearch(query, max) {
  if (!cfg.gmailBin) return { ok: false, error: "gmailBin not configured", statusCode: 400 };
  const q = String(query || "").trim();
  if (!q) return { ok: false, error: "q required", statusCode: 400 };
  if (q.length > 256) return { ok: false, error: "q too long", statusCode: 400 };
  const n = Math.max(1, Math.min(100, Number(max) || 25));
  const r = await runGmail(["list", String(n), q]);
  if (!r.ok) return { ok: false, error: r.stderr.trim() || "search failed", statusCode: 500 };
  await ensureCalendarContext();
  const items = decorateInboxItems(parseGmailListing(r.stdout));
  return { ok: true, query: q, count: items.length, items };
}

async function actionInboxSend(body) {
  if (!cfg.gmailBin) return { ok: false, error: "gmailBin not configured", statusCode: 400 };
  if (!body || typeof body !== "object") return { ok: false, error: "missing body", statusCode: 400 };
  const to      = typeof body.to === "string" ? body.to.trim() : "";
  const subject = typeof body.subject === "string" ? body.subject : "";
  const text    = typeof body.body === "string" ? body.body : "";
  if (!to)      return { ok: false, error: "to required", statusCode: 400 };
  if (!subject) return { ok: false, error: "subject required", statusCode: 400 };
  const reply_to_id = body.reply_to_id;
  if (reply_to_id != null && !GMAIL_ID_RE.test(String(reply_to_id))) {
    return { ok: false, error: "invalid reply_to_id", statusCode: 400 };
  }
  const payload = {
    to, subject, body: text,
    cc:  typeof body.cc  === "string" ? body.cc  : undefined,
    bcc: typeof body.bcc === "string" ? body.bcc : undefined,
    reply_to_id: reply_to_id || undefined,
  };
  const r = await runGmail(["send"], { stdin: JSON.stringify(payload) });
  if (!r.ok) return { ok: false, error: r.stderr.trim() || "send failed", statusCode: 500 };
  try { return { ok: true, ...JSON.parse(r.stdout) }; }
  catch { return { ok: true }; }
}

// ── router ─────────────────────────────────────────────────────────────────

const server = http.createServer(async (req, res) => {
  try {
    if (req.method === "GET" && req.url === "/api/health") {
      return send(res, 200, { ok: true, version: PKG.version, platform: platform.platformLabel });
    }
    if (req.method === "GET" && req.url === "/api/state") {
      return send(res, 200, await gatherState());
    }
    if (req.method === "POST" && req.url === "/api/refresh") {
      return send(res, 200, await actionRefresh());
    }
    if (req.method === "GET" && req.url === "/api/tmux") {
      return send(res, 200, await tmuxListWindows());
    }
    if (req.method === "GET" && req.url.startsWith("/api/tmux/capture")) {
      const u = new URL(req.url, "http://127.0.0.1");
      const r = await tmuxCapture(u.searchParams.get("window"));
      return send(res, r.ok ? 200 : (r.statusCode || 400), r);
    }
    if (req.method === "POST" && req.url === "/api/tmux/send") {
      const body = await readBody(req);
      const r = await tmuxSend(body.window, { text: body.text, key: body.key });
      return send(res, r.ok ? 200 : (r.statusCode || 400), r);
    }
    if (req.method === "POST" && req.url === "/api/tmux/select") {
      const body = await readBody(req);
      const r = await tmuxSelect(body.window);
      return send(res, r.ok ? 200 : (r.statusCode || 400), r);
    }
    if (req.method === "POST" && req.url === "/api/tmux/new-window") {
      const body = await readBody(req);
      const r = await tmuxNewWindow(body.name);
      return send(res, r.ok ? 200 : (r.statusCode || 400), r);
    }
    if (req.method === "POST" && req.url === "/api/open") {
      const body = await readBody(req);
      return send(res, 200, actionOpen(body.url));
    }
    if (req.method === "GET" && req.url === "/api/config/peers") {
      return send(res, 200, { peers: Array.isArray(cfg.peers) ? cfg.peers : [] });
    }
    if (req.method === "POST" && req.url === "/api/config/peers") {
      const body = await readBody(req);
      const r = actionAddPeer(body);
      return send(res, r.ok ? 200 : (r.statusCode || 400), r);
    }
    {
      const m = req.method === "DELETE" && req.url.match(/^\/api\/config\/peers\/([^/?#]+)$/);
      if (m) {
        const r = actionRemovePeer(decodeURIComponent(m[1]));
        return send(res, r.ok ? 200 : (r.statusCode || 400), r);
      }
    }
    if (req.method === "GET" && req.url === "/api/inbox/settings") {
      return send(res, 200, {
        ok: true,
        snippets: cfg.gmailSnippets && typeof cfg.gmailSnippets === "object" ? cfg.gmailSnippets : {},
        important_only: !!cfg.gmailImportantOnly,
        team_emails: Array.isArray(cfg.teamEmails) ? cfg.teamEmails : [],
        has_summarizer: Array.isArray(cfg.gmailSummarizerCmd) && cfg.gmailSummarizerCmd.length > 0,
      });
    }
    if (req.method === "GET" && req.url.startsWith("/api/inbox/search")) {
      const u = new URL(req.url, "http://127.0.0.1");
      const r = await actionInboxSearch(u.searchParams.get("q"), u.searchParams.get("max"));
      return send(res, r.ok ? 200 : (r.statusCode || 400), r);
    }
    {
      const m = req.method === "GET" && req.url.match(/^\/api\/inbox\/([^/?#]+)$/);
      if (m) {
        const r = await actionInboxRead(decodeURIComponent(m[1]));
        return send(res, r.ok ? 200 : (r.statusCode || 400), r);
      }
    }
    {
      const m = req.method === "POST" && req.url.match(/^\/api\/inbox\/([^/?#]+)\/summarize$/);
      if (m) {
        const r = await actionInboxSummarize(decodeURIComponent(m[1]));
        return send(res, r.ok ? 200 : (r.statusCode || 400), r);
      }
    }
    {
      const m = req.method === "POST" && req.url.match(/^\/api\/inbox\/([^/?#]+)\/mark$/);
      if (m) {
        const body = await readBody(req);
        const r = await actionInboxMark(decodeURIComponent(m[1]), body && body.action);
        return send(res, r.ok ? 200 : (r.statusCode || 400), r);
      }
    }
    if (req.method === "POST" && req.url === "/api/inbox/send") {
      const body = await readBody(req);
      const r = await actionInboxSend(body);
      return send(res, r.ok ? 200 : (r.statusCode || 400), r);
    }
    if (req.method === "GET" && req.url === "/api/config/custom-widgets") {
      return send(res, 200, { widgets: Array.isArray(cfg.customWidgets) ? cfg.customWidgets : [] });
    }
    if (req.method === "POST" && req.url === "/api/config/custom-widgets") {
      const body = await readBody(req);
      const r = actionSetCustomWidgets(body);
      return send(res, r.ok ? 200 : 400, r);
    }
    if (req.method === "GET") return serveStatic(req, res);
    send(res, 405, { error: "method not allowed" });
  } catch (e) {
    send(res, 500, { error: e.message });
  }
});

server.on("error", (err) => {
  if (err.code === "EADDRINUSE") {
    console.error(`glance: port ${cfg.port} already in use on ${cfg.host} (another glance backend running?)`);
    process.exit(2);
  }
  console.error(`glance: server error: ${err.code || ""} ${err.message}`);
  process.exit(1);
});

// host "tailscale" → this machine's tailnet IPv4, so the dashboard is reachable
// from other tailnet machines but not the open internet. If tailscale can't be
// queried we fall back to loopback rather than something wider, so a broken
// tailscale never silently exposes the terminal endpoints.
function resolveBindHost() {
  if (cfg.host !== "tailscale") return cfg.host;
  try {
    const ip = execSync("tailscale ip -4", { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] })
      .split("\n").map(s => s.trim()).find(s => IPV4_RE.test(s));
    if (ip) return ip;
    console.error("glance: host=tailscale but `tailscale ip -4` returned no IPv4; binding 127.0.0.1");
  } catch (e) {
    console.error(`glance: host=tailscale but tailscale unavailable (${e.message}); binding 127.0.0.1`);
  }
  return "127.0.0.1";
}

const BIND_HOST = resolveBindHost();
server.listen(cfg.port, BIND_HOST, () => {
  console.log(`glance ${PKG.version} (${platform.platformLabel})  http://${BIND_HOST}:${cfg.port}/`);
});

// Graceful shutdown so the extension can stop us cleanly.
function shutdown() {
  for (const id of [...customTimers.keys()]) stopCustomPoller(id);
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(1), 2000).unref();
}
process.on("SIGTERM", shutdown);
process.on("SIGINT",  shutdown);
