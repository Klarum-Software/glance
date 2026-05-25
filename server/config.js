// glance config — values can be overridden via env or ~/.config/glance/config.json.

const fs   = require("fs");
const os   = require("os");
const path = require("path");

const CONFIG_DIR  = path.join(os.homedir(), ".config", "glance");
const CONFIG_FILE = path.join(CONFIG_DIR, "config.json");

const DEFAULTS = {
  port:       5175,
  host:       "127.0.0.1",
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
  // optional Linear team ID used when creating issues from inbox messages.
  // If unset, the server fetches the viewer's first team on first use.
  linearTeamId: null,
  // optional: inbox-ui /api/linear/sync endpoint
  linearSyncUrl: null,
  // optional: Linear API key for built-in sync (alternative to linearSyncUrl)
  linearApiKey: null,
  // services to ping in the topbar (linux: systemd unit names; macos: launchd labels; win: service names)
  services: ["glance"],
  // tailnet peer presence — turn on if you've installed klarum-presence on peers
  presencePort: 5176,
  // me_emails: used for filtering Linear cache to "issues assigned to me"
  meEmails: [],
  // manually-configured remote peers, added via the REMOTE column "+" button.
  // shown alongside tailscale-discovered peers. each item: { name, host, port? }
  peers: [],
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
  if (process.env.GLANCE_LINEAR_TEAM_ID) env.linearTeamId = process.env.GLANCE_LINEAR_TEAM_ID;
  if (process.env.GLANCE_LINEAR_SYNC)     env.linearSyncUrl = process.env.GLANCE_LINEAR_SYNC;
  if (process.env.GLANCE_LINEAR_API_KEY) env.linearApiKey  = process.env.GLANCE_LINEAR_API_KEY;
  if (process.env.GLANCE_SERVICES)     env.services = process.env.GLANCE_SERVICES.split(",").map(s => s.trim()).filter(Boolean);
  if (process.env.GLANCE_PRESENCE_PORT) env.presencePort = Number(process.env.GLANCE_PRESENCE_PORT);
  if (process.env.GLANCE_ME_EMAILS)    env.meEmails = process.env.GLANCE_ME_EMAILS.split(",").map(s => s.trim().toLowerCase()).filter(Boolean);

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
