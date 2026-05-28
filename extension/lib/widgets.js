// Widget registry. Each entry is a self-contained renderer the dashboard
// can place into the grid. Built-ins live here; external widgets (e.g. a
// future klarum-presence extraction shipped as a sibling extension) can
// register themselves by importing this module and calling registerWidget
// before the dashboard rebuilds.
//
// IMPORTANT: extension/prefs.js maintains a parallel BUILTIN_WIDGETS array
// of just (id, title) pairs. Prefs runs in a separate GTK process and can't
// import this St-based module. When adding, renaming, or removing a
// built-in here, mirror the change in prefs.js or the Widgets prefs page
// silently drifts.

import Clutter from "gi://Clutter";
import Pango   from "gi://Pango";
import St      from "gi://St";

import * as fmt from "./format.js";

const REGISTRY = new Map();

export function registerWidget(widget) {
    if (!widget || typeof widget.id !== "string") {
        throw new Error("widget.id (string) is required");
    }
    if (typeof widget.render !== "function") {
        throw new Error(`widget '${widget.id}' must define render(state, opts)`);
    }
    REGISTRY.set(widget.id, {
        id:            widget.id,
        title:         widget.title || widget.id.toUpperCase(),
        tagClass:      widget.tagClass || widget.id,
        defaultWeight: widget.defaultWeight || 1,
        builtIn:       !!widget.builtIn,
        custom:        !!widget.custom,
        render:        widget.render,
    });
    return widget;
}

export function unregisterWidget(id) { REGISTRY.delete(id); }
export function getWidget(id) { return REGISTRY.get(id); }
export function listWidgets() { return Array.from(REGISTRY.values()); }

// Register or update the user-defined custom widgets. Called whenever the
// custom-widgets gsettings key changes. Returns the list of ids that are
// currently registered as custom, so the caller can prune stale layout
// entries.
export function registerCustomWidgets(configs) {
    for (const [id, w] of [...REGISTRY.entries()]) {
        if (w.custom) REGISTRY.delete(id);
    }
    const ids = [];
    for (const c of (Array.isArray(configs) ? configs : [])) {
        if (!c || typeof c.id !== "string") continue;
        const id = c.id;
        registerWidget({
            id,
            title:         (c.name || id).toUpperCase(),
            tagClass:      "custom",
            defaultWeight: 1,
            custom:        true,
            render:        (state) => renderCustom(state, c),
        });
        ids.push(id);
    }
    return ids;
}

// ── shared helpers used by renderers ────────────────────────────────────

export function emptyRow(text) {
    return new St.Label({ text, style_class: "glance-empty", x_expand: true });
}

export function clickableRow(child, onClick) {
    if (!onClick) return child;
    const btn = new St.Button({
        style_class: "glance-row-btn",
        child,
        x_expand: true,
        can_focus: true,
    });
    btn.connect("clicked", () => onClick());
    return btn;
}

// ── REMOTE ──────────────────────────────────────────────────────────────

