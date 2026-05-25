#!/usr/bin/env node
// gmailBin: read + send + summarize + mark messages via the Gmail API.
// Reads OAuth tokens written by google-auth.js and refreshes access tokens
// on demand. Zero npm deps; MIME assembly is hand-rolled for send.
//
// Subcommands:
//   list <max> [query]          messages matching query (default: is:unread in:inbox)
//                               TSV: id<TAB>ts_iso<TAB>from<TAB>subject
//   read <id>                   JSON to stdout (headers, snippet, plain+html body, labels)
//   summarize <id>              one-line summary. If GLANCE_GMAIL_SUMMARIZER_CMD is
//                               set (JSON array), pipes the body to that command and
//                               returns its stdout; otherwise heuristic (no LLM).
//   send                        reads JSON from stdin {to, subject, body, cc?, bcc?, reply_to_id?}
//   mark <id> <read|archive|trash>
//
// Errors print to stderr; exit code != 0 on failure.

const fs    = require("fs");
const os    = require("os");
const path  = require("path");
const https = require("https");

const TOKEN_FILE = path.join(os.homedir(), ".config", "glance", "google-token.json");
const GMAIL_SCOPE = "https://www.googleapis.com/auth/gmail.modify";

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

async function ensureFresh(tok) {
  if (!Array.isArray(tok.scopes) || !tok.scopes.includes(GMAIL_SCOPE)) {
    const err = new Error(`Gmail scope not granted. Re-run: node server/bin/google-auth.js --gmail`);
    err.code = "NO_GMAIL_SCOPE";
    throw err;
  }
  if (!tok.expires_at || Date.now() > tok.expires_at - 60_000) {
    return refreshAccessToken(tok);
  }
  return tok;
}

function gmailRequest(tok, opts, bodyBuf) {
  return new Promise((resolve, reject) => {
    const headers = Object.assign({ authorization: `Bearer ${tok.access_token}` }, opts.headers || {});
    if (bodyBuf) headers["content-length"] = Buffer.byteLength(bodyBuf);
    const req = https.request({
      hostname: "gmail.googleapis.com",
      method:   opts.method || "GET",
      path:     opts.path,
      headers,
      timeout:  15000,
    }, (r) => {
      const chunks = [];
      r.on("data", (c) => chunks.push(c));
      r.on("end", () => {
        const text = Buffer.concat(chunks).toString("utf8");
        let data = null;
        if (text) { try { data = JSON.parse(text); } catch { data = { raw: text }; } }
        if (r.statusCode >= 400) {
          const msg = (data && data.error && data.error.message) || text || `HTTP ${r.statusCode}`;
          return reject(new Error(msg));
        }
        resolve(data);
      });
    });
    req.on("error", reject);
    req.on("timeout", () => { req.destroy(new Error("gmail request timed out")); });
    if (bodyBuf) req.write(bodyBuf);
    req.end();
  });
}

// ── MIME helpers ─────────────────────────────────────────────────────────

