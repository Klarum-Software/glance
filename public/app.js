// glance-ui client. Vanilla JS, no build step. Polls /api/state every 30s
// and re-renders. Buttons POST to action endpoints.

const REFRESH_MS = 30_000;
const TODAY      = new Date().toISOString().slice(0, 10);
const TOMORROW   = (() => { const d = new Date(); d.setDate(d.getDate() + 1); return d.toISOString().slice(0, 10); })();

const TERM_POLL_MS  = 1200;

const PANELS       = ["remote", "sessions", "terminal", "mail"];
const PANEL_KEY    = "glance.panel";
const COLLAPSE_KEY = "glance.sidebar.collapsed";

const $ = (id) => document.getElementById(id);
const el = (tag, attrs = {}, ...children) => {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === "class")     n.className = v;
    else if (k === "html") n.innerHTML = v;
    else if (k === "on")   Object.entries(v).forEach(([ev, fn]) => n.addEventListener(ev, fn));
    else                   n.setAttribute(k, v);
  }
  for (const c of children) {
    if (c == null) continue;
    n.appendChild(typeof c === "string" ? document.createTextNode(c) : c);
  }
  return n;
};

// ── data fetch ─────────────────────────────────────────────────────────────

async function fetchState() {
  const r = await fetch("/api/state", { cache: "no-store" });
  if (!r.ok) throw new Error(`/api/state ${r.status}`);
  return r.json();
}

async function postAction(path, body = null) {
  const init = { method: "POST", cache: "no-store" };
  if (body) {
    init.headers = { "content-type": "application/json" };
    init.body = JSON.stringify(body);
  }
  const r = await fetch(path, init);
  if (!r.ok) throw new Error(`${path} ${r.status}`);
  return r.json();
}

// ── toast ──────────────────────────────────────────────────────────────────

let toastTimer = null;
function toast(msg, ms = 2500) {
  const t = $("toast");
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, ms);
}

// ── renderers ──────────────────────────────────────────────────────────────

function renderClock(iso) {
  const d = new Date(iso);
  const hh = String(d.getHours()).padStart(2, "0");
  const mm = String(d.getMinutes()).padStart(2, "0");
  const ss = String(d.getSeconds()).padStart(2, "0");
  $("clock").textContent = `${hh}:${mm}:${ss}`;
}

function renderServices(svc) {
  for (const node of document.querySelectorAll(".svc")) {
    const name = node.dataset.svc;
    node.dataset.state = svc[name] || "unknown";
  }
}