function renderRemote(state) {
    const remote = state.remote;
    const children = [];
    if (!remote || !remote.peers || !remote.peers.length) {
        children.push(emptyRow("no peers"));
        return { meta: "· no peers", children };
    }
    const online = remote.peers.filter(p => p.online).length;
    for (const p of remote.peers) {
        const row = new St.BoxLayout({
            vertical: true,
            style_class: "glance-peer" + (p.is_self ? " self" : (p.online ? "" : " offline")),
        });
        const head = new St.BoxLayout({ vertical: false, style_class: "glance-peer-head" });
        head.add_child(new St.Widget({ style_class: "glance-peer-dot " + (p.online ? "online" : "offline"), y_align: Clutter.ActorAlign.CENTER }));
        head.add_child(new St.Label({ text: p.hostname + (p.is_self ? " (this)" : ""), style_class: "glance-peer-name", y_align: Clutter.ActorAlign.CENTER }));
        if (p.os)  head.add_child(new St.Label({ text: " " + p.os, style_class: "glance-peer-os", y_align: Clutter.ActorAlign.CENTER }));
        head.add_child(new St.Widget({ x_expand: true }));
        if (p.ip)  head.add_child(new St.Label({ text: p.ip, style_class: "glance-peer-ip", y_align: Clutter.ActorAlign.CENTER }));
        row.add_child(head);
        if (!p.online) {
            row.add_child(new St.Label({ text: "offline · last seen " + fmt.fmtAgo(p.last_seen), style_class: "glance-peer-note" }));
        } else if (!p.snapshot) {
            row.add_child(new St.Label({ text: p.fetch_error ? `presence: ${p.fetch_error}` : "no presence agent", style_class: "glance-peer-note" }));
        } else {
            const s = p.snapshot;
            const claudeRunning = Array.isArray(s.agents)
                ? s.agents.filter(a => a.kind === "claude" && a.state === "running").length
                : 0;
            const stats = `up ${fmt.fmtUptime(s.uptime_s)} · load ${s.load_1m?.toFixed?.(2) ?? "—"} · mem ${s.mem_pct ?? "—"}% · claude ${claudeRunning}`;
            row.add_child(new St.Label({ text: stats, style_class: "glance-peer-note" }));
            if (s.spark_load || s.spark_mem) {
                const sparks = [];
                if (s.spark_load) sparks.push("load " + s.spark_load);
                if (s.spark_mem)  sparks.push("mem "  + s.spark_mem);
                row.add_child(new St.Label({ text: sparks.join("  "), style_class: "glance-peer-spark" }));
            }
            if (s.active_tmux) {
                const t = s.active_tmux;
                const where = t.pane_current_path ? fmt.shortPath(t.pane_current_path) : "";
                const txt = `▸ ${t.session || "tmux"}${where ? ":" + where : ""}` +
                            (t.pane_current_command ? ` · ${t.pane_current_command}` : "");
                row.add_child(new St.Label({ text: txt, style_class: "glance-peer-tmux" }));
            }
            if (Array.isArray(s.agents) && s.agents.length) {
                const labels = s.agents.map(a => {
                    const since = a.since_s ? ` (${fmt.fmtUptime(a.since_s)})` : "";
                    return `${a.kind}:${a.state}${since}`;
                });
                row.add_child(new St.Label({ text: "  " + labels.join("  "), style_class: "glance-peer-agents" }));
            }
            if (s.git && s.git.branch) {
                const dirty = s.git.dirty ? ` +${s.git.dirty}` : "";
                row.add_child(new St.Label({ text: `git ${s.git.repo || ""}/${s.git.branch}${dirty}`, style_class: "glance-peer-git" }));
            }
            if (typeof s.last_input_s === "number") {
                row.add_child(new St.Label({ text: `idle ${fmt.fmtUptime(s.last_input_s)}`, style_class: "glance-peer-idle" }));
            }
        }
        children.push(row);
    }
    return { meta: `· ${online}/${remote.peers.length} online`, children };
}

// ── SESSIONS ────────────────────────────────────────────────────────────

function renderSessions(state) {
    const children = [];
    const mem      = state.memory || { total_kb: 1, available_kb: 0, used_kb: 0 };
    const sessions = state.sessions || [];
    const meta = `· ${fmt.fmtBytes(mem.used_kb)} / ${fmt.fmtBytes(mem.total_kb)} · ${sessions.length} sess`;

    if (!sessions.length) {
        children.push(emptyRow("no claude sessions"));
        return { meta, children };
    }
    for (const s of sessions) {
        const row = new St.BoxLayout({ vertical: true, style_class: "glance-session" + (s.worktree ? " worktree" : "") });
        const head = new St.BoxLayout({ vertical: false, style_class: "glance-session-head" });
        const label = s.cwd_short
            ? (s.project ? `${s.project}  ${s.cwd_short.split("/").slice(-1)[0]}` : s.cwd_short)
            : `pid ${s.pid}`;
        head.add_child(new St.Label({ text: label, style_class: "glance-session-cwd", y_align: Clutter.ActorAlign.CENTER, x_expand: true }));
        head.add_child(new St.Label({ text: fmt.fmtBytes(s.rss_kb), style_class: "glance-session-rss", y_align: Clutter.ActorAlign.CENTER }));
        row.add_child(head);
        const tags = [];
        if (s.worktree)  tags.push("⌥ worktree");
        if (s.subagents) tags.push(`${s.subagents} sub`);
        tags.push(`pid ${s.pid}`);
        row.add_child(new St.Label({ text: tags.join(" · "), style_class: "glance-session-meta" }));
        children.push(row);
    }
    return { meta, children };
}