function b64url(buf) {
  return Buffer.from(buf).toString("base64")
    .replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function b64urlDecode(s) {
  s = s.replace(/-/g, "+").replace(/_/g, "/");
  while (s.length % 4) s += "=";
  return Buffer.from(s, "base64");
}

// RFC 2047 Q-encoding for header values containing non-ASCII. Only the
// minimum needed for subjects / display names.
function encodeHeader(s) {
  if (!s || /^[\x20-\x7e]*$/.test(s)) return s || "";
  const enc = Buffer.from(s, "utf8").toString("hex")
    .match(/.{1,2}/g).map(h => "=" + h.toUpperCase()).join("");
  return `=?UTF-8?Q?${enc}?=`;
}

function findHeader(headers, name) {
  if (!headers) return null;
  const lower = name.toLowerCase();
  const h = headers.find(h => h.name && h.name.toLowerCase() === lower);
  return h ? h.value : null;
}

// Walk MIME parts. Returns { text, html } — first text/plain and text/html
// payloads found. Bodies are base64url-decoded.
function extractBodies(payload) {
  const out = { text: "", html: "" };
  if (!payload) return out;
  const visit = (p) => {
    if (!p) return;
    const mt = (p.mimeType || "").toLowerCase();
    if (p.body && p.body.data) {
      const decoded = b64urlDecode(p.body.data).toString("utf8");
      if (mt === "text/plain" && !out.text) out.text = decoded;
      else if (mt === "text/html" && !out.html) out.html = decoded;
    }
    if (Array.isArray(p.parts)) p.parts.forEach(visit);
  };
  visit(payload);
  return out;
}

function buildRfc822({ to, cc, bcc, subject, body, inReplyTo, references }) {
  const lines = [];
  lines.push(`To: ${to}`);
  if (cc)  lines.push(`Cc: ${cc}`);
  if (bcc) lines.push(`Bcc: ${bcc}`);
  lines.push(`Subject: ${encodeHeader(subject || "")}`);
  if (inReplyTo)  lines.push(`In-Reply-To: ${inReplyTo}`);
  if (references) lines.push(`References: ${references}`);
  lines.push(`MIME-Version: 1.0`);
  lines.push(`Content-Type: text/plain; charset="UTF-8"`);
  lines.push(`Content-Transfer-Encoding: 8bit`);
  lines.push("");
  lines.push(body || "");
  return lines.join("\r\n");
}

// ── subcommands ──────────────────────────────────────────────────────────

async function cmdList(tok, max, query) {
  const n = Math.max(1, Math.min(100, Number(max) || 20));
  const q = (query && String(query).trim()) || "is:unread in:inbox";
  const listPath = `/gmail/v1/users/me/messages?` + new URLSearchParams({
    q,
    maxResults: String(n),
  }).toString();
  const idsResp = await gmailRequest(tok, { path: listPath });
  const ids = (idsResp.messages || []).map(m => m.id);

  for (const id of ids) {
    const meta = await gmailRequest(tok, {
      path: `/gmail/v1/users/me/messages/${id}?format=metadata&metadataHeaders=From&metadataHeaders=Subject&metadataHeaders=Date`,
    });
    const from    = (findHeader(meta.payload && meta.payload.headers, "From")    || "").replace(/\s+/g, " ").trim();
    const subject = (findHeader(meta.payload && meta.payload.headers, "Subject") || "(no subject)").replace(/\s+/g, " ").trim();
    let dateStr = findHeader(meta.payload && meta.payload.headers, "Date");
    let ts;
    if (meta.internalDate) ts = new Date(Number(meta.internalDate)).toISOString();
    else if (dateStr) { const d = new Date(dateStr); ts = isNaN(d) ? "" : d.toISOString(); }
    else ts = "";
    process.stdout.write(`${id}\t${ts}\t${from}\t${subject}\n`);
  }
}

async function cmdRead(tok, id) {
  if (!id) throw new Error("usage: gmail.js read <id>");
  const m = await gmailRequest(tok, { path: `/gmail/v1/users/me/messages/${id}?format=full` });
  const headers = m.payload && m.payload.headers;
  const bodies = extractBodies(m.payload);
  const result = {
    id:        m.id,
    thread_id: m.threadId,
    labels:    m.labelIds || [],
    snippet:   m.snippet || "",
    from:      findHeader(headers, "From"),
    to:        findHeader(headers, "To"),
    cc:        findHeader(headers, "Cc"),
    subject:   findHeader(headers, "Subject"),
    date:      findHeader(headers, "Date"),
    message_id_header: findHeader(headers, "Message-ID") || findHeader(headers, "Message-Id"),
    references_header: findHeader(headers, "References"),
    body_text: bodies.text,
    body_html: bodies.html,
  };
  process.stdout.write(JSON.stringify(result, null, 2) + "\n");
}

// Heuristic summarizer. Strips quoted-reply tails (lines starting with ">",
// "On ... wrote:" lead-ins, common "-- " signature delimiters) and returns
// the first ~200 chars of the resulting paragraph on a single line.
function summarize(body_text) {
  if (!body_text) return "";
  let t = body_text.replace(/\r\n/g, "\n");
  const cutAt = (re) => {
    const m = t.match(re);
    if (m && m.index != null) t = t.slice(0, m.index);
  };
  cutAt(/^On .+ wrote:\s*$/m);
  cutAt(/^-{2,}\s*Forwarded message/im);
  cutAt(/^\s*--\s*$/m);
  const lines = t.split("\n").filter(l => !/^\s*>/.test(l));
  const joined = lines.join(" ").replace(/\s+/g, " ").trim();
  return joined.length > 240 ? joined.slice(0, 240).replace(/\s\S*$/, "") + "..." : joined;
}

// Spawn an external summarizer (e.g. `ssh mac-mini ollama run qwen2.5:7b`)
// and pipe the email body to its stdin. Times out at 15s and falls back to
// the heuristic on any failure so the dashboard never hangs on a flaky LLM.
function runExternalSummarizer(cmd, args, prompt) {
  return new Promise((resolve) => {
    const { spawn } = require("child_process");
    let settled = false;
    const out = [], err = [];
    const child = spawn(cmd, args, { stdio: ["pipe", "pipe", "pipe"] });
    const done = (text) => {
      if (settled) return;
      settled = true;
      try { child.kill("SIGTERM"); } catch {}
      resolve(text);
    };
    const t = setTimeout(() => done(null), 15000);
    child.stdout.on("data", c => out.push(c));
    child.stderr.on("data", c => err.push(c));
    child.on("close", (code) => {
      clearTimeout(t);
      if (settled) return;
      if (code === 0) {
        const text = Buffer.concat(out).toString("utf8").trim();
        resolve(text || null);
      } else {
        resolve(null);
      }
      settled = true;
    });
    child.on("error", () => { clearTimeout(t); done(null); });
    try { child.stdin.write(prompt); child.stdin.end(); }
    catch { done(null); }
  });
}

async function cmdSummarize(tok, id) {
  if (!id) throw new Error("usage: gmail.js summarize <id>");
  const m = await gmailRequest(tok, { path: `/gmail/v1/users/me/messages/${id}?format=full` });
  const bodies = extractBodies(m.payload);
  const text = bodies.text || (bodies.html ? bodies.html.replace(/<[^>]+>/g, " ") : "") || m.snippet || "";

  const rawCmd = process.env.GLANCE_GMAIL_SUMMARIZER_CMD;
  if (rawCmd) {
    let argv;
    try { argv = JSON.parse(rawCmd); } catch { argv = null; }
    if (Array.isArray(argv) && argv.length) {
      const prompt = `Summarize the following email in one sentence. Be terse and concrete; do not add preface or sign-off.\n\n---\n${text}\n---\n`;
      const llm = await runExternalSummarizer(argv[0], argv.slice(1), prompt);
      if (llm) {
        process.stdout.write(llm.replace(/\s+/g, " ").trim() + "\n");
        return;
      }
    }
  }
  process.stdout.write(summarize(text) + "\n");
}

async function cmdSend(tok) {
  const raw = await new Promise((resolve, reject) => {
    const chunks = [];
    process.stdin.on("data", c => chunks.push(c));
    process.stdin.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    process.stdin.on("error", reject);
  });
  let req;
  try { req = JSON.parse(raw); } catch (e) { throw new Error("bad JSON on stdin: " + e.message); }
  if (!req.to || !req.subject) throw new Error("to and subject are required");

  let inReplyTo = null, references = null, threadId = null;
  if (req.reply_to_id) {
    const orig = await gmailRequest(tok, {
      path: `/gmail/v1/users/me/messages/${req.reply_to_id}?format=metadata&metadataHeaders=Message-ID&metadataHeaders=References`,
    });
    threadId = orig.threadId || null;
    const h = orig.payload && orig.payload.headers;
    inReplyTo = findHeader(h, "Message-ID") || findHeader(h, "Message-Id");
    references = findHeader(h, "References");
    if (inReplyTo) references = references ? `${references} ${inReplyTo}` : inReplyTo;
  }

  const rfc822 = buildRfc822({
    to: req.to, cc: req.cc, bcc: req.bcc,
    subject: req.subject, body: req.body || "",
    inReplyTo, references,
  });

  const payload = JSON.stringify({
    raw: b64url(rfc822),
    ...(threadId ? { threadId } : {}),
  });
  const resp = await gmailRequest(tok,
    { method: "POST", path: "/gmail/v1/users/me/messages/send", headers: { "content-type": "application/json" } },
    Buffer.from(payload, "utf8"),
  );
  process.stdout.write(JSON.stringify({ ok: true, id: resp.id, thread_id: resp.threadId }) + "\n");
}

async function cmdMark(tok, id, action) {
  if (!id || !action) throw new Error("usage: gmail.js mark <id> <read|archive|trash>");
  if (action === "trash") {
    await gmailRequest(tok, { method: "POST", path: `/gmail/v1/users/me/messages/${id}/trash` });
  } else if (action === "read" || action === "archive") {
    const labels = action === "read" ? ["UNREAD"] : ["INBOX"];
    const payload = Buffer.from(JSON.stringify({ removeLabelIds: labels }), "utf8");
    await gmailRequest(tok,
      { method: "POST", path: `/gmail/v1/users/me/messages/${id}/modify`, headers: { "content-type": "application/json" } },
      payload,
    );
  } else {
    throw new Error(`unknown mark action: ${action}`);
  }
  process.stdout.write(JSON.stringify({ ok: true }) + "\n");
}

(async () => {
  const [cmd, ...rest] = process.argv.slice(2);
  if (!cmd) {
    console.error("usage: gmail.js <list|read|summarize|send|mark> ...");
    process.exit(2);
  }

  let tok;
  try { tok = loadToken(); }
  catch (e) {
    console.error("No token file. Run: node server/bin/google-auth.js --gmail");
    process.exit(1);
  }

  tok = await ensureFresh(tok);

  switch (cmd) {
    case "list":      return cmdList(tok, rest[0], rest.slice(1).join(" "));
    case "read":      return cmdRead(tok, rest[0]);
    case "summarize": return cmdSummarize(tok, rest[0]);
    case "send":      return cmdSend(tok);
    case "mark":      return cmdMark(tok, rest[0], rest[1]);
    default:
      console.error(`unknown subcommand: ${cmd}`);
      process.exit(2);
  }
})().catch((e) => {
  console.error("Error:", e.message);
  process.exit(1);
});