function fmtUptime(s) {
  if (!s) return "—";
  if (s < 3600)  return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h${Math.floor((s % 3600) / 60)}m`;
  return `${Math.floor(s / 86400)}d${Math.floor((s % 86400) / 3600)}h`;
}
function fmtAgo(input) {
  if (!input) return "—";
  const ms = typeof input === "number" ? input : Date.parse(input);
  const s = (Date.now() - ms) / 1000;
  if (!Number.isFinite(s)) return "—";
  if (s < 60)    return `${Math.round(s)}s ago`;
  if (s < 3600)  return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}
function renderPeerRow(p) {
  const dot  = el("span", { class: "peer-dot " + (p.online ? "online" : "offline") });
  const head = el("div", { class: "peer-head" },
    dot,
    el("span", { class: "peer-name" }, p.hostname + (p.is_self ? " (this)" : "")),
    p.os ? el("span", { class: "peer-os" }, p.os) : null,
    el("span", { class: "peer-ip" }, p.ip || ""),
  );

  const removeBtn = p.is_manual
    ? el("button", {
        class: "peer-remove",
        title: "remove peer",
        on: { click: (ev) => { ev.stopPropagation(); removePeer(p.hostname); } },
      }, "×")
    : null;

  const cls = "tcard tcard-peer" + (p.is_manual ? " manual" : "");
  const card = (variant, ...body) =>
    el("div", { class: cls + (variant ? " " + variant : "") },
      el("div", { class: "tcard-accent" }),
      el("div", { class: "tcard-body" }, ...body),
      removeBtn,
    );

  if (!p.online) {
    return card("offline", head,
      el("div", { class: "peer-note" }, p.is_manual && p.fetch_error
        ? `unreachable · ${p.fetch_error}`
        : "offline · last seen " + fmtAgo(p.last_seen)),
    );
  }
  if (!p.snapshot) {
    return card("stale", head,
      el("div", { class: "peer-note" },
        p.fetch_error ? `presence agent: ${p.fetch_error}` : "no presence agent on :5176"),
    );
  }
  const s = p.snapshot;
  const t = s.active_tmux;
  const sessTxt = t
    ? `${t.session || "tmux"}${t.window ? ":" + t.window : ""}` +
      (t.pane_current_command ? ` · ${t.pane_current_command}` : "")
    : "no tmux";
  const claudeRunning = Array.isArray(s.agents)
    ? s.agents.filter(a => a.kind === "claude" && a.state === "running").length
    : 0;
  const gitTxt = s.git && s.git.branch
    ? `${s.git.repo || ""}/${s.git.branch}${s.git.dirty ? ` +${s.git.dirty}` : ""}`
    : "—";
  const loadTxt = typeof s.load_1m === "number" ? s.load_1m.toFixed(2) : "—";
  const memTxt  = s.mem_pct != null ? `${s.mem_pct}%` : "—";

  return card(p.is_self ? "self" : "",
    head,
    el("div", { class: "peer-grid" },
      el("div", { class: "peer-cell" },
        el("span", { class: "peer-key" }, "up"),
        el("span", { class: "peer-val" }, fmtUptime(s.uptime_s)),
      ),
      el("div", { class: "peer-cell" },
        el("span", { class: "peer-key" }, "load"),
        el("span", { class: "peer-val" }, `${loadTxt} · mem ${memTxt}`),
      ),
      el("div", { class: "peer-cell wide" },
        el("span", { class: "peer-key" }, "tmux"),
        el("span", { class: "peer-val" }, sessTxt),
      ),
      el("div", { class: "peer-cell" },
        el("span", { class: "peer-key" }, "git"),
        el("span", { class: "peer-val" }, gitTxt),
      ),
      el("div", { class: "peer-cell" },
        el("span", { class: "peer-key" }, "claude"),
        el("span", { class: "peer-val claude-procs" }, `${claudeRunning} running`),
      ),
    ),
  );
}

function renderRemote(r) {
  const grid = $("remote-grid");
  const meta = $("remote-meta");
  grid.replaceChildren();

  if (!r || r.status === "tailscale-unavailable" || !r.peers?.length) {
    meta.textContent = "· no peers";
    grid.appendChild(el("div", { class: "remote-empty" },
      el("div", { class: "remote-empty-title" }, "no peers reachable"),
      el("div", { class: "remote-empty-hint" },
        r?.status === "tailscale-unavailable"
          ? el("span", {}, "Tailscale not running.")
          : el("span", {}, "Install ", el("code", {}, "klarum-presence"), " on each tailnet machine."),
      )
    ));
    return;
  }

  const online = r.peers.filter(p => p.online).length;
  meta.textContent = `· ${online}/${r.peers.length} online`;
  for (const p of r.peers) grid.appendChild(renderPeerRow(p));
}

function fmtBytes(kb) {
  if (!Number.isFinite(kb) || kb <= 0) return "0";
  if (kb < 1024)        return `${kb} K`;
  if (kb < 1024 * 1024) return `${(kb / 1024).toFixed(0)} M`;
  return `${(kb / 1024 / 1024).toFixed(1)} G`;
}

function renderSessions(state) {
  const list = $("sessions-list");
  const segs = $("ram-bar-segs");
  const meta = $("sessions-meta");
  list.replaceChildren();
  segs.replaceChildren();

  const mem      = state.memory || { total_kb: 0, available_kb: 0, used_kb: 0 };
  const sessions = state.sessions || [];
  const totalKb  = Math.max(1, mem.total_kb);

  // ── header meta: "5.7G / 27G · 2 sess"
  meta.textContent =
    `· ${fmtBytes(mem.used_kb)} / ${fmtBytes(totalKb)} · ${sessions.length} sess`;

  // ── vertical stacked bar ────────────────────────────────────────────────
  // Anchored bottom: sessions first (in size order), then "other", then
  // "free" at the top. Each segment's height is proportional to total RAM.
  const sumSessionsKb = sessions.reduce((s, x) => s + x.rss_kb, 0);
  const otherKb       = Math.max(0, mem.used_kb - sumSessionsKb);
  const freeKb        = Math.max(0, mem.available_kb);

  sessions.forEach((s, i) => {
    segs.appendChild(el("div", {
      class: "ram-seg session" + (i % 2 === 1 ? " alt" : ""),
      title: `${s.cwd_short || ("pid " + s.pid)} — ${fmtBytes(s.rss_kb)}`,
      style: `height: ${(s.rss_kb / totalKb * 100).toFixed(3)}%`,
    }));
  });
  if (otherKb > 0) {
    segs.appendChild(el("div", {
      class: "ram-seg other",
      title: `other processes — ${fmtBytes(otherKb)}`,
      style: `height: ${(otherKb / totalKb * 100).toFixed(3)}%`,
    }));
  }
  if (freeKb > 0) {
    segs.appendChild(el("div", {
      class: "ram-seg free",
      title: `available — ${fmtBytes(freeKb)}`,
      style: `height: ${(freeKb / totalKb * 100).toFixed(3)}%`,
    }));
  }

  // ── session rows + "other"/"free" legend entries ────────────────────────
  if (!sessions.length) {
    list.appendChild(el("div", { class: "sessions-empty" }, "no claude sessions"));
  }

  sessions.forEach((s, i) => {
    const title = s.rel || s.cwd_short || `pid ${s.pid}`;
    const badges = [];
    if (s.worktree)  badges.push(el("span", { class: "tcard-badge warn" }, "worktree"));
    if (s.subagents) badges.push(el("span", { class: "tcard-badge info" }, `${s.subagents} sub`));
    badges.push(el("span", { class: "tcard-badge mute" }, `pid ${s.pid}`));

    list.appendChild(
      el("div", {
        class: "tcard tcard-session" + (i % 2 === 1 ? " alt" : "") + (s.worktree ? " worktree" : ""),
      },
        el("div", { class: "tcard-accent" }),
        el("div", { class: "tcard-body" },
          el("div", { class: "tcard-head" },
            el("span", { class: "tcard-title", title: s.cwd || "" }, title),
            el("span", { class: "tcard-value" }, fmtBytes(s.rss_kb)),
          ),
          el("div", { class: "tcard-badges" }, ...badges),
        ),
      )
    );
  });

  // legend: other + free (no accent bar — they are not sessions)
  const legendRow = (swatch, name, kb) =>
    el("div", { class: "tcard tcard-legend" },
      el("div", { class: "tcard-body" },
        el("div", { class: "tcard-head" },
          el("span", { class: "session-swatch " + swatch }),
          el("span", { class: "tcard-title mute" }, name),
          el("span", { class: "tcard-value mute" }, fmtBytes(kb)),
        ),
      ),
    );
  list.appendChild(legendRow("other", "other processes", otherKb));
  list.appendChild(legendRow("free", "free", freeKb));
}

function renderCalendar(cal) {
  const list = $("calendar-list");
  list.replaceChildren();
  if (!cal.authed) {
    list.appendChild(el("li", { class: "empty" }, "not authed — run: node server/bin/google-auth.js --calendar"));
    $("calendar-meta").textContent = "";
    return;
  }
  if (cal.fetch_failed) {
    list.appendChild(el("li", { class: "empty" }, "fetch failed"));
    $("calendar-meta").textContent = "";
    return;
  }
  if (!cal.events.length) {
    list.appendChild(el("li", { class: "empty" }, "nothing in the next 7 days"));
    $("calendar-meta").textContent = "";
    return;
  }
  $("calendar-meta").textContent = `· ${cal.events.length} upcoming`;

  // group by day, preserving order
  const byDay = new Map();
  for (const ev of cal.events) {
    const day = ev.start.slice(0, 10);
    if (!byDay.has(day)) byDay.set(day, []);
    byDay.get(day).push(ev);
  }
  for (const [day, evs] of byDay) {
    const label = day === TODAY ? "today" : day === TOMORROW ? "tomorrow" : day;
    list.appendChild(el("li", { class: "cal-day" }, label));
    for (const ev of evs) {
      const time = ev.start.length >= 16 ? ev.start.slice(11, 16) : "all day";
      list.appendChild(
        el("li", { class: "cal-event", title: ev.summary },
          el("span", { class: "cal-time" }, time),
          el("span", { class: "cal-summary" }, ev.summary),
        )
      );
    }
  }
}

function shortFrom(from) {
  if (!from) return "?";
  const m = from.match(/^\s*"?([^"<]+?)"?\s*<[^>]+>\s*$/);
  return m ? m[1].trim() : from.trim();
}

function fmtMeetingStart(start) {
  if (!start) return "";
  if (start.length === 10) return start.slice(5);
  if (start.length >= 16)  return start.slice(5, 10) + " " + start.slice(11, 16);
  return start;
}

let INBOX_SETTINGS = { snippets: {}, has_summarizer: false };
let INBOX_SEARCH_ACTIVE = false;
let LAST_LIVE_INBOX = null;

function renderInboxItem(m) {
  const tags = [];
  if (m.is_team)  tags.push(el("span", { class: "inbox-tag team" }, "team"));
  if (m.meeting)  tags.push(el("span", { class: "inbox-tag meeting", title: m.meeting.summary || "" },
    `· meeting ${fmtMeetingStart(m.meeting.start)}`));

  const actions = [
    el("button", { class: "btn btn-xs", "data-act": "open",      "data-id": m.id }, "open"),
    el("button", { class: "btn btn-xs", "data-act": "summarize", "data-id": m.id }, "summary"),
    el("button", { class: "btn btn-xs", "data-act": "reply",     "data-id": m.id }, "reply"),
    el("button", { class: "btn btn-xs", "data-act": "archive",   "data-id": m.id }, "archive"),
  ];

  return el("li", {
    class: "inbox-row" + (m.is_team ? " team" : ""),
    title: m.from || "",
  },
    el("span", { class: "inbox-from" }, shortFrom(m.from)),
    el("span", { class: "inbox-subject" },
      m.subject || "(no subject)",
      ...tags,
    ),
    el("span", { class: "inbox-actions" }, ...actions),
  );
}

function renderInbox(inbox) {
  const list = $("inbox-list");
  list.replaceChildren();
  if (!inbox || inbox.unconfigured) {
    list.appendChild(el("li", { class: "empty" }, "gmail not configured — run: node server/bin/google-auth.js --gmail"));
    $("inbox-meta").textContent = "";
    return;
  }
  if (!inbox.authed) {
    list.appendChild(el("li", { class: "empty" }, inbox.fetch_failed ? "fetch failed" : "not authed"));
    $("inbox-meta").textContent = "";
    return;
  }
  if (!inbox.items || !inbox.items.length) {
    list.appendChild(el("li", { class: "empty" }, "inbox zero"));
    $("inbox-meta").textContent = inbox.important_only ? "· 0 important unread" : "· 0 unread";
    return;
  }
  $("inbox-meta").textContent = inbox.important_only
    ? `· ${inbox.unread_count} important unread`
    : `· ${inbox.unread_count} unread`;
  for (const m of inbox.items) list.appendChild(renderInboxItem(m));
}

function renderSearchResults(payload) {
  const list = $("inbox-list");
  list.replaceChildren();
  $("inbox-meta").textContent = `· search: ${payload.count} hit${payload.count === 1 ? "" : "s"}`;
  if (!payload.items.length) {
    list.appendChild(el("li", { class: "empty" }, "no matches"));
    return;
  }
  for (const m of payload.items) list.appendChild(renderInboxItem(m));
}

function render(state) {
  renderClock(state.now);
  renderServices(state.services || {});
  updateNavBadges(state);
  renderRemote(state.remote);
  renderSessions(state);
  renderTerminalTabs(state.tmux);
  renderCalendar(state.calendar);
  LAST_LIVE_INBOX = state.inbox;
  if (!INBOX_SEARCH_ACTIVE) renderInbox(state.inbox);
}

// ── terminal (tmux poll) ───────────────────────────────────────────────────
// Poll-based, no streaming: render the window list as clickable tabs, and on a
// short interval capture the selected window's visible pane and paint it. Key
// presses inside the screen are forwarded to tmux via /api/tmux/send, then we
// re-capture quickly so typing feels responsive.

const TERM = { window: null, exists: false, polling: false, lastContent: null };

// SGR colorizer for `tmux capture-pane -e` output. We render to spans with
// inline styles; standard xterm palette so claude's TUI looks like it does in
// a real terminal. Anything we don't recognize is dropped, never emitted raw.
const ANSI_16 = [
  "#1a1a1d", "#ef7972", "#5ab67d", "#e8a23d", "#6aa3ff", "#c98bdb", "#54c7c7", "#b6b6b1",
  "#5e5f63", "#ff9b94", "#7fd49a", "#f2bf6a", "#93bdff", "#dca8e8", "#7adada", "#f4f4f0",
];
function ansi256(n) {
  if (n < 16) return ANSI_16[n];
  if (n < 232) {
    n -= 16;
    const f = (x) => { const v = x === 0 ? 0 : 55 + x * 40; return v.toString(16).padStart(2, "0"); };
    return `#${f(Math.floor(n / 36))}${f(Math.floor(n / 6) % 6)}${f(n % 6)}`;
  }
  const v = (8 + (n - 232) * 10).toString(16).padStart(2, "0");
  return `#${v}${v}${v}`;
}
const escHtml = (s) => s.replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]));