// ── LINEAR ──────────────────────────────────────────────────────────────

function renderLinear(state, opts) {
    const lin = state.linear || { items: [] };
    const children = [];
    if (!lin.items || !lin.items.length) {
        children.push(emptyRow("nothing assigned"));
        return { meta: `· ${lin.total || 0} open · ${lin.overdue || 0} overdue`, children };
    }
    for (const i of lin.items) {
        const row = new St.BoxLayout({ vertical: false, style_class: "glance-li", x_expand: true, x_align: Clutter.ActorAlign.FILL });
        row.add_child(new St.Label({ text: i.identifier, style_class: "glance-li-id", y_align: Clutter.ActorAlign.CENTER }));
        const pLabel = i.priority >= 1 && i.priority <= 4 ? `P${i.priority}` : "—";
        const pClass = i.priority >= 1 && i.priority <= 4 ? `p${i.priority}` : "p3";
        row.add_child(new St.Label({ text: pLabel, style_class: `glance-li-prio ${pClass}`, y_align: Clutter.ActorAlign.CENTER }));
        row.add_child(new St.Label({ text: i.state_name || "", style_class: "glance-li-state", y_align: Clutter.ActorAlign.CENTER }));
        const dueText = i.due_date ? i.due_date.slice(5) : "";
        row.add_child(new St.Label({ text: dueText, style_class: "glance-li-due " + (i.overdue ? "overdue" : ""), y_align: Clutter.ActorAlign.CENTER }));
        const title = new St.Label({ text: i.title || "", style_class: "glance-li-title", y_align: Clutter.ActorAlign.CENTER, x_expand: true });
        title.clutter_text.ellipsize = Pango.EllipsizeMode.END;
        row.add_child(title);
        children.push(clickableRow(row, () => opts.onOpenUrl && i.url && opts.onOpenUrl(i.url)));
    }
    return { meta: `· ${lin.total} open · ${lin.overdue} overdue`, children };
}

// ── CALENDAR ────────────────────────────────────────────────────────────

function renderCalendar(state) {
    const cal = state.calendar || { events: [] };
    const children = [];
    if (cal.unconfigured) {
        children.push(emptyRow("calendar not configured"));
        return { meta: "", children };
    }
    if (!cal.authed) {
        children.push(emptyRow("not authed"));
        return { meta: "", children };
    }
    if (cal.fetch_failed) {
        children.push(emptyRow("fetch failed"));
        return { meta: "", children };
    }
    if (!cal.events || !cal.events.length) {
        children.push(emptyRow("nothing upcoming"));
        return { meta: "", children };
    }
    const TODAY = fmt.today(), TOMORROW = fmt.tomorrow();
    const byDay = new Map();
    for (const ev of cal.events) {
        const day = ev.start.slice(0, 10);
        if (!byDay.has(day)) byDay.set(day, []);
        byDay.get(day).push(ev);
    }
    for (const [day, evs] of byDay) {
        const label = day === TODAY ? "today" : day === TOMORROW ? "tomorrow" : day;
        children.push(new St.Label({ text: label, style_class: "glance-cal-day" }));
        for (const ev of evs) {
            const row = new St.BoxLayout({ vertical: false, style_class: "glance-cal-event" });
            const time = ev.start.length >= 16 ? ev.start.slice(11, 16) : "all day";
            row.add_child(new St.Label({ text: time, style_class: "glance-cal-time", y_align: Clutter.ActorAlign.CENTER }));
            row.add_child(new St.Label({ text: ev.summary, style_class: "glance-cal-summary", y_align: Clutter.ActorAlign.CENTER, x_expand: true }));
            children.push(row);
        }
    }
    return { meta: `· ${cal.events.length} upcoming`, children };
}

