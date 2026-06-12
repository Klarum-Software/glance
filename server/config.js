// glance config — values can be overridden via env or ~/.config/glance/config.json.

const fs   = require("fs");
const os   = require("os");
const path = require("path");

const CONFIG_DIR  = path.join(os.homedir(), ".config", "glance");
const CONFIG_FILE = path.join(CONFIG_DIR, "config.json");

const DEFAULTS = {
  // 5172 keeps glance clear of the dev worktree port ranges the mac mini
  // hands out (frontends on 5173+N, backends on 8000+N).
  port:       5172,
  // "127.0.0.1" (default), an explicit address, "0.0.0.0", or the literal
  // "tailscale" — which server.js resolves to this host's tailnet IPv4 so the
  // dashboard is reachable from other tailnet machines (and nowhere else).
  host:       "127.0.0.1",
  // tmux session the web terminal drives, and the tmux binary to shell out to.
  tmuxSession: "main",
  tmuxBin:     "tmux",
  // When set to another glance instance's base URL (e.g.
  // "http://100.66.100.32:5172"), this backend proxies all /api/tmux* calls
  // there instead of running tmux locally. That is how every non-host machine
  // joins the one canonical session: tmux "main" lives on s01, s01's glance
  // drives it locally, and k02/k03 point tmuxHost at s01. Null = local tmux.
  tmuxHost:    null,
  inboxDir:   path.join(os.homedir(), "claude-inbox"),
  // optional: path to a calendar.js providing `list 7`-style stdout
  calendarBin: null,
  // optional: path to gmail.js providing list/read/send/summarize/mark
  gmailBin: null,
  // unread inbox cap fetched per /api/state cycle
  gmailMaxUnread: 20,
  // when true, the INBOX column shows only is:important unread mail
  gmailImportantOnly: false,
  // filter noisy senders/subjects out of the inbox column. Patterns use "*"
  // wildcards (case-insensitive). labelExcludes matches Gmail label IDs;
  // CATEGORY_PROMOTIONS and CATEGORY_SOCIAL are excluded by default so the
  // column stays focused on real mail.
  gmailBlacklist: {
    fromPatterns:    [],
    subjectPatterns: [],
    labelExcludes:   ["CATEGORY_PROMOTIONS", "CATEGORY_SOCIAL", "CATEGORY_FORUMS"],
  },
  // canned replies surfaced in the compose modal. Key is the dropdown label,
  // value is the body that replaces the textarea contents when selected.
  gmailSnippets: {},
  // emails whose senders should be highlighted + sorted to the top of the
  // INBOX column (e.g. teammates, manager, on-call rotation).
  teamEmails: [],
  // external summarizer command (argv array). When set, gmail.js summarize
  // pipes the email body to this command's stdin and uses its stdout instead
  // of the heuristic. Example: ["ssh", "mac-mini", "ollama", "run", "qwen2.5:7b"].
  // 15s timeout, falls back to heuristic on any failure.
  gmailSummarizerCmd: null,
  // services to ping in the topbar (linux: systemd unit names; macos: launchd labels; win: service names)
  services: ["glance"],
  // tailnet peer presence — turn on if you've installed klarum-presence on peers
  presencePort: 5176,
  // manually-configured remote peers, added via the REMOTE column "+" button.
  // shown alongside tailscale-discovered peers. each item: { name, host, port? }
  peers: [],
  // production /statusz endpoints surfaced in the PROD column. Each item:
  // { name, url, headers? }. statusz is public + no-auth, so headers are
  // optional; they exist for pointing a target at an auth-gated mirror.
  // Gateway lives on the API subdomain (api.klarum.com per ansible inventory;
  // app.klarum.com is the Vercel frontend). The pipeline exposes a JSON twin
  // at /statusz.json on notices.klarum.com. gatherProd normalizes both the
  // gateway's per-job shape and the pipeline's per-run shape into job cards.
  prodTargets: [
    { name: "gateway",  url: "https://api.klarum.com/statusz" },
    { name: "pipeline", url: "https://notices.klarum.com/statusz.json?limit=5" },
  ],
  // PROD poll cache TTL (seconds). statusz is rate-limited to 10/min per IP,
  // so we cache in-memory and refetch at most once per TTL no matter how many
  // dashboard clients are polling /api/state.
  prodRefreshSec: 30,
  // Liveness checks polled in the background (independent of dashboard
  // clients) so up/down transitions are caught even with no tab open. Each
  // item: { name, url, headers? }. 2xx/3xx counts as up. JSON bodies are
  // sniffed for a version/environment field when present.
  prodHealth: [
    { name: "gateway",  url: "https://api.klarum.com/health" },
    { name: "app",      url: "https://app.klarum.com/" },
    { name: "landing",  url: "https://klarum.com/" },
    { name: "pipeline", url: "https://notices.klarum.com/statusz.json?limit=1" },
  ],
  prodHealthIntervalSec: 60,
  // Deployment sources rendered as cards in the PROD panel. Fetched via the
  // local `gh` CLI (its auth, not ours). kind "workflow" reads the latest
  // Actions run of a deploy workflow; kind "deployment" reads the GitHub
  // Deployments API (how Vercel reports landing/app deploys).
  deployTargets: [
    { name: "pivi prod",     kind: "workflow",   repo: "Klarum-Software/pivi", workflow: "deploy-main.yml" },
    { name: "pivi gateway",  kind: "workflow",   repo: "Klarum-Software/pivi", workflow: "deploy-gateway.yml" },
    { name: "pivi pipeline", kind: "workflow",   repo: "Klarum-Software/pivi", workflow: "deploy-pipeline.yml" },
    { name: "landing",       kind: "deployment", repo: "Klarum-Software/klarum-landing", environment: "Production" },
  ],
  deployRefreshSec: 120,
  // Fleet heartbeats from the pivi gateway's service-token-gated metrics
  // endpoint (GET /api/v2/metrics). Renders locked until the token is added:
  //   "prodFleet": { "url": "...", "headers": { "Authorization": "Bearer <SERVICE_TOKEN>" } }
  prodFleet: { url: "https://api.klarum.com/api/v2/metrics" },
  // SSE fast-lane tick (seconds): how often claude sessions are rescanned and
  // pushed to /api/events subscribers (remote presence + tmux go every other
  // tick). Only runs while a subscriber is connected.
  liveRefreshSec: 3,
};

