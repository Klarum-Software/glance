// Render the dashboard state into a parent St.BoxLayout (vertical).
// Layout: [ topbar ]  [ 4-column body ]

import Clutter from "gi://Clutter";
import St      from "gi://St";

import * as fmt from "./format.js";

export function renderDashboard(parent, state, opts = {}) {
    parent.destroy_all_children();

    parent.add_child(makeTopbar(state));

    const body = new St.BoxLayout({
        orientation: Clutter.Orientation.HORIZONTAL,
        style_class: "glance-body",
        x_expand: true,
        y_expand: true,
    });

    body.add_child(makeColumn("REMOTE",   "remote",   renderRemote(state.remote)));
    body.add_child(makeColumn("SESSIONS", "sessions", renderSessions(state)));
    body.add_child(makeColumn("LINEAR",   "linear",   renderLinear(state.linear || { items: [] }, opts)));
    body.add_child(makeColumn("CALENDAR", "calendar", renderCalendar(state.calendar || { events: [] })));

    parent.add_child(body);
}

// ── topbar ──────────────────────────────────────────────────────────────

function makeTopbar(state) {
    const bar = new St.BoxLayout({
        orientation: Clutter.Orientation.HORIZONTAL,
        style_class: "glance-topbar",
        x_expand: true,
    });

    const brand = new St.BoxLayout({ orientation: Clutter.Orientation.HORIZONTAL, style_class: "glance-brand" });
    brand.add_child(new St.Widget({ style_class: "glance-brand-dot", y_align: Clutter.ActorAlign.CENTER }));
    brand.add_child(new St.Label({ text: "klarum glance", style_class: "glance-brand-name", y_align: Clutter.ActorAlign.CENTER }));
    brand.add_child(new St.Label({ text: fmt.fmtClock(state.now), style_class: "glance-brand-time", y_align: Clutter.ActorAlign.CENTER }));
    bar.add_child(brand);

    const spacer = new St.Widget({ x_expand: true });
    bar.add_child(spacer);

    const svcs = new St.BoxLayout({ orientation: Clutter.Orientation.HORIZONTAL, style_class: "glance-services" });
    for (const [name, status] of Object.entries(state.services || {})) {
        const cls = "glance-svc " + (status === "active" ? "active" : "inactive");
        const item = new St.BoxLayout({ orientation: Clutter.Orientation.HORIZONTAL, style_class: cls });
        item.add_child(new St.Widget({ style_class: "glance-svc-dot", y_align: Clutter.ActorAlign.CENTER }));
        item.add_child(new St.Label({ text: name, y_align: Clutter.ActorAlign.CENTER }));
        svcs.add_child(item);
    }
    bar.add_child(svcs);

    return bar;
}

// ── helpers ─────────────────────────────────────────────────────────────

function makeColumn(label, tagClass, content) {
    const col = new St.BoxLayout({
        orientation: Clutter.Orientation.VERTICAL,
        style_class: "glance-col",
        x_expand: true,
        y_expand: true,
    });

    const head = new St.BoxLayout({ orientation: Clutter.Orientation.HORIZONTAL, style_class: "glance-col-head" });
    head.add_child(new St.Label({ text: label, style_class: `glance-col-tag tag-${tagClass}` }));
    if (content.meta) head.add_child(new St.Label({ text: " " + content.meta, style_class: "glance-col-meta" }));
    col.add_child(head);

    const scroll = new St.ScrollView({
        style_class: "glance-col-scroll",
        x_expand: true,
        y_expand: true,
        hscrollbar_policy: St.PolicyType.NEVER,
        vscrollbar_policy: St.PolicyType.AUTOMATIC,
    });
    const inner = new St.BoxLayout({ orientation: Clutter.Orientation.VERTICAL, style_class: "glance-col-body", x_expand: true });
    for (const child of content.children) inner.add_child(child);
    scroll.add_actor ? scroll.add_actor(inner) : scroll.set_child(inner);
    col.add_child(scroll);

    return col;
}

function emptyRow(text) {
    return new St.Label({ text, style_class: "glance-empty", x_expand: true });
}

function clickableRow(child, onClick) {
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

function renderRemote(remote) {
    const children = [];
    if (!remote || !remote.peers || !remote.peers.length) {
        children.push(emptyRow("no peers"));
        return { meta: "· no peers", children };
    }
    const online = remote.peers.filter(p => p.online).length;
    for (const p of remote.peers) {
        const row = new St.BoxLayout({ orientation: Clutter.Orientation.VERTICAL, style_class: "glance-peer" + (p.is_self ? " self" : (p.online ? "" : " offline")) });
        const head = new St.BoxLayout({ orientation: Clutter.Orientation.HORIZONTAL, style_class: "glance-peer-head" });
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
        const row = new St.BoxLayout({ orientation: Clutter.Orientation.VERTICAL, style_class: "glance-session" + (s.worktree ? " worktree" : "") });
        const head = new St.BoxLayout({ orientation: Clutter.Orientation.HORIZONTAL, style_class: "glance-session-head" });
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

function renderLinear(lin, opts) {
    const children = [];
    if (!lin.items || !lin.items.length) {
        children.push(emptyRow("nothing assigned"));
        return { meta: `· ${lin.total || 0} open · ${lin.overdue || 0} overdue`, children };
    }
    for (const i of lin.items) {
        const row = new St.BoxLayout({ orientation: Clutter.Orientation.HORIZONTAL, style_class: "glance-li" });
        row.add_child(new St.Label({ text: i.identifier, style_class: "glance-li-id", y_align: Clutter.ActorAlign.CENTER }));
        const pLabel = i.priority >= 1 && i.priority <= 4 ? `P${i.priority}` : "—";
        const pClass = i.priority >= 1 && i.priority <= 4 ? `p${i.priority}` : "p3";
        row.add_child(new St.Label({ text: pLabel, style_class: `glance-li-prio ${pClass}`, y_align: Clutter.ActorAlign.CENTER }));
        row.add_child(new St.Label({ text: i.state_name || "", style_class: "glance-li-state", y_align: Clutter.ActorAlign.CENTER }));
        const dueText = i.due_date ? i.due_date.slice(5) : "";
        row.add_child(new St.Label({ text: dueText, style_class: "glance-li-due " + (i.overdue ? "overdue" : ""), y_align: Clutter.ActorAlign.CENTER }));
        row.add_child(new St.Label({ text: i.title || "", style_class: "glance-li-title", y_align: Clutter.ActorAlign.CENTER, x_expand: true }));
        children.push(clickableRow(row, () => opts.onOpenUrl && i.url && opts.onOpenUrl(i.url)));
    }
    return { meta: `· ${lin.total} open · ${lin.overdue} overdue`, children };
}

// ── CALENDAR ────────────────────────────────────────────────────────────

function renderCalendar(cal) {
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
            const row = new St.BoxLayout({ orientation: Clutter.Orientation.HORIZONTAL, style_class: "glance-cal-event" });
            const time = ev.start.length >= 16 ? ev.start.slice(11, 16) : "all day";
            row.add_child(new St.Label({ text: time, style_class: "glance-cal-time", y_align: Clutter.ActorAlign.CENTER }));
            row.add_child(new St.Label({ text: ev.summary, style_class: "glance-cal-summary", y_align: Clutter.ActorAlign.CENTER, x_expand: true }));
            children.push(row);
        }
    }
    return { meta: `· ${cal.events.length} upcoming`, children };
}