// ── INBOX ───────────────────────────────────────────────────────────────

function shortFrom(from) {
    if (!from) return "?";
    const m = from.match(/^\s*"?([^"<]+?)"?\s*<[^>]+>\s*$/);
    if (m) return m[1].trim();
    return from.trim();
}

function renderInbox(state, opts) {
    const inbox = state.inbox || { items: [] };
    const children = [];
    if (inbox.unconfigured) {
        children.push(emptyRow("gmail not configured"));
        return { meta: "", children };
    }
    if (!inbox.authed) {
        children.push(emptyRow(inbox.fetch_failed ? "fetch failed" : "not authed"));
        return { meta: "", children };
    }
    if (!inbox.items || !inbox.items.length) {
        children.push(emptyRow("inbox zero"));
        return { meta: "· 0 unread", children };
    }
    for (const m of inbox.items) {
        const row = new St.BoxLayout({
            vertical: false,
            style_class: "glance-inbox-row" + (m.is_team ? " team" : ""),
        });
        const from = new St.Label({
            text: shortFrom(m.from),
            style_class: "glance-inbox-from",
            y_align: Clutter.ActorAlign.CENTER,
        });
        from.clutter_text.ellipsize = Pango.EllipsizeMode.END;
        row.add_child(from);
        const subjText = (m.subject || "(no subject)") +
            (m.meeting ? `   · meeting ${fmt.fmtMeetingShort(m.meeting.start)}` : "");
        const subj = new St.Label({
            text: subjText,
            style_class: "glance-inbox-subject" + (m.meeting ? " has-meeting" : ""),
            y_align: Clutter.ActorAlign.CENTER,
            x_expand: true,
        });
        subj.clutter_text.ellipsize = Pango.EllipsizeMode.END;
        row.add_child(subj);
        children.push(clickableRow(row, () => {
            if (opts.onOpenUrl) opts.onOpenUrl(`https://mail.google.com/mail/u/0/#inbox/${m.id}`);
        }));
    }
    const metaSuffix = inbox.important_only ? " important unread" : " unread";
    return { meta: `· ${inbox.unread_count}${metaSuffix}`, children };
}

// ── CUSTOM (user HTTP endpoints) ────────────────────────────────────────

function renderCustom(state, cfg) {
    const all = state.custom || {};
    const slot = all[cfg.id];
    const children = [];
    if (!slot) {
        children.push(emptyRow("loading..."));
        return { meta: "", children };
    }
    if (!slot.ok) {
        children.push(emptyRow(`fetch failed: ${slot.error || "unknown"}`));
        return { meta: "", children };
    }
    const data = slot.data;
    const view = slot.view || cfg.view || "auto";
    const meta = slot.fetched_at ? `· ${slot.fetched_at.slice(11, 16)}` : "";

    if (slot.isText) {
        children.push(makeCodeBlock(String(data ?? "")));
        return { meta, children };
    }

    const chosen = view === "auto" ? autoView(data) : view;
    if (chosen === "kv" && data && typeof data === "object" && !Array.isArray(data)) {
        for (const [k, v] of Object.entries(data)) {
            children.push(makeKvRow(k, v));
        }
        if (!children.length) children.push(emptyRow("no fields"));
    } else if (chosen === "list" && Array.isArray(data)) {
        for (const item of data.slice(0, 50)) {
            children.push(makeListRow(item));
        }
        if (!children.length) children.push(emptyRow("no items"));
        if (data.length > 50) children.push(new St.Label({
            text: `+${data.length - 50} more`,
            style_class: "glance-empty",
        }));
    } else {
        children.push(makeCodeBlock(safeStringify(data)));
    }
    return { meta, children };
}

