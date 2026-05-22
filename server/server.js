#!/usr/bin/env node
// glance — single-screen dashboard, localhost only.
//
//   GET    /                          index.html
//   GET    /<static asset>            public/...
//   GET    /api/state                 aggregated snapshot
//   GET    /api/health                { ok, version, platform }
//   POST   /api/refresh               invalidate caches, return new state
//   POST   /api/sync-linear           proxy to configured linear sync endpoint
//   POST   /api/open                  body: { url } — open in default handler
//   GET    /api/config/peers          list manually-configured remote peers
//   POST   /api/config/peers          body: { name, host, port? } — add peer
//   DELETE /api/config/peers/:name    remove peer
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

const PEER_NAME_RE = /^[a-zA-Z0-9._-]+$/;
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

function gatherLinear(limit = 50) {
  const dir = path.join(cfg.inboxDir, ".linear-cache");
  let names;
  try { names = fs.readdirSync(dir); } catch { return { total: 0, overdue: 0, items: [] }; }
  const today = new Date().toISOString().slice(0, 10);
  const items = [];
  const meEmails = cfg.meEmails.map(e => e.toLowerCase());
  for (const n of names) {
    if (!n.endsWith(".json")) continue;
    if (n === "cycles.json" || n === "milestones.json") continue;
    let i;
    try { i = JSON.parse(fs.readFileSync(path.join(dir, n), "utf8")); } catch { continue; }
    const email = i.assignee?.email?.toLowerCase();
    if (meEmails.length && (!email || !meEmails.includes(email))) continue;
    const t = i.state?.type;
    if (t === "completed" || t === "canceled") continue;
    items.push({
      identifier: i.identifier,
      title: i.title,
      priority: i.priority ?? 0,
      priority_label: i.priorityLabel,
      state_name: i.state?.name,
      state_type: i.state?.type,
      state_color: i.state?.color,
      project_name: i.project?.name,
      project_color: i.project?.color,
      due_date: i.dueDate,
      url: i.url,
      overdue: !!(i.dueDate && i.dueDate < today),
    });
  }
  items.sort((a, b) => {
    const pa = a.priority === 0 ? 99 : a.priority;
    const pb = b.priority === 0 ? 99 : b.priority;
    if (pa !== pb) return pa - pb;
    return (a.due_date || "9999").localeCompare(b.due_date || "9999");
  });
  return {
    total: items.length,
    overdue: items.filter(i => i.overdue).length,
    items: items.slice(0, limit),
  };
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
  const [linear, calendar, remote] = await Promise.all([
    Promise.resolve(gatherLinear()),
    gatherCalendar(),
    gatherRemote(),
  ]);
  return {
    now: new Date().toISOString(),
    platform: platform.platformLabel,
    version: PKG.version,
    services: gatherServices(),
    memory: gatherMemory(),
    sessions: gatherSessions(),
    remote,
    linear, calendar,
  };
}

// ── action handlers ────────────────────────────────────────────────────────

async function actionRefresh() {
  try { fs.unlinkSync(CAL_CACHE); } catch {}
  return gatherState();
}

function syncLinearBuiltIn() {
  return new Promise((resolve) => {
    const query = JSON.stringify({
      query: `{
        issues(
          filter: {
            assignee: { isMe: { eq: true } }
            state: { type: { nin: ["completed", "cancelled"] } }
          }
          first: 100
        ) {
          nodes {
            id identifier title priority priorityLabel url dueDate
            state { name type color }
            project { name color }
            assignee { email }
          }
        }
      }`,
    });

    const opts = {
      hostname: "api.linear.app",
      path: "/graphql",
      method: "POST",
      headers: {
        "content-type": "application/json",
        "content-length": Buffer.byteLength(query),
        "authorization": cfg.linearApiKey,
      },
      timeout: 15000,
    };

    const req = https.request(opts, (r) => {
      const chunks = [];
      r.on("data", c => chunks.push(c));
      r.on("end", () => {
        let body;
        try { body = JSON.parse(Buffer.concat(chunks).toString("utf8")); }
        catch (e) { return resolve({ ok: false, error: "bad JSON: " + e.message }); }

        if (body.errors) return resolve({ ok: false, error: body.errors[0]?.message || "GraphQL error" });

        const issues = body.data?.issues?.nodes || [];
        const dir = path.join(cfg.inboxDir, ".linear-cache");
        try { fs.mkdirSync(dir, { recursive: true }); } catch {}

        // Remove stale issue files (leave cycles.json / milestones.json alone)
        const incoming = new Set(issues.map(i => i.identifier + ".json"));
        try {
          for (const f of fs.readdirSync(dir)) {
            if (f === "cycles.json" || f === "milestones.json") continue;
            if (f.endsWith(".json") && !incoming.has(f)) {
              try { fs.unlinkSync(path.join(dir, f)); } catch {}
            }
          }
        } catch {}

        for (const issue of issues) {
          try {
            fs.writeFileSync(
              path.join(dir, issue.identifier + ".json"),
              JSON.stringify(issue, null, 2) + "\n",
              { mode: 0o600 }
            );
          } catch {}
        }

        resolve({ ok: true, synced: issues.length });
      });
    });

    req.on("error", e => resolve({ ok: false, error: e.message }));
    req.on("timeout", () => { req.destroy(); resolve({ ok: false, error: "timeout" }); });
    req.write(query);
    req.end();
  });
}

function actionSyncLinear() {
  if (cfg.linearApiKey) return syncLinearBuiltIn();
  return new Promise((resolve) => {
    if (!cfg.linearSyncUrl) return resolve({ ok: false, error: "linearSyncUrl not configured" });
    let url;
    try { url = new URL(cfg.linearSyncUrl); } catch (e) { return resolve({ ok: false, error: "bad linearSyncUrl: " + e.message }); }
    const req = http.request({
      protocol: url.protocol, host: url.hostname, port: url.port || 80, path: url.pathname,
      method: "POST", headers: { "content-length": 0 }, timeout: 5000,
    }, r => {
      const chunks = [];
      r.on("data", c => chunks.push(c));
      r.on("end", () => resolve({ ok: r.statusCode === 200, status: r.statusCode,
                                  body: Buffer.concat(chunks).toString("utf8") }));
    });
    req.on("error", e => resolve({ ok: false, error: e.message }));
    req.on("timeout", () => { req.destroy(); resolve({ ok: false, error: "timeout" }); });
    req.end();
  });
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
    if (req.method === "POST" && req.url === "/api/sync-linear") {
      return send(res, 200, await actionSyncLinear());
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
    if (req.method === "GET") return serveStatic(req, res);
    send(res, 405, { error: "method not allowed" });
  } catch (e) {
    send(res, 500, { error: e.message });
  }
});

server.listen(cfg.port, cfg.host, () => {
  console.log(`glance ${PKG.version} (${platform.platformLabel})  http://${cfg.host}:${cfg.port}/`);
});

// Graceful shutdown so the extension can stop us cleanly.
function shutdown() {
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(1), 2000).unref();
}
process.on("SIGTERM", shutdown);
process.on("SIGINT",  shutdown);