function ansiToHtml(text) {
  let fg = null, bg = null, bold = false, inverse = false, out = "", openSpan = false;
  const closeSpan = () => { if (openSpan) { out += "</span>"; openSpan = false; } };
  const openStyled = () => {
    let f = fg, b = bg;
    if (inverse) { f = bg || "var(--paper)"; b = fg || "var(--ink)"; }
    const styles = [];
    if (f) styles.push(`color:${f}`);
    if (b) styles.push(`background:${b}`);
    if (bold) styles.push("font-weight:600");
    if (!styles.length) return;
    out += `<span style="${styles.join(";")}">`;
    openSpan = true;
  };
  // Split on CSI sequences, keeping the codes.
  const parts = text.split(/\x1b\[([0-9;]*)m/);
  for (let i = 0; i < parts.length; i++) {
    if (i % 2 === 0) {
      if (!parts[i]) continue;
      closeSpan();
      openStyled();
      out += escHtml(parts[i]);
    } else {
      const codes = parts[i].split(";").map(Number);
      for (let j = 0; j < codes.length; j++) {
        const c = codes[j];
        if (c === 0 || Number.isNaN(c)) { fg = bg = null; bold = false; inverse = false; }
        else if (c === 1) bold = true;
        else if (c === 22) bold = false;
        else if (c === 7) inverse = true;
        else if (c === 27) inverse = false;
        else if (c === 39) fg = null;
        else if (c === 49) bg = null;
        else if (c >= 30 && c <= 37) fg = ANSI_16[c - 30];
        else if (c >= 90 && c <= 97) fg = ANSI_16[c - 90 + 8];
        else if (c >= 40 && c <= 47) bg = ANSI_16[c - 40];
        else if (c >= 100 && c <= 107) bg = ANSI_16[c - 100 + 8];
        else if (c === 38 || c === 48) {
          const target = c === 38;
          if (codes[j + 1] === 5) { const col = ansi256(codes[j + 2]); target ? (fg = col) : (bg = col); j += 2; }
          else if (codes[j + 1] === 2) { const col = `rgb(${codes[j+2]||0},${codes[j+3]||0},${codes[j+4]||0})`; target ? (fg = col) : (bg = col); j += 4; }
        }
      }
    }
  }
  closeSpan();
  return out;
}

function renderTerminalTabs(tmux) {
  const tabs = $("term-tabs");
  const meta = $("terminal-meta");
  const hint = $("term-hint");
  if (!tabs) return;
  tabs.replaceChildren();
  TERM.exists = !!(tmux && tmux.exists);

  if (!tmux || !tmux.exists) {
    meta.textContent = tmux && tmux.session ? `· no session "${tmux.session}"` : "· tmux idle";
    hint.textContent = tmux && tmux.error ? tmux.error : `start it with: tmux new -s ${tmux?.session || "main"}`;
    $("term-screen").replaceChildren();
    TERM.window = null;
    return;
  }

  const wins = tmux.windows || [];
  meta.textContent = `· ${tmux.session} · ${wins.length} win`;
  const activeWin = wins.find(w => w.active);
  // Default selection to whatever tmux itself has active.
  if (TERM.window == null || !wins.some(w => w.index === TERM.window)) {
    TERM.window = activeWin ? activeWin.index : (wins[0] ? wins[0].index : null);
  }
  for (const w of wins) {
    const sel = w.index === TERM.window;
    tabs.appendChild(el("button", {
      class: "term-tab" + (sel ? " selected" : "") + (w.active ? " active" : ""),
      title: `${w.cwd_short || ""} · ${w.command}`,
      on: { click: () => selectTerminalWindow(w.index) },
    },
      el("span", { class: "term-tab-idx" }, String(w.index)),
      el("span", { class: "term-tab-name" }, w.name || w.command || "shell"),
    ));
  }
  hint.textContent = "click the screen and type — keys go straight to tmux";
  captureTerminal();
}

async function selectTerminalWindow(index) {
  TERM.window = index;
  TERM.lastContent = null;
  renderTerminalTabsSelection();
  try { await postAction("/api/tmux/select", { window: index }); } catch {}
  captureTerminal();
  $("term-screen").focus();
}

function renderTerminalTabsSelection() {
  for (const tab of document.querySelectorAll(".term-tab")) {
    const idx = Number(tab.querySelector(".term-tab-idx").textContent);
    tab.classList.toggle("selected", idx === TERM.window);
  }
}

async function captureTerminal() {
  if (TERM.window == null || !TERM.exists) return;
  try {
    const r = await fetch(`/api/tmux/capture?window=${TERM.window}`, { cache: "no-store" });
    const j = await r.json();
    if (!j.ok || j.window !== TERM.window) return;
    // Trim trailing blank lines so the prompt sits at the bottom, not buried.
    const content = (j.content || "").replace(/\n+$/g, "");
    if (content === TERM.lastContent) return;
    TERM.lastContent = content;
    const screen = $("term-screen");
    const atBottom = screen.scrollTop + screen.clientHeight >= screen.scrollHeight - 8;
    screen.innerHTML = ansiToHtml(content);
    if (atBottom) screen.scrollTop = screen.scrollHeight;
  } catch {}
}

async function sendTerminal(payload) {
  if (TERM.window == null || !TERM.exists) return;
  try {
    await fetch("/api/tmux/send", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ window: TERM.window, ...payload }),
    });
    // Re-capture quickly for a responsive echo, on top of the steady poll.
    setTimeout(captureTerminal, 60);
  } catch {}
}