function autoView(data) {
    if (Array.isArray(data)) return "list";
    if (data && typeof data === "object") return "kv";
    return "raw";
}

function safeStringify(v) {
    try { return JSON.stringify(v, null, 2); } catch { return String(v); }
}

function makeKvRow(key, value) {
    const row = new St.BoxLayout({ vertical: false, style_class: "glance-custom-kv" });
    row.add_child(new St.Label({
        text: String(key),
        style_class: "glance-custom-key",
        y_align: Clutter.ActorAlign.CENTER,
    }));
    const v = (value !== null && typeof value === "object") ? safeStringify(value) : String(value);
    const label = new St.Label({
        text: v,
        style_class: "glance-custom-val",
        y_align: Clutter.ActorAlign.CENTER,
        x_expand: true,
    });
    label.clutter_text.ellipsize = Pango.EllipsizeMode.END;
    row.add_child(label);
    return row;
}

function makeListRow(item) {
    let text;
    if (item === null || item === undefined) text = String(item);
    else if (typeof item === "object") text = safeStringify(item);
    else text = String(item);
    const label = new St.Label({
        text,
        style_class: "glance-custom-list",
        x_expand: true,
    });
    label.clutter_text.ellipsize = Pango.EllipsizeMode.END;
    return label;
}

function makeCodeBlock(text) {
    const label = new St.Label({
        text: text.length > 4000 ? text.slice(0, 4000) + "\n..." : text,
        style_class: "glance-custom-raw",
        x_expand: true,
    });
    label.clutter_text.line_wrap = true;
    return label;
}

// ── built-in registrations ──────────────────────────────────────────────

registerWidget({ id: "remote",   title: "REMOTE",   tagClass: "remote",   defaultWeight: 1, builtIn: true, render: renderRemote   });
registerWidget({ id: "sessions", title: "SESSIONS", tagClass: "sessions", defaultWeight: 1, builtIn: true, render: renderSessions });
registerWidget({ id: "linear",   title: "LINEAR",   tagClass: "linear",   defaultWeight: 2, builtIn: true, render: renderLinear   });
registerWidget({ id: "calendar", title: "CALENDAR", tagClass: "calendar", defaultWeight: 1, builtIn: true, render: renderCalendar });
registerWidget({ id: "inbox",    title: "INBOX",    tagClass: "inbox",    defaultWeight: 2, builtIn: true, render: renderInbox    });

// Parse a JSON layout string, drop entries pointing at unknown widgets, and
// append any registered widgets the saved layout doesn't mention (so a newly
// installed widget appears automatically, disabled by default).
export function parseLayout(json) {
    let raw;
    try { raw = JSON.parse(json || "[]"); } catch { raw = []; }
    if (!Array.isArray(raw)) raw = [];

    const seen = new Set();
    const out = [];
    for (const e of raw) {
        if (!e || typeof e.id !== "string") continue;
        if (!REGISTRY.has(e.id)) continue;
        if (seen.has(e.id)) continue;
        seen.add(e.id);
        out.push({
            id: e.id,
            enabled: e.enabled !== false,
            weight: Number.isFinite(e.weight) ? Math.max(1, Math.min(8, Math.round(e.weight))) : (REGISTRY.get(e.id).defaultWeight || 1),
        });
    }
    for (const w of REGISTRY.values()) {
        if (seen.has(w.id)) continue;
        out.push({ id: w.id, enabled: false, weight: w.defaultWeight || 1 });
    }
    return out;
}

export function serializeLayout(layout) {
    return JSON.stringify(layout.map(e => ({ id: e.id, enabled: !!e.enabled, weight: e.weight || 1 })));
}