function load() {
  let user = {};
  try {
    user = JSON.parse(fs.readFileSync(CONFIG_FILE, "utf8"));
  } catch { /* file missing or unparseable — fall through to defaults */ }

  const env = {};
  if (process.env.GLANCE_PORT)         env.port = Number(process.env.GLANCE_PORT);
  if (process.env.GLANCE_HOST)         env.host = process.env.GLANCE_HOST;
  if (process.env.GLANCE_INBOX)        env.inboxDir = process.env.GLANCE_INBOX;
  if (process.env.GLANCE_CALENDAR_BIN) env.calendarBin = process.env.GLANCE_CALENDAR_BIN;
  if (process.env.GLANCE_GMAIL_BIN)    env.gmailBin    = process.env.GLANCE_GMAIL_BIN;
  if (process.env.GLANCE_GMAIL_MAX_UNREAD) env.gmailMaxUnread = Number(process.env.GLANCE_GMAIL_MAX_UNREAD);
  if (process.env.GLANCE_GMAIL_IMPORTANT_ONLY) env.gmailImportantOnly = /^(1|true|yes)$/i.test(process.env.GLANCE_GMAIL_IMPORTANT_ONLY);
  if (process.env.GLANCE_TEAM_EMAILS)  env.teamEmails  = process.env.GLANCE_TEAM_EMAILS.split(",").map(s => s.trim().toLowerCase()).filter(Boolean);
  if (process.env.GLANCE_TMUX_SESSION) env.tmuxSession = process.env.GLANCE_TMUX_SESSION;
  if (process.env.GLANCE_TMUX_BIN)     env.tmuxBin     = process.env.GLANCE_TMUX_BIN;
  if (process.env.GLANCE_TMUX_HOST)    env.tmuxHost    = process.env.GLANCE_TMUX_HOST;
  if (process.env.GLANCE_SERVICES)     env.services = process.env.GLANCE_SERVICES.split(",").map(s => s.trim()).filter(Boolean);
  if (process.env.GLANCE_PRESENCE_PORT) env.presencePort = Number(process.env.GLANCE_PRESENCE_PORT);
  if (process.env.GLANCE_PROD_TARGETS) {
    try { env.prodTargets = JSON.parse(process.env.GLANCE_PROD_TARGETS); } catch { /* keep file/default */ }
  }
  if (process.env.GLANCE_PROD_REFRESH_SEC) env.prodRefreshSec = Number(process.env.GLANCE_PROD_REFRESH_SEC);
  if (process.env.GLANCE_PROD_HEALTH) {
    try { env.prodHealth = JSON.parse(process.env.GLANCE_PROD_HEALTH); } catch { /* keep file/default */ }
  }
  if (process.env.GLANCE_PROD_HEALTH_INTERVAL_SEC) env.prodHealthIntervalSec = Number(process.env.GLANCE_PROD_HEALTH_INTERVAL_SEC);
  if (process.env.GLANCE_DEPLOY_TARGETS) {
    try { env.deployTargets = JSON.parse(process.env.GLANCE_DEPLOY_TARGETS); } catch { /* keep file/default */ }
  }
  if (process.env.GLANCE_DEPLOY_REFRESH_SEC) env.deployRefreshSec = Number(process.env.GLANCE_DEPLOY_REFRESH_SEC);
  if (process.env.GLANCE_PROD_FLEET) {
    try { env.prodFleet = JSON.parse(process.env.GLANCE_PROD_FLEET); } catch { /* keep file/default */ }
  }
  if (process.env.GLANCE_LIVE_REFRESH_SEC) env.liveRefreshSec = Number(process.env.GLANCE_LIVE_REFRESH_SEC);

  return { ...DEFAULTS, ...user, ...env };
}

// Atomic read-modify-write of the JSON config file. The mutator receives the
// current on-disk object (or {} if missing) and returns a new object to write.
// Writes go to a sibling tmpfile + rename so a crash mid-write can't corrupt
// the file. Returns the merged-with-defaults loaded config.
function mutate(mutator) {
  let current = {};
  try {
    current = JSON.parse(fs.readFileSync(CONFIG_FILE, "utf8"));
  } catch { /* file missing or unparseable — start from {} */ }

  const next = mutator(current) || current;

  try { fs.mkdirSync(CONFIG_DIR, { recursive: true }); } catch {}
  const tmp = CONFIG_FILE + ".tmp-" + process.pid + "-" + Date.now();
  fs.writeFileSync(tmp, JSON.stringify(next, null, 2) + "\n", { mode: 0o600 });
  fs.renameSync(tmp, CONFIG_FILE);

  return load();
}

module.exports = { load, mutate, CONFIG_DIR, CONFIG_FILE, DEFAULTS };