// Translate a keydown into a tmux send-keys payload. Printable characters go as
// literal text; everything else maps to a tmux key name (or is ignored).
const TERM_KEYMAP = {
  Enter: "Enter", Tab: "Tab", Escape: "Escape", Backspace: "BSpace",
  ArrowUp: "Up", ArrowDown: "Down", ArrowLeft: "Left", ArrowRight: "Right",
  Home: "Home", End: "End", PageUp: "PageUp", PageDown: "PageDown",
  Delete: "DC", Insert: "IC",
};
function onTerminalKeydown(ev) {
  if (TERM.window == null || !TERM.exists) return;
  const k = ev.key;
  // Let browser shortcuts (copy/paste/devtools) through unless it's a control
  // combo we forward to the shell.
  if (ev.metaKey) return;
  if (ev.ctrlKey && k.length === 1 && /[a-z0-9]/i.test(k)) {
    ev.preventDefault();
    sendTerminal({ key: `C-${k.toLowerCase()}` });
    return;
  }
  if (TERM_KEYMAP[k]) { ev.preventDefault(); sendTerminal({ key: TERM_KEYMAP[k] }); return; }
  if (k.length === 1 && !ev.ctrlKey && !ev.altKey) { ev.preventDefault(); sendTerminal({ text: k }); return; }
}

