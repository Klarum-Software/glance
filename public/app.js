// glance-ui client. Vanilla JS, no build step. Polls /api/state every 30s
// and re-renders. Buttons POST to action endpoints.

const REFRESH_MS = 30_000;
const TODAY      = new Date().toISOString().slice(0, 10);
const TOMORROW   = (() => { const d = new Date(); d.setDate(d.getDate() + 1); return d.toISOString().slice(0, 10); })();

const TERM_POLL_MS  = 1200;

const PANELS       = ["remote", "sessions", "terminal", "prod", "mail", "settings"];
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
  meta.textContent = `· ${online}/${r.peers.length} online` + liveSuffix();
  for (const p of r.peers) grid.appendChild(renderPeerRow(p));
}

const PROD_STATUS_CLASS = { succeeded: "ok", failed: "bad", running: "warn", skipped: "skip" };

function fmtDur(s) {
  if (!Number.isFinite(s) || s < 0) return "—";
  if (s < 60)    return `${Math.round(s)}s`;
  if (s < 3600)  return `${Math.floor(s / 60)}m ${Math.round(s % 60)}s`;
  return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`;
}

function renderProdJob(job) {
  const variant = PROD_STATUS_CLASS[job.status] || "skip";
  const badges = [el("span", { class: "tcard-badge" }, "ran " + fmtAgo(job.last_run_at))];
  if (job.last_duration_s != null) badges.push(el("span", { class: "tcard-badge mute" }, "took " + fmtDur(job.last_duration_s)));
  for (const name of job.substeps_failed || []) {
    badges.push(el("span", { class: "tcard-badge bad" }, name + " failed"));
  }
  const bodyKids = [
    el("div", { class: "tcard-head" },
      el("span", { class: "tcard-title" }, job.job_id || "—"),
      el("span", { class: "tcard-value" }, job.status || "—"),
    ),
  ];
  if (job.progress && job.progress.total) {
    bodyKids.push(el("div", { class: "prod-progress" },
      el("div", { class: "prod-progress-track" },
        el("div", { class: "prod-progress-fill", style: `width:${Math.min(100, job.progress.n / job.progress.total * 100).toFixed(1)}%` })),
      el("span", { class: "prod-progress-label" }, `step ${job.progress.n}/${job.progress.total} · ${job.progress.step}`),
    ));
  }
  bodyKids.push(el("div", { class: "tcard-badges" }, ...badges));
  return el("div", { class: "tcard tcard-prod " + variant },
    el("div", { class: "tcard-accent" }),
    el("div", { class: "tcard-body" }, ...bodyKids),
  );
}

function renderHealthCard(h) {
  if (h.pending) {
    return el("div", { class: "tcard tcard-prod skip" },
      el("div", { class: "tcard-accent" }),
      el("div", { class: "tcard-body" },
        el("div", { class: "tcard-head" },
          el("span", { class: "tcard-title" }, h.name),
          el("span", { class: "tcard-value" }, "checking…"))));
  }
  const variant = h.ok ? "ok" : "bad";
  const badges = [];
  if (h.version)     badges.push(el("span", { class: "tcard-badge info" }, "v" + h.version));
  if (h.environment) badges.push(el("span", { class: "tcard-badge mute" }, h.environment));
  if (Number.isFinite(h.latency_ms)) badges.push(el("span", { class: "tcard-badge" }, h.latency_ms + " ms"));
  if (h.uptime_pct != null) {
    badges.push(el("span", { class: "tcard-badge" + (h.uptime_pct < 100 ? " warn" : "") },
      `${h.uptime_pct}% over ${fmtUptime(h.window_s)}`));
  }
  if (h.last_incident) {
    const inc = h.last_incident;
    badges.push(el("span", { class: "tcard-badge warn", title: inc.started_at },
      `last incident ${fmtAgo(inc.started_at)} · ${fmtDur(inc.duration_s)}`));
  }
  const statusTxt = h.ok
    ? "up" + (h.since ? " · " + fmtAgo(h.since).replace(" ago", "") : "")
    : (h.error || `http ${h.status_code}`);
  return el("div", { class: "tcard tcard-prod " + variant },
    el("div", { class: "tcard-accent" }),
    el("div", { class: "tcard-body" },
      el("div", { class: "tcard-head" },
        el("span", { class: "tcard-title", title: h.url }, h.name),
        h.spark_latency ? el("span", { class: "prod-spark", title: "latency, last 32 checks" }, h.spark_latency) : null,
        el("span", { class: "tcard-value" + (h.ok ? "" : " prod-down") }, statusTxt),
      ),
      el("div", { class: "tcard-badges" }, ...badges),
    ),
  );
}

function renderFleetCard(m) {
  const healthy = m.status === "healthy" && !m.stale;
  const variant = m.stale ? "warn" : (m.status === "healthy" ? "ok" : "bad");
  const badges = [el("span", { class: "tcard-badge mute" }, m.service)];
  if (m.uptime_s != null) badges.push(el("span", { class: "tcard-badge" }, "up " + fmtUptime(m.uptime_s)));
  if (m.last_heartbeat)   badges.push(el("span", { class: "tcard-badge" + (m.stale ? " warn" : "") }, "hb " + fmtAgo(m.last_heartbeat)));
  if (m.current_step)     badges.push(el("span", { class: "tcard-badge info" }, m.current_step));
  if (m.last_job && m.last_job.status) {
    badges.push(el("span", { class: "tcard-badge" + (m.last_job.status === "failed" ? " bad" : "") },
      "job " + m.last_job.status));
  }
  return el("div", { class: "tcard tcard-prod " + variant },
    el("div", { class: "tcard-accent" }),
    el("div", { class: "tcard-body" },
      el("div", { class: "tcard-head" },
        el("span", { class: "tcard-title", title: m.machine_id }, m.hostname),
        el("span", { class: "tcard-value" + (healthy ? "" : " prod-down") },
          m.stale ? "stale" : m.status),
      ),
      el("div", { class: "tcard-badges" }, ...badges),
    ),
  );
}

const DEPLOY_STATUS_CLASS = { success: "ok", failure: "bad", deploying: "warn", cancelled: "skip", inactive: "skip" };

function renderDeployCard(d) {
  if (!d.ok) {
    return el("div", { class: "tcard tcard-prod skip" },
      el("div", { class: "tcard-accent" }),
      el("div", { class: "tcard-body" },
        el("div", { class: "tcard-head" },
          el("span", { class: "tcard-title" }, d.name),
          el("span", { class: "tcard-value" }, d.error || "unavailable"))));
  }
  const variant = DEPLOY_STATUS_CLASS[d.status] || "skip";
  const badges = [];
  const ref = d.branch ? d.branch + (d.sha7 ? "@" + d.sha7 : "") : d.sha7;
  if (ref) badges.push(el("span", { class: "tcard-badge mono" }, ref));
  if (d.status === "deploying") {
    badges.push(el("span", { class: "tcard-badge warn" }, "elapsed " + fmtDur(d.elapsed_s)));
    if (d.eta_s != null) badges.push(el("span", { class: "tcard-badge info" }, "~" + fmtDur(d.eta_s) + " left"));
  } else {
    if (d.finished_at)       badges.push(el("span", { class: "tcard-badge" }, fmtAgo(d.finished_at)));
    if (d.duration_s != null) badges.push(el("span", { class: "tcard-badge mute" }, "took " + fmtDur(d.duration_s)));
  }
  const title = d.run_url
    ? el("a", { class: "tcard-title prod-link", href: d.run_url, target: "_blank", rel: "noopener", title: d.title || d.run_url }, d.name)
    : el("span", { class: "tcard-title" }, d.name);
  return el("div", { class: "tcard tcard-prod " + variant },
    el("div", { class: "tcard-accent" }),
    el("div", { class: "tcard-body" },
      el("div", { class: "tcard-head" },
        title,
        el("span", { class: "tcard-value" }, d.status === "deploying" ? "deploying…" : d.status),
      ),
      el("div", { class: "tcard-badges" }, ...badges),
    ),
  );
}

function prodSubhead(label, metaTxt, metaClass) {
  const sub = el("div", { class: "mail-subhead" }, label);
  if (metaTxt) sub.appendChild(el("span", { class: "col-meta" + (metaClass ? " " + metaClass : "") }, "· " + metaTxt));
  return sub;
}

function renderProd(prod) {
  const body = $("prod-body");
  const meta = $("prod-meta");
  body.replaceChildren();

  const targets = prod?.targets || [];
  const health  = prod?.health || [];
  const deploys = prod?.deploys?.targets || [];

  if (!targets.length && !health.length && !deploys.length) {
    meta.textContent = "· no targets";
    body.appendChild(el("div", { class: "remote-empty" },
      el("div", { class: "remote-empty-title" }, "no prod targets configured"),
      el("div", { class: "remote-empty-hint" },
        el("span", {}, "Set ", el("code", {}, "prodHealth"), ", ", el("code", {}, "deployTargets"),
          " or ", el("code", {}, "prodTargets"), " in config.json."),
      ),
    ));
    return;
  }

  let down = 0, failing = 0;

  if (health.length) {
    const up = health.filter(h => h.ok).length;
    down = health.filter(h => h.ok === false).length;
    body.appendChild(prodSubhead("SERVICES", `${up}/${health.length} up`, down ? "prod-down" : ""));
    for (const h of health) body.appendChild(renderHealthCard(h));
  }

  const fleet = prod?.fleet;
  if (fleet) {
    if (fleet.ok) {
      const bad = fleet.machines.filter(m => m.stale || m.status !== "healthy").length;
      body.appendChild(prodSubhead("FLEET", `${fleet.total - bad}/${fleet.total} healthy`, bad ? "prod-down" : ""));
      if (!fleet.machines.length) body.appendChild(el("div", { class: "prod-empty" }, "no heartbeats yet"));
      for (const m of fleet.machines) {
        if (m.stale || m.status !== "healthy") failing++;
        body.appendChild(renderFleetCard(m));
      }
    } else if (fleet.auth_required) {
      body.appendChild(prodSubhead("FLEET", "locked (add the SERVICE_TOKEN to prodFleet.headers)"));
    } else {
      body.appendChild(prodSubhead("FLEET", fleet.error || "unreachable", "prod-down"));
    }
  }

  if (deploys.length) {
    const live = deploys.filter(d => d.ok && d.status === "deploying").length;
    body.appendChild(prodSubhead("DEPLOYMENTS", live ? `${live} in flight` : null));
    for (const d of deploys) {
      if (d.ok && d.status === "failure") failing++;
      body.appendChild(renderDeployCard(d));
    }
  }

  for (const t of targets) {
    const sub = el("div", { class: "mail-subhead" }, "JOBS · " + t.name.toUpperCase());
    if (t.ok) {
      sub.appendChild(el("span", { class: "col-meta" }, "· " + fmtAgo(t.generated_at)));
    } else if (t.auth_required) {
      sub.appendChild(el("span", { class: "col-meta", title: "add an INTERNAL_API_KEY header to this prodTargets entry" }, "· locked (auth required)"));
    } else {
      sub.appendChild(el("span", { class: "col-meta prod-down" }, "· " + (t.error || "unreachable")));
    }
    body.appendChild(sub);

    if (!t.ok) continue;
    const jobs = t.jobs || [];
    if (!jobs.length) {
      body.appendChild(el("div", { class: "prod-empty" }, "no jobs reported"));
      continue;
    }
    for (const job of jobs) {
      if (job.status === "failed") failing++;
      body.appendChild(renderProdJob(job));
    }
  }

  meta.textContent = down
    ? `· ${down} DOWN`
    : failing ? `· ${failing} failing`
    : "· all up";
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
    `· ${fmtBytes(mem.used_kb)} / ${fmtBytes(totalKb)} · ${sessions.length} sess` + liveSuffix();

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
  LAST_STATE = state;
  renderClock(state.now);
  renderServices(state.services || {});
  updateNavBadges(state);
  renderRemote(state.remote);
  renderSessions(state);
  renderProd(state.prod);
  renderTerminalTabs(state.tmux);
  renderCalendar(state.calendar);
  LAST_LIVE_INBOX = state.inbox;
  if (!INBOX_SEARCH_ACTIVE) renderInbox(state.inbox);
}

// ── live events (SSE) ───────────────────────────────────────────────────────
// /api/events pushes sessions / remote / tmux deltas every few seconds; the
// 30s /api/state poll stays as the fallback and covers everything else
// (calendar, inbox, prod). EventSource reconnects on its own after a backend
// restart, so there is no retry plumbing here.

let LAST_STATE = null;
let LIVE = false;

function liveSuffix() {
  return LIVE ? " · live" : "";
}

function initLiveEvents() {
  if (typeof EventSource === "undefined") return;
  const es = new EventSource("/api/events");
  es.addEventListener("open",  () => { LIVE = true; });
  es.addEventListener("error", () => { LIVE = false; });
  es.addEventListener("sessions", (ev) => {
    if (!LAST_STATE) return;
    const d = JSON.parse(ev.data);
    LAST_STATE.sessions = d.sessions;
    LAST_STATE.memory   = d.memory;
    renderSessions(LAST_STATE);
    updateNavBadges(LAST_STATE);
  });
  es.addEventListener("remote", (ev) => {
    if (!LAST_STATE) return;
    LAST_STATE.remote = JSON.parse(ev.data);
    renderRemote(LAST_STATE.remote);
    updateNavBadges(LAST_STATE);
  });
  es.addEventListener("tmux", (ev) => {
    if (!LAST_STATE) return;
    LAST_STATE.tmux = JSON.parse(ev.data);
    renderTerminalTabs(LAST_STATE.tmux);
    updateNavBadges(LAST_STATE);
  });
}

// ── terminal (tmux poll) ───────────────────────────────────────────────────
// Poll-based, no streaming: render the window list as clickable tabs, and on a
// short interval capture the selected window's visible pane and paint it. Key
// presses inside the screen are forwarded to tmux via /api/tmux/send, then we
// re-capture quickly so typing feels responsive.

const TERM = { window: null, exists: false, polling: false, failed: false, lastContent: null };

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
  // Three sources fire this (steady poll, window select, state reload); without
  // an in-flight guard two captures can resolve out of order and repaint stale
  // content over fresh.
  if (TERM.polling) return;
  TERM.polling = true;
  try {
    const r = await fetch(`/api/tmux/capture?window=${TERM.window}`, { cache: "no-store" });
    if (!r.ok) throw new Error(`capture ${r.status}`);
    const j = await r.json();
    if (!j.ok) throw new Error(j.error || "capture failed");
    if (j.window !== TERM.window) return;
    TERM.failed = false;
    // Trim trailing blank lines so the prompt sits at the bottom, not buried.
    const content = (j.content || "").replace(/\n+$/g, "");
    if (content === TERM.lastContent) return;
    TERM.lastContent = content;
    const screen = $("term-screen");
    const atBottom = screen.scrollTop + screen.clientHeight >= screen.scrollHeight - 8;
    screen.innerHTML = ansiToHtml(content);
    if (atBottom) screen.scrollTop = screen.scrollHeight;
  } catch {
    // Toast once on the ok->failed transition, not every poll tick.
    if (!TERM.failed) { TERM.failed = true; toast("terminal capture failed", 2500); }
  } finally {
    TERM.polling = false;
  }
}

async function sendTerminal(payload) {
  if (TERM.window == null || !TERM.exists) return;
  try {
    const r = await fetch("/api/tmux/send", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ window: TERM.window, ...payload }),
    });
    if (!r.ok) throw new Error(`send ${r.status}`);
    // Re-capture quickly for a responsive echo, on top of the steady poll.
    setTimeout(captureTerminal, 60);
  } catch {
    toast("terminal send failed", 2000);
  }
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
  // Settings sections are fetched on demand so they're always fresh when shown.
  if (name === "settings") renderSettingsSection(activeSettingsSection());
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

  const prodTargets = state.prod?.targets || [];
  const prodFailing =
    prodTargets.reduce(
      (n, t) => n + (t.ok ? (t.jobs || []).filter(j => j.status === "failed").length : (t.auth_required ? 0 : 1)), 0)
    + (state.prod?.health || []).filter(h => h.ok === false).length
    + (state.prod?.deploys?.targets || []).filter(d => d.ok && d.status === "failure").length
    + (state.prod?.fleet?.ok ? state.prod.fleet.machines.filter(m => m.stale || m.status !== "healthy").length : 0);
  $("nav-badge-prod").textContent = prodFailing ? String(prodFailing) : "";
  document.querySelector('.nav-item[data-panel="prod"]')?.classList.toggle("has-alert", prodFailing > 0);
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

// ── settings panel ──────────────────────────────────────────────────────────

const SETTINGS_SEC_KEY = "glance.settings.sec";
const SETTINGS_SECS    = ["accounts", "peers", "inbox", "appearance"];

function activeSettingsSection() {
  const s = localStorage.getItem(SETTINGS_SEC_KEY);
  return SETTINGS_SECS.includes(s) ? s : "accounts";
}

function setSettingsSection(sec) {
  if (!SETTINGS_SECS.includes(sec)) sec = "accounts";
  localStorage.setItem(SETTINGS_SEC_KEY, sec);
  renderSettingsSection(sec);
}

function renderSettingsSection(sec) {
  for (const b of document.querySelectorAll(".set-nav-item")) b.classList.toggle("active", b.dataset.sec === sec);
  if (sec === "peers")           renderPeersSection();
  else if (sec === "inbox")      renderInboxSection();
  else if (sec === "appearance") renderAppearanceSection();
  else                           renderAccountsSection();
}

function sectionHead(title, desc) {
  return el("div", { class: "set-section-head" }, el("h3", {}, title), desc ? el("p", {}, desc) : null);
}

function statusPill(on, label) {
  return el("span", { class: "set-pill " + (on ? "on" : "off") }, el("i", {}), label);
}

function googleGlyph() {
  return el("span", { class: "set-row-icon", html:
    '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M12 8v8M8 12h8"/></svg>' });
}

let GOOGLE_BUSY = false;

async function renderAccountsSection() {
  const body = $("settings-body");
  body.replaceChildren(sectionHead("Connected accounts",
    "Connect Google so the CALENDAR and INBOX columns light up. The token stays on this machine, mode 600."));

  let st;
  try { st = await fetch("/api/google/status", { cache: "no-store" }).then(r => r.json()); }
  catch (e) { body.appendChild(el("div", { class: "set-banner" }, "Could not load status: " + e.message)); return; }

  if (!st.client_present) {
    body.appendChild(el("div", { class: "set-banner" },
      "No OAuth client found. Save the client JSON (e.g. klarum-dev) to ",
      el("span", { class: "set-mono" }, "~/.config/glance/google-client.json"),
      ", then reload. See docs/CALENDAR-SETUP.md."));
  }

  const rows = [
    { key: "calendar", title: "Google Calendar", desc: "Upcoming events in the CALENDAR column." },
    { key: "gmail",    title: "Gmail",            desc: "Unread mail, read/reply/send in the INBOX column." },
  ];
  const card = el("div", { class: "set-card" });
  for (const r of rows) {
    const surf = st[r.key] || {};
    const connected = surf.authorized && surf.wired;
    const descTxt = connected ? (st.email ? `Connected as ${st.email}.` : "Connected.")
                  : surf.authorized ? "Authorized, currently off." : r.desc;
    const actions = el("div", { class: "set-row-actions" }, statusPill(connected, connected ? "Connected" : "Off"));
    if (connected) {
      actions.appendChild(el("button", { class: "btn btn-sm btn-danger", on: { click: () => googleDisconnect(r.key) } }, "Disconnect"));
    } else {
      actions.appendChild(el("button", { class: "btn btn-sm btn-accent", on: { click: () => googleConnect(r.key) } },
        surf.authorized ? "Enable" : "Connect"));
    }
    card.appendChild(el("div", { class: "set-row" },
      el("div", { class: "set-row-main" }, googleGlyph(),
        el("div", { class: "set-row-text" },
          el("div", { class: "set-row-title" }, r.title),
          el("div", { class: "set-row-desc" }, descTxt))),
      actions));
  }
  body.appendChild(card);

  if (st.email || st.calendar.authorized || st.gmail.authorized) {
    body.appendChild(el("div", { class: "set-row-actions", style: "margin-top:12px" },
      el("button", { class: "btn btn-sm btn-danger", on: { click: googleRemoveAccount } }, "Remove account")));
  }
  body.appendChild(el("div", { class: "set-foot-note" },
    "Connect opens Google in this tab and returns here. Works from localhost; for a remote instance use ",
    el("span", { class: "set-mono" }, "node server/bin/google-auth.js"), "."));
}

async function googleConnect(target) {
  if (GOOGLE_BUSY) return;
  GOOGLE_BUSY = true;
  try {
    const r = await fetch("/api/google/connect", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ target }),
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok || !j.ok) { toast(j.error || `connect failed (${r.status})`, 6000); return; }
    if (j.mode === "redirect") { window.location.href = j.url; return; }
    toast(target === "calendar" ? "Calendar connected" : "Gmail connected");
    renderAccountsSection();
  } catch (e) { toast("connect failed: " + e.message, 5000); }
  finally { GOOGLE_BUSY = false; }
}

async function googleDisconnect(target) {
  try {
    const r = await fetch("/api/google/disconnect", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ target }),
    });
    const j = await r.json().catch(() => ({}));
    if (!j.ok) { toast(j.error || "disconnect failed", 4000); return; }
    toast("disconnected");
    renderAccountsSection();
  } catch (e) { toast("disconnect failed: " + e.message, 4000); }
}

async function googleRemoveAccount() {
  if (!confirm("Remove the Google account? This deletes the saved token and revokes access.")) return;
  try {
    const r = await fetch("/api/google/remove", { method: "POST" });
    const j = await r.json().catch(() => ({}));
    if (!j.ok) { toast("remove failed", 4000); return; }
    toast("account removed");
    renderAccountsSection();
  } catch (e) { toast("remove failed: " + e.message, 4000); }
}

async function renderPeersSection() {
  const body = $("settings-body");
  body.replaceChildren(sectionHead("Peers",
    "Manually-added tailnet peers, shown in REMOTE alongside auto-discovered ones."));
  let peers = [];
  try { peers = (await fetch("/api/config/peers", { cache: "no-store" }).then(r => r.json())).peers || []; }
  catch (e) { body.appendChild(el("div", { class: "set-banner" }, "Could not load peers: " + e.message)); return; }

  const card = el("div", { class: "set-card" });
  if (!peers.length) card.appendChild(el("div", { class: "set-empty" }, "No manual peers added."));
  for (const p of peers) {
    card.appendChild(el("div", { class: "set-row" },
      el("div", { class: "set-row-main" }, el("div", { class: "set-row-text" },
        el("div", { class: "set-row-title" }, p.name || p.host),
        el("div", { class: "set-row-desc" }, `${p.host}${p.port ? ":" + p.port : ""}`))),
      el("div", { class: "set-row-actions" },
        el("button", { class: "btn btn-sm btn-danger", on: { click: () => settingsRemovePeer(p.name || p.host) } }, "Remove"))));
  }
  body.appendChild(card);
  body.appendChild(el("form", { class: "set-add-form", on: { submit: settingsAddPeer } },
    el("input", { type: "text", name: "name", placeholder: "name", autocomplete: "off", required: "" }),
    el("input", { type: "text", name: "host", placeholder: "host or IP", autocomplete: "off", required: "" }),
    el("input", { type: "number", name: "port", placeholder: "port", min: "1", max: "65535", autocomplete: "off" }),
    el("button", { class: "btn btn-sm", type: "submit" }, "Add peer")));
}

async function settingsAddPeer(ev) {
  ev.preventDefault();
  const data = new FormData(ev.target);
  const body = { name: (data.get("name") || "").toString().trim(), host: (data.get("host") || "").toString().trim() };
  const portRaw = (data.get("port") || "").toString().trim();
  if (portRaw) body.port = Number(portRaw);
  try {
    const r = await fetch("/api/config/peers", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    const j = await r.json().catch(() => ({}));
    if (!r.ok || !j.ok) { toast(j.error || `add failed (${r.status})`, 4000); return; }
    toast(`added ${body.name}`);
    renderPeersSection();
    reload();
  } catch (e) { toast("add failed: " + e.message, 4000); }
}

async function settingsRemovePeer(name) {
  if (!name || !confirm(`Remove peer "${name}"?`)) return;
  try {
    const r = await fetch("/api/config/peers/" + encodeURIComponent(name), { method: "DELETE" });
    const j = await r.json().catch(() => ({}));
    if (!r.ok || !j.ok) { toast(j.error || "remove failed", 4000); return; }
    toast(`removed ${name}`);
    renderPeersSection();
    reload();
  } catch (e) { toast("remove failed: " + e.message, 4000); }
}

async function renderInboxSection() {
  const body = $("settings-body");
  body.replaceChildren(sectionHead("Inbox",
    "How the INBOX column filters mail. Edit these in ~/.config/glance/config.json."));
  let s;
  try { s = await fetch("/api/inbox/settings", { cache: "no-store" }).then(r => r.json()); }
  catch (e) { body.appendChild(el("div", { class: "set-banner" }, "Could not load: " + e.message)); return; }
  const team = s.team_emails || [];
  body.appendChild(el("div", { class: "set-card" },
    el("div", { class: "set-row" }, el("dl", { class: "set-kv" },
      el("dt", {}, "important only"), el("dd", {}, String(!!s.important_only)),
      el("dt", {}, "summarizer"),     el("dd", {}, s.has_summarizer ? "configured" : "built-in heuristic"),
      el("dt", {}, "team emails"),    el("dd", {}, team.length ? team.join(", ") : "none"),
      el("dt", {}, "snippets"),       el("dd", {}, String(Object.keys(s.snippets || {}).length))))));
}

function renderAppearanceSection() {
  const body = $("settings-body");
  body.replaceChildren(sectionHead("Appearance", "Theme and saved dashboard layout state."));
  body.appendChild(el("div", { class: "set-card" },
    el("div", { class: "set-row" },
      el("div", { class: "set-row-main" }, el("div", { class: "set-row-text" },
        el("div", { class: "set-row-title" }, "Theme"),
        el("div", { class: "set-row-desc" }, "Pivi dark. The one built-in theme."))),
      el("div", { class: "set-row-actions" }, statusPill(true, "Active"))),
    el("div", { class: "set-row" },
      el("div", { class: "set-row-main" }, el("div", { class: "set-row-text" },
        el("div", { class: "set-row-title" }, "Reset layout state"),
        el("div", { class: "set-row-desc" }, "Clears saved sidebar collapse and active panel."))),
      el("div", { class: "set-row-actions" },
        el("button", { class: "btn btn-sm", on: { click: () => {
          localStorage.removeItem(COLLAPSE_KEY);
          localStorage.removeItem(PANEL_KEY);
          localStorage.removeItem(SETTINGS_SEC_KEY);
          setSidebarCollapsed(false);
          toast("layout reset");
        } } }, "Reset")))));
}

function initSettings() {
  for (const b of document.querySelectorAll(".set-nav-item")) {
    b.addEventListener("click", () => setSettingsSection(b.dataset.sec));
    b.classList.toggle("active", b.dataset.sec === activeSettingsSection());
  }
}

// After a browser connect round-trip the backend redirects to /?panel=settings
// &connected=1; surface that and clean the URL so a reload doesn't re-toast.
function handleConnectReturn() {
  const q = new URLSearchParams(location.search);
  if (q.get("connected")) toast("Google connected");
  if (q.get("panel") === "settings") setActivePanel("settings");
  if (q.has("connected") || q.has("panel")) history.replaceState(null, "", location.pathname);
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

$("prod-refresh")?.addEventListener("click", () => reload());

initSidebar();
initSettings();
handleConnectReturn();
initLiveEvents();

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
// Skip the full /api/state cycle while the tab is backgrounded (it shells out
// to tailscale/tmux/gmail); refresh immediately when it comes back so the data
// isn't stale on return.
setInterval(() => { if (!document.hidden) reload(); }, REFRESH_MS);
document.addEventListener("visibilitychange", () => { if (!document.hidden) reload(); });

// Faster, lighter poll just for the focused tmux pane so typing feels live
// without dragging the whole /api/state cycle down to 1s.
setInterval(() => { if (!document.hidden && activePanel() === "terminal") captureTerminal(); }, TERM_POLL_MS);

// 1s clock tick so the time looks alive between full reloads
setInterval(() => renderClock(new Date().toISOString()), 1000);
