// Widget registry. Each entry is a self-contained renderer the dashboard
// can place into the grid. Built-ins live here; external widgets (e.g. a
// future klarum-presence extraction shipped as a sibling extension) can
// register themselves by importing this module and calling registerWidget
// before the dashboard rebuilds.

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
        render:        widget.render,
    });
    return widget;
}

export function getWidget(id) { return REGISTRY.get(id); }
export function listWidgets() { return Array.from(REGISTRY.values()); }

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
            const stats = `up ${fmt.fmtUptime(s.uptime_s)} · load ${s.load_1m?.toFixed?.(2) ?? "—"} · mem ${s.mem_pct ?? "—"}% · claude ${s.claude_procs || 0}`;
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
        const row = new St.BoxLayout({ vertical: false, style_class: "glance-li", x_expand: true });
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

// ── built-in registrations ──────────────────────────────────────────────

registerWidget({ id: "remote",   title: "REMOTE",   tagClass: "remote",   defaultWeight: 1, builtIn: true, render: renderRemote   });
registerWidget({ id: "sessions", title: "SESSIONS", tagClass: "sessions", defaultWeight: 1, builtIn: true, render: renderSessions });
registerWidget({ id: "linear",   title: "LINEAR",   tagClass: "linear",   defaultWeight: 2, builtIn: true, render: renderLinear   });
registerWidget({ id: "calendar", title: "CALENDAR", tagClass: "calendar", defaultWeight: 1, builtIn: true, render: renderCalendar });

export const DEFAULT_LAYOUT = [
    { id: "remote",   enabled: true, weight: 1 },
    { id: "sessions", enabled: true, weight: 1 },
    { id: "linear",   enabled: true, weight: 2 },
    { id: "calendar", enabled: true, weight: 1 },
];

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
