// glance-ui client. Vanilla JS, no build step. Polls /api/state every 30s
// and re-renders. Buttons POST to action endpoints.

const REFRESH_MS = 30_000;
const TODAY      = new Date().toISOString().slice(0, 10);
const TOMORROW   = (() => { const d = new Date(); d.setDate(d.getDate() + 1); return d.toISOString().slice(0, 10); })();

const GUTTER_PX     = 6;
const COL_MIN_PX    = 160;
const COL_WIDTH_KEY = (name) => `glance.colwidth.${name}`;
// Default fr values. Tuned to match the wider, more balanced original
// glance-ui layout (see Screenshot 2 in the v0.1.0 handoff notes).
const COL_DEFAULTS = {
  remote:   3.4,
  sessions: 1.9,
  linear:   2.7,
  calendar: 1.6,
  inbox:    2.4,
};

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
function fmtIdle(s) {
  if (s == null) return "";
  if (s < 60) return "active";
  if (s < 3600) return `${Math.floor(s / 60)}m idle`;
  if (s < 86400) return `${Math.floor(s / 3600)}h idle`;
  return `${Math.floor(s / 86400)}d idle`;
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

  const cls = "peer-row" + (p.is_manual ? " manual" : "");

  if (!p.online) {
    return el("div", { class: cls + " offline" }, head,
      el("div", { class: "peer-note" }, p.is_manual && p.fetch_error
        ? `unreachable · ${p.fetch_error}`
        : "offline · last seen " + fmtAgo(p.last_seen)),
      removeBtn,
    );
  }
  if (!p.snapshot) {
    return el("div", { class: cls + " stale" }, head,
      el("div", { class: "peer-note" },
        p.fetch_error ? `presence agent: ${p.fetch_error}` : "no presence agent on :5176"),
      removeBtn,
    );
  }
  const s = p.snapshot;
  const sessions = s.tmux_sessions || [];
  const sessTxt = sessions.length
    ? sessions.map(t => `${t.name}·${t.windows}w${t.attached ? "·atch" : ""}·${fmtIdle(t.idle_s)}`).join(" / ")
    : "no tmux";
  const topCpu = s.top_cpu ? `${s.top_cpu.name} ${Math.round(s.top_cpu.pct)}%` : "—";
  const topMem = s.top_mem ? `${s.top_mem.name} ${Math.round(s.top_mem.pct)}%` : "—";

  return el("div", { class: cls + (p.is_self ? " self" : "") },
    head,
    el("div", { class: "peer-grid" },
      el("div", { class: "peer-cell" },
        el("span", { class: "peer-key" }, "user"),
        el("span", { class: "peer-val" }, `${s.user} · up ${fmtUptime(s.uptime_s)}`),
      ),
      el("div", { class: "peer-cell" },
        el("span", { class: "peer-key" }, "load"),
        el("span", { class: "peer-val" }, `${s.load_1m.toFixed(2)} · mem ${s.mem_pct}%`),
      ),
      el("div", { class: "peer-cell wide" },
        el("span", { class: "peer-key" }, "tmux"),
        el("span", { class: "peer-val" }, sessTxt),
      ),
      el("div", { class: "peer-cell" },
        el("span", { class: "peer-key" }, "top"),
        el("span", { class: "peer-val" }, `${topCpu} cpu / ${topMem} mem`),
      ),
      el("div", { class: "peer-cell" },
        el("span", { class: "peer-key" }, "claude"),
        el("span", { class: "peer-val claude-procs" }, `${s.claude_procs || 0} running`),
      ),
    ),
    removeBtn,
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
    const label = s.cwd_short
      ? (s.project ? `${s.project}  ${s.cwd_short.split("/").slice(-1)[0]}` : s.cwd_short)
      : `pid ${s.pid}`;
    const tags = [];
    if (s.worktree)    tags.push(el("span", { class: "session-tag wt"  }, "⌥ worktree"));
    if (s.subagents)   tags.push(el("span", { class: "session-tag sub" }, `${s.subagents} sub`));
    tags.push(el("span", { class: "session-tag" }, `pid ${s.pid}`));

    list.appendChild(
      el("div", { class: "session-row" + (s.worktree ? " worktree" : "") },
        el("div", { class: "session-head" },
          el("span", { class: "session-swatch" + (i % 2 === 1 ? " alt" : "") }),
          el("span", { class: "session-cwd", title: s.cwd || "" }, label),
          el("span", { class: "session-rss" }, fmtBytes(s.rss_kb)),
        ),
        el("div", { class: "session-meta" }, ...tags),
      )
    );
  });

  // legend: other + free
  list.appendChild(
    el("div", { class: "session-row legend" },
      el("div", { class: "session-head" },
        el("span", { class: "session-swatch other" }),
        el("span", { class: "session-cwd" }, "other processes"),
        el("span", { class: "session-rss" }, fmtBytes(otherKb)),
      ),
    )
  );
  list.appendChild(
    el("div", { class: "session-row legend" },
      el("div", { class: "session-head" },
        el("span", { class: "session-swatch free" }),
        el("span", { class: "session-cwd" }, "free"),
        el("span", { class: "session-rss" }, fmtBytes(freeKb)),
      ),
    )
  );
}