async function pasteTerminal(ev) {
  if (TERM.window == null || !TERM.exists) return;
  const text = (ev.clipboardData || window.clipboardData)?.getData("text");
  if (text) { ev.preventDefault(); sendTerminal({ text }); }
}

// ── sidebar nav (single active panel) ──────────────────────────────────────

function activePanel() {
  const saved = localStorage.getItem(PANEL_KEY);
  return PANELS.includes(saved) ? saved : "remote";
}

function setActivePanel(name) {
  if (!PANELS.includes(name)) name = "remote";
  for (const s of document.querySelectorAll(".panel")) s.hidden = s.dataset.panel !== name;
  for (const b of document.querySelectorAll(".nav-item")) b.classList.toggle("active", b.dataset.panel === name);
  localStorage.setItem(PANEL_KEY, name);
  // The terminal only paints while visible; refresh it the moment it shows.
  if (name === "terminal") { captureTerminal(); $("term-screen")?.focus(); }
}

function setSidebarCollapsed(collapsed) {
  $("sidebar").classList.toggle("collapsed", collapsed);
  $("side-toggle").textContent = collapsed ? "›" : "‹";
  $("side-toggle").title = collapsed ? "expand sidebar" : "collapse sidebar";
  localStorage.setItem(COLLAPSE_KEY, collapsed ? "1" : "0");
}

