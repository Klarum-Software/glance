// Dashboard renderer. The orchestrator: paints the topbar, then iterates the
// configured widget layout and asks each widget to produce its column body.
// Widget renderers themselves live in widgets.js.

import Clutter from "gi://Clutter";
import St      from "gi://St";

import * as fmt   from "./format.js";
import { getWidget, parseLayout, serializeLayout } from "./widgets.js";

export function renderDashboard(parent, state, opts = {}) {
    parent.destroy_all_children();

    const layout = parseLayout(opts.layoutJson);
    parent.add_child(makeTopbar(state, opts));

    const body = new St.BoxLayout({
        vertical: false,
        style_class: "glance-body",
        x_expand: true,
        y_expand: true,
    });

    const visible = layout.filter(e => e.enabled);
    if (!visible.length) {
        body.add_child(new St.Label({
            text: opts.editMode
                ? "no widgets enabled — use the prefs or the + menu to add some"
                : "no widgets enabled",
            style_class: "glance-empty",
            x_expand: true,
        }));
    } else {
        const movableIds = visible.map(e => e.id);
        visible.forEach((entry, idx) => {
            const w = getWidget(entry.id);
            if (!w) return;
            const content = w.render(state, opts);
            const col = makeColumn({
                widget:   w,
                entry,
                content,
                editMode: !!opts.editMode,
                isFirst:  idx === 0,
                isLast:   idx === visible.length - 1,
                onMove:   opts.onMoveWidget,
                onResize: opts.onResizeWidget,
                onHide:   opts.onHideWidget,
            });
            body.add_child(col);
        });
    }

    parent.add_child(body);
}

// ── topbar ──────────────────────────────────────────────────────────────

function makeTopbar(state, opts) {
    const bar = new St.BoxLayout({
        vertical: false,
        style_class: "glance-topbar",
        x_expand: true,
    });

    const brand = new St.BoxLayout({ vertical: false, style_class: "glance-brand" });
    brand.add_child(new St.Widget({ style_class: "glance-brand-dot", y_align: Clutter.ActorAlign.CENTER }));
    brand.add_child(new St.Label({ text: "klarum glance", style_class: "glance-brand-name", y_align: Clutter.ActorAlign.CENTER }));
    brand.add_child(new St.Label({ text: fmt.fmtClock(state.now), style_class: "glance-brand-time", y_align: Clutter.ActorAlign.CENTER }));
    bar.add_child(brand);

    const spacer = new St.Widget({ x_expand: true });
    bar.add_child(spacer);

    const svcs = new St.BoxLayout({ vertical: false, style_class: "glance-services" });
    for (const [name, status] of Object.entries(state.services || {})) {
        const cls = "glance-svc " + (status === "active" ? "active" : "inactive");
        const item = new St.BoxLayout({ vertical: false, style_class: cls });
        item.add_child(new St.Widget({ style_class: "glance-svc-dot", y_align: Clutter.ActorAlign.CENTER }));
        item.add_child(new St.Label({ text: name, y_align: Clutter.ActorAlign.CENTER }));
        svcs.add_child(item);
    }
    bar.add_child(svcs);

    const tools = new St.BoxLayout({ vertical: false, style_class: "glance-tools" });
    tools.add_child(makeIconButton(opts.editMode ? "✓" : "⚙",
        opts.editMode ? "exit edit mode" : "edit layout",
        () => opts.onToggleEdit && opts.onToggleEdit()));
    if (opts.onPopOut) {
        tools.add_child(makeIconButton("⇱", "open in standalone window", () => opts.onPopOut()));
    }
    if (opts.onClosePopOut) {
        tools.add_child(makeIconButton("✕", "close standalone window", () => opts.onClosePopOut()));
    }
    bar.add_child(tools);

    return bar;
}

function makeIconButton(label, tooltip, onClick) {
    const btn = new St.Button({
        label,
        style_class: "glance-tool-btn",
        can_focus: true,
    });
    if (tooltip) btn.set_accessible_name(tooltip);
    btn.connect("clicked", () => onClick && onClick());
    return btn;
}

// ── column ──────────────────────────────────────────────────────────────

function makeColumn({ widget, entry, content, editMode, isFirst, isLast, onMove, onResize, onHide }) {
    const col = new St.BoxLayout({
        vertical: true,
        style_class: "glance-col" + (editMode ? " edit" : ""),
        x_expand: true,
        y_expand: true,
    });
    // We use min-width to encode the weight in CSS-friendly units. Higher
    // weights claim more space inside the flex row.
    const baseMin = 180;
    col.set_style(`min-width: ${baseMin * (entry.weight || 1)}px;`);

    const head = new St.BoxLayout({ vertical: false, style_class: "glance-col-head" });
    head.add_child(new St.Label({ text: widget.title, style_class: `glance-col-tag tag-${widget.tagClass}` }));
    if (content.meta) head.add_child(new St.Label({ text: " " + content.meta, style_class: "glance-col-meta" }));
    head.add_child(new St.Widget({ x_expand: true }));

    if (editMode) {
        const ctrl = new St.BoxLayout({ vertical: false, style_class: "glance-col-ctrl" });
        ctrl.add_child(makeIconButton("◀",  "move left",  () => !isFirst && onMove && onMove(entry.id, -1)));
        ctrl.add_child(makeIconButton("▶",  "move right", () => !isLast  && onMove && onMove(entry.id, +1)));
        ctrl.add_child(makeIconButton("−",  "shrink",     () => onResize && onResize(entry.id, -1)));
        ctrl.add_child(makeIconButton("+",  "grow",       () => onResize && onResize(entry.id, +1)));
        ctrl.add_child(makeIconButton("✕",  "hide widget", () => onHide   && onHide(entry.id)));
        head.add_child(ctrl);
    }
    col.add_child(head);

    const scroll = new St.ScrollView({
        style_class: "glance-col-scroll",
        x_expand: true,
        y_expand: true,
        hscrollbar_policy: St.PolicyType.NEVER,
        vscrollbar_policy: St.PolicyType.AUTOMATIC,
    });
    const inner = new St.BoxLayout({ vertical: true, style_class: "glance-col-body", x_expand: true });
    for (const child of content.children) inner.add_child(child);
    if (scroll.set_child) scroll.set_child(inner);
    else scroll.add_actor(inner);
    col.add_child(scroll);

    return col;
}

// ── layout mutation helpers ─────────────────────────────────────────────
// Pure functions over the layout array — extension.js calls these in
// response to edit-mode button clicks, then persists the result.

export function moveWidget(layout, id, direction) {
    const out = parseLayout(serializeLayout(layout));
    const enabledIds = out.filter(e => e.enabled).map(e => e.id);
    const idx = enabledIds.indexOf(id);
    const target = idx + direction;
    if (idx < 0 || target < 0 || target >= enabledIds.length) return out;
    const otherId = enabledIds[target];

    const a = out.findIndex(e => e.id === id);
    const b = out.findIndex(e => e.id === otherId);
    const swap = out[a]; out[a] = out[b]; out[b] = swap;
    return out;
}

export function resizeWidget(layout, id, delta) {
    const out = parseLayout(serializeLayout(layout));
    const e = out.find(x => x.id === id);
    if (!e) return out;
    e.weight = Math.max(1, Math.min(8, (e.weight || 1) + delta));
    return out;
}

export function setWidgetEnabled(layout, id, enabled) {
    const out = parseLayout(serializeLayout(layout));
    const e = out.find(x => x.id === id);
    if (e) e.enabled = !!enabled;
    return out;
}