function renderLinear(lin) {
  const list = $("linear-list");
  list.replaceChildren();
  $("linear-meta").textContent = `· ${lin.total} open · ${lin.overdue} overdue`;
  if (!lin.items.length) {
    list.appendChild(el("li", { class: "empty" }, "nothing assigned"));
    return;
  }
  for (const i of lin.items) {
    const pClass = i.priority >= 1 && i.priority <= 4 ? `p${i.priority}` : "p3";
    const pLabel = i.priority >= 1 && i.priority <= 4 ? `P${i.priority}` : "—";
    list.appendChild(
      el("li", {
        class: "clickable",
        title: i.title,
        on: { click: () => postAction("/api/open", { url: i.url }).then(() => toast(`opened ${i.identifier}`)) },
      },
        el("span", { class: "li-id" }, i.identifier),
        el("span", { class: "li-prio " + pClass }, pLabel),
        el("span", { class: "li-state" }, i.state_name || ""),
        el("span", { class: "li-due " + (i.overdue ? "overdue" : "") }, i.due_date ? i.due_date.slice(5) : ""),
        el("span", { class: "li-title" }, i.title || ""),
      )
    );
  }
}

function renderCalendar(cal) {
  const list = $("calendar-list");
  list.replaceChildren();
  if (!cal.authed) {
    list.appendChild(el("li", { class: "empty" }, "not authed — run: node lib/calendar.js auth"));
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
    $("inbox-meta").textContent = "· 0 unread";
    return;
  }
  $("inbox-meta").textContent = `· ${inbox.unread_count} unread`;
  for (const m of inbox.items) {
    const row = el("li", { class: "inbox-row", title: m.from || "" },
      el("span", { class: "inbox-from" }, shortFrom(m.from)),
      el("span", { class: "inbox-subject" }, m.subject || "(no subject)"),
      el("span", { class: "inbox-actions" },
        el("button", { class: "btn btn-xs", "data-act": "open", "data-id": m.id }, "open"),
        el("button", { class: "btn btn-xs", "data-act": "summarize", "data-id": m.id }, "summary"),
        el("button", { class: "btn btn-xs", "data-act": "reply", "data-id": m.id }, "reply"),
        el("button", { class: "btn btn-xs", "data-act": "archive", "data-id": m.id }, "archive"),
      ),
    );
    list.appendChild(row);
  }
}

function render(state) {
  renderClock(state.now);
  renderServices(state.services || {});
  renderRemote(state.remote);
  renderSessions(state);
  renderLinear(state.linear);
  renderCalendar(state.calendar);
  renderInbox(state.inbox);
}

// ── resizable columns ─────────────────────────────────────────────────────

function getColEls() {
  return Array.from(document.querySelectorAll(".grid > .col"));
}

function loadColFr(name) {
  const raw = localStorage.getItem(COL_WIDTH_KEY(name));
  if (raw == null) return COL_DEFAULTS[name] ?? 1;
  const n = parseFloat(raw);
  return Number.isFinite(n) && n > 0 ? n : (COL_DEFAULTS[name] ?? 1);
}