function updateNavBadges(state) {
  const peers = state.remote?.peers || [];
  const online = peers.filter(p => p.online).length;
  $("nav-badge-remote").textContent   = peers.length ? `${online}/${peers.length}` : "";
  $("nav-badge-sessions").textContent = String((state.sessions || []).length || "");
  $("nav-badge-terminal").textContent = state.tmux?.exists ? String((state.tmux.windows || []).length) : "";

  const unread = state.inbox?.unread_count || 0;
  $("nav-badge-mail").textContent = unread ? String(unread) : "";
  document.querySelector('.nav-item[data-panel="mail"]')?.classList.toggle("has-alert", unread > 0);
}

function initSidebar() {
  setSidebarCollapsed(localStorage.getItem(COLLAPSE_KEY) === "1");
  setActivePanel(activePanel());
  for (const b of document.querySelectorAll(".nav-item")) {
    b.addEventListener("click", () => setActivePanel(b.dataset.panel));
  }
  $("side-toggle")?.addEventListener("click", () => {
    setSidebarCollapsed(!$("sidebar").classList.contains("collapsed"));
  });
}

// ── peer add/remove UI ────────────────────────────────────────────────────

function showPeerForm(show) {
  const form = $("peer-add-form");
  if (!form) return;
  form.hidden = !show;
  $("peer-add-error").textContent = "";
  if (show) {
    form.reset();
    form.querySelector('input[name="name"]').focus();
  }
}