function saveColFr(name, fr) {
  localStorage.setItem(COL_WIDTH_KEY(name), String(fr));
}

function applyGridTemplate() {
  const grid = $("grid");
  if (!grid) return;
  const parts = [];
  const children = Array.from(grid.children);
  for (const el of children) {
    if (el.classList.contains("col")) {
      const name = el.dataset.col;
      parts.push(`minmax(${COL_MIN_PX}px, ${loadColFr(name)}fr)`);
    } else if (el.classList.contains("col-gutter")) {
      parts.push(`${GUTTER_PX}px`);
    }
  }
  grid.style.gridTemplateColumns = parts.join(" ");
}

// Drag a gutter: compute the px delta, convert to fr delta using the ratio
// of total fr-units to total fr-track-width, then redistribute between the
// two adjacent columns. Clamps to COL_MIN_PX on both sides.
function startGutterDrag(gutter, startEvent) {
  startEvent.preventDefault();
  const grid = $("grid");
  const left  = gutter.previousElementSibling;
  const right = gutter.nextElementSibling;
  if (!left || !right || !left.classList.contains("col") || !right.classList.contains("col")) return;

  const leftName  = left.dataset.col;
  const rightName = right.dataset.col;
  const startX    = startEvent.clientX;
  const leftFr0   = loadColFr(leftName);
  const rightFr0  = loadColFr(rightName);
  const leftPx0   = left.getBoundingClientRect().width;
  const rightPx0  = right.getBoundingClientRect().width;
  const pxPerFr   = (leftPx0 + rightPx0) / (leftFr0 + rightFr0);

  gutter.classList.add("dragging");
  document.body.classList.add("col-resizing");

  function onMove(ev) {
    let dx = ev.clientX - startX;
    const leftPx  = leftPx0  + dx;
    const rightPx = rightPx0 - dx;
    if (leftPx  < COL_MIN_PX) dx = COL_MIN_PX - leftPx0;
    if (rightPx < COL_MIN_PX) dx = rightPx0 - COL_MIN_PX;
    const dFr = dx / pxPerFr;
    const leftFr  = Math.max(0.05, leftFr0  + dFr);
    const rightFr = Math.max(0.05, rightFr0 - dFr);
    saveColFr(leftName,  leftFr);
    saveColFr(rightName, rightFr);
    applyGridTemplate();
  }
  function onUp() {
    gutter.classList.remove("dragging");
    document.body.classList.remove("col-resizing");
    window.removeEventListener("mousemove", onMove);
    window.removeEventListener("mouseup",   onUp);
  }
  window.addEventListener("mousemove", onMove);
  window.addEventListener("mouseup",   onUp);
}

function initResizableColumns() {
  applyGridTemplate();
  for (const g of document.querySelectorAll(".col-gutter")) {
    g.addEventListener("mousedown", (e) => startGutterDrag(g, e));
    g.addEventListener("dblclick", () => {
      const left  = g.previousElementSibling;
      const right = g.nextElementSibling;
      if (left  && left.classList.contains("col"))  saveColFr(left.dataset.col,  COL_DEFAULTS[left.dataset.col]  ?? 1);
      if (right && right.classList.contains("col")) saveColFr(right.dataset.col, COL_DEFAULTS[right.dataset.col] ?? 1);
      applyGridTemplate();
    });
  }
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
    } else if (action === "sync-linear") {
      toast("syncing linear…");
      const r = await postAction("/api/sync-linear");
      toast(r.ok ? "linear synced" : `sync failed: ${r.error || r.status}`);
      reload();
    } else if (action === "launch-claude") {
      const r = await postAction("/api/launch-claude");
      toast(r.ok ? `claude launched · ${r.cwd}` : `launch failed: ${r.error}`);
      // Give the new process ~1.5s to appear in ps, then refresh sessions.
      setTimeout(reload, 1500);
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

initResizableColumns();

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

reload();
setInterval(reload, REFRESH_MS);

// 1s clock tick so the time looks alive between full reloads
setInterval(() => renderClock(new Date().toISOString()), 1000);