async function submitAddPeer(ev) {
  ev.preventDefault();
  const form = ev.target;
  const data = new FormData(form);
  const body = {
    name: (data.get("name") || "").toString().trim(),
    host: (data.get("host") || "").toString().trim(),
  };
  const portRaw = (data.get("port") || "").toString().trim();
  if (portRaw) body.port = Number(portRaw);

  try {
    const r = await fetch("/api/config/peers", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok || !j.ok) {
      $("peer-add-error").textContent = j.error || `error ${r.status}`;
      return;
    }
    showPeerForm(false);
    toast(`added ${body.name}`);
    reload();
  } catch (e) {
    $("peer-add-error").textContent = e.message;
  }
}

async function removePeer(name) {
  if (!name) return;
  if (!confirm(`Remove peer "${name}"?`)) return;
  try {
    const r = await fetch("/api/config/peers/" + encodeURIComponent(name), { method: "DELETE" });
    const j = await r.json().catch(() => ({}));
    if (!r.ok || !j.ok) {
      toast(`remove failed: ${j.error || r.status}`, 3000);
      return;
    }
    toast(`removed ${name}`);
    reload();
  } catch (e) {
    toast(`remove failed: ${e.message}`, 3000);
  }
}

// ── action wiring ─────────────────────────────────────────────────────────

async function runAction(action) {
  try {
    if (action === "refresh") {
      const state = await postAction("/api/refresh");
      render(state);
      toast("refreshed");
    }
  } catch (e) {
    toast("error: " + e.message, 4000);
  }
}

for (const btn of document.querySelectorAll(".btn[data-action]")) {
  btn.addEventListener("click", () => runAction(btn.dataset.action));
}

document.getElementById("remote-add")?.addEventListener("click", () => {
  const form = $("peer-add-form");
  showPeerForm(form.hidden);
});
document.getElementById("peer-add-form")?.addEventListener("submit", submitAddPeer);
document.getElementById("peer-add-cancel")?.addEventListener("click", () => showPeerForm(false));

// ── inbox + compose ───────────────────────────────────────────────────────

function openCompose(prefill = {}) {
  const modal = $("compose-modal");
  const form = $("compose-form");
  form.reset();
  $("compose-error").hidden = true;
  for (const k of ["to", "cc", "bcc", "subject", "body", "reply_to_id"]) {
    if (prefill[k] != null) form.elements[k].value = prefill[k];
  }
  modal.hidden = false;
  form.elements.to.focus();
}

function closeCompose() { $("compose-modal").hidden = true; }

async function inboxAction(id, act) {
  if (!id) return;
  try {
    if (act === "open") {
      window.open(`https://mail.google.com/mail/u/0/#inbox/${encodeURIComponent(id)}`, "_blank", "noopener");
    } else if (act === "summarize") {
      toast("summarizing…");
      const r = await fetch(`/api/inbox/${encodeURIComponent(id)}/summarize`, { method: "POST" });
      const j = await r.json().catch(() => ({}));
      if (!j.ok) return toast("summarize failed: " + (j.error || r.status), 4000);
      toast(j.summary || "(no body)", 8000);
    } else if (act === "archive") {
      const r = await fetch(`/api/inbox/${encodeURIComponent(id)}/mark`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "archive" }),
      });
      const j = await r.json().catch(() => ({}));
      if (!j.ok) return toast("archive failed: " + (j.error || r.status), 4000);
      toast("archived");
      reload();
    } else if (act === "reply") {
      const r = await fetch(`/api/inbox/${encodeURIComponent(id)}`);
      const j = await r.json().catch(() => ({}));
      if (!j.ok) return toast("read failed: " + (j.error || r.status), 4000);
      const m = j.message || {};
      const subj = (m.subject || "").replace(/^(re:\s*)+/i, "");
      openCompose({
        to: m.from || "",
        subject: subj ? `Re: ${subj}` : "Re:",
        body: "",
        reply_to_id: id,
      });
    }
  } catch (e) {
    toast("error: " + e.message, 4000);
  }
}

$("inbox-list")?.addEventListener("click", (ev) => {
  const btn = ev.target.closest("button[data-act]");
  if (!btn) return;
  inboxAction(btn.dataset.id, btn.dataset.act);
});

async function loadInboxSettings() {
  try {
    const r = await fetch("/api/inbox/settings");
    const j = await r.json();
    if (!j.ok) return;
    INBOX_SETTINGS = j;
    const sel = $("compose-snippet");
    const row = $("compose-snippet-row");
    if (sel && row) {
      sel.replaceChildren(el("option", { value: "" }, "-- pick a canned reply --"));
      const keys = Object.keys(j.snippets || {});
      for (const k of keys) sel.appendChild(el("option", { value: k }, k));
      row.hidden = keys.length === 0;
    }
  } catch {}
}

$("compose-snippet")?.addEventListener("change", (ev) => {
  const key = ev.currentTarget.value;
  if (!key) return;
  const body = (INBOX_SETTINGS.snippets || {})[key];
  if (body == null) return;
  const ta = $("compose-form").elements.body;
  ta.value = body;
  ta.focus();
  ev.currentTarget.value = "";
});

async function runInboxSearch(q) {
  if (!q) {
    INBOX_SEARCH_ACTIVE = false;
    $("inbox-search-clear").hidden = true;
    if (LAST_LIVE_INBOX) renderInbox(LAST_LIVE_INBOX);
    return;
  }
  INBOX_SEARCH_ACTIVE = true;
  $("inbox-search-clear").hidden = false;
  try {
    const r = await fetch(`/api/inbox/search?q=${encodeURIComponent(q)}`);
    const j = await r.json();
    if (!j.ok) return toast("search failed: " + (j.error || r.status), 4000);
    renderSearchResults(j);
  } catch (e) {
    toast("search error: " + e.message, 4000);
  }
}

$("inbox-search-form")?.addEventListener("submit", (ev) => {
  ev.preventDefault();
  runInboxSearch($("inbox-search-input").value.trim());
});
$("inbox-search-clear")?.addEventListener("click", () => {
  $("inbox-search-input").value = "";
  runInboxSearch("");
});

$("inbox-compose")?.addEventListener("click", () => openCompose());
$("compose-cancel")?.addEventListener("click", closeCompose);
$("compose-modal")?.addEventListener("click", (ev) => {
  if (ev.target.id === "compose-modal") closeCompose();
});
$("compose-form")?.addEventListener("submit", async (ev) => {
  ev.preventDefault();
  const fd = new FormData(ev.currentTarget);
  const body = {
    to:      fd.get("to"),
    cc:      fd.get("cc") || undefined,
    bcc:     fd.get("bcc") || undefined,
    subject: fd.get("subject"),
    body:    fd.get("body") || "",
    reply_to_id: fd.get("reply_to_id") || undefined,
  };
  const err = $("compose-error");
  err.hidden = true;
  try {
    const r = await fetch("/api/inbox/send", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    const j = await r.json().catch(() => ({}));
    if (!j.ok) { err.textContent = j.error || `error ${r.status}`; err.hidden = false; return; }
    closeCompose();
    toast("sent");
  } catch (e) {
    err.textContent = e.message;
    err.hidden = false;
  }
});

// ── terminal wiring ─────────────────────────────────────────────────────────

$("term-screen")?.addEventListener("keydown", onTerminalKeydown);
$("term-screen")?.addEventListener("paste", pasteTerminal);
$("terminal-new")?.addEventListener("click", async () => {
  try {
    const r = await postAction("/api/tmux/new-window");
    if (!r.ok) return toast("new window failed: " + (r.error || ""), 3000);
    TERM.window = null;            // adopt the freshly created (now active) window
    reload();
  } catch (e) { toast("error: " + e.message, 3000); }
});

initSidebar();

// ── main loop ─────────────────────────────────────────────────────────────

async function reload() {
  try {
    const state = await fetchState();
    render(state);
  } catch (e) {
    console.error(e);
    toast("fetch error: " + e.message, 4000);
  }
}

loadInboxSettings();
reload();
setInterval(reload, REFRESH_MS);

// Faster, lighter poll just for the focused tmux pane so typing feels live
// without dragging the whole /api/state cycle down to 1s.
setInterval(() => { if (!document.hidden && activePanel() === "terminal") captureTerminal(); }, TERM_POLL_MS);

// 1s clock tick so the time looks alive between full reloads
setInterval(() => renderClock(new Date().toISOString()), 1000);
