// Glance preferences — backend connection + dashboard widget layout.

import Adw from "gi://Adw";
import Gtk from "gi://Gtk";
import Gio from "gi://Gio";
import GObject from "gi://GObject";

import { ExtensionPreferences } from "resource:///org/gnome/Shell/Extensions/prefs.js";

// Keep widget metadata in lockstep with extension/lib/widgets.js. Prefs.js
// runs in a separate GTK process, so it can't import the St-based registry —
// we duplicate the small built-in list here.
const BUILTIN_WIDGETS = [
    { id: "remote",   title: "Remote / klarum-presence" },
    { id: "sessions", title: "Claude sessions"          },
    { id: "linear",   title: "Linear queue"             },
    { id: "calendar", title: "Calendar"                 },
];

function parseLayout(json) {
    let raw;
    try { raw = JSON.parse(json || "[]"); } catch { raw = []; }
    if (!Array.isArray(raw)) raw = [];
    const seen = new Set();
    const out = [];
    for (const e of raw) {
        if (!e || typeof e.id !== "string") continue;
        if (!BUILTIN_WIDGETS.some(w => w.id === e.id)) continue;
        if (seen.has(e.id)) continue;
        seen.add(e.id);
        out.push({ id: e.id, enabled: e.enabled !== false, weight: Number.isFinite(e.weight) ? e.weight : 1 });
    }
    for (const w of BUILTIN_WIDGETS) {
        if (!seen.has(w.id)) out.push({ id: w.id, enabled: false, weight: 1 });
    }
    return out;
}

function serializeLayout(layout) {
    return JSON.stringify(layout.map(e => ({ id: e.id, enabled: !!e.enabled, weight: e.weight || 1 })));
}

export default class GlancePrefs extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        const settings = this.getSettings();

        const page = new Adw.PreferencesPage({ title: "General", icon_name: "preferences-system-symbolic" });
        window.add(page);

        const backendGroup = new Adw.PreferencesGroup({ title: "Backend" });
        page.add(backendGroup);

        backendGroup.add(makeSpin(settings, "backend-port",      "HTTP port",         1024, 65535, 1));
        backendGroup.add(makeSpin(settings, "refresh-interval",  "Refresh (seconds)", 5,    600,   1));
        backendGroup.add(makeSwitch(settings, "auto-start-backend", "Auto-start backend",
            "If on, the extension spawns the Node.js backend on enable and stops it on disable."));
        backendGroup.add(makePathRow(settings, "backend-path", "Path to server.js"));

        const uiGroup = new Adw.PreferencesGroup({ title: "Appearance" });
        page.add(uiGroup);
        uiGroup.add(makeSpin(settings, "dropdown-width-pct", "Dropdown width (% of monitor)", 30, 100, 5));

        const widgetPage = new Adw.PreferencesPage({ title: "Widgets", icon_name: "view-grid-symbolic" });
        window.add(widgetPage);
        widgetPage.add(makeWidgetsGroup(settings));

        const popoutPage = new Adw.PreferencesPage({ title: "Pop-out", icon_name: "video-display-symbolic" });
        window.add(popoutPage);
        popoutPage.add(makePopoutGroup(settings));
    }
}

function makeSpin(settings, key, title, min, max, step) {
    const row = new Adw.SpinRow({
        title,
        adjustment: new Gtk.Adjustment({ lower: min, upper: max, step_increment: step }),
    });
    settings.bind(key, row, "value", Gio.SettingsBindFlags.DEFAULT);
    return row;
}

function makeSwitch(settings, key, title, subtitle) {
    const row = new Adw.SwitchRow({ title, subtitle });
    settings.bind(key, row, "active", Gio.SettingsBindFlags.DEFAULT);
    return row;
}

function makePathRow(settings, key, title) {
    const row = new Adw.EntryRow({ title });
    settings.bind(key, row, "text", Gio.SettingsBindFlags.DEFAULT);
    return row;
}

// ── widget management group ─────────────────────────────────────────────

function makeWidgetsGroup(settings) {
    const group = new Adw.PreferencesGroup({
        title: "Layout",
        description: "Toggle, reorder, and resize dashboard widgets. Changes apply immediately.",
    });

    const rowsBox = new Gtk.Box({
        orientation: Gtk.Orientation.VERTICAL,
        spacing: 0,
    });

    const rebuild = () => {
        let child = rowsBox.get_first_child();
        while (child) {
            const next = child.get_next_sibling();
            rowsBox.remove(child);
            child = next;
        }
        const layout = parseLayout(settings.get_string("widget-layout"));
        layout.forEach((entry, idx) => {
            const meta = BUILTIN_WIDGETS.find(w => w.id === entry.id) || { id: entry.id, title: entry.id };
            rowsBox.append(makeWidgetRow({
                entry, meta,
                isFirst: idx === 0,
                isLast:  idx === layout.length - 1,
                onChange: (mutate) => {
                    const next = parseLayout(settings.get_string("widget-layout"));
                    const target = next.find(e => e.id === entry.id);
                    if (target) mutate(target, next);
                    settings.set_string("widget-layout", serializeLayout(next));
                    rebuild();
                },
                onSwap: (delta) => {
                    const next = parseLayout(settings.get_string("widget-layout"));
                    const i = next.findIndex(e => e.id === entry.id);
                    const j = i + delta;
                    if (i < 0 || j < 0 || j >= next.length) return;
                    const tmp = next[i]; next[i] = next[j]; next[j] = tmp;
                    settings.set_string("widget-layout", serializeLayout(next));
                    rebuild();
                },
            }));
        });
    };

    rebuild();
    settings.connect("changed::widget-layout", rebuild);

    const wrapper = new Adw.PreferencesRow({ activatable: false, focusable: false });
    wrapper.set_child(rowsBox);
    group.add(wrapper);

    return group;
}

function makeWidgetRow({ entry, meta, isFirst, isLast, onChange, onSwap }) {
    const row = new Gtk.Box({
        orientation: Gtk.Orientation.HORIZONTAL,
        spacing: 12,
        margin_top: 6,
        margin_bottom: 6,
        margin_start: 12,
        margin_end: 12,
    });

    const titleBox = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL, hexpand: true });
    titleBox.append(new Gtk.Label({ label: meta.title, xalign: 0, css_classes: ["title"] }));
    titleBox.append(new Gtk.Label({ label: entry.id, xalign: 0, css_classes: ["dim-label", "caption"] }));
    row.append(titleBox);

    const weightLabel = new Gtk.Label({ label: `weight ${entry.weight}`, css_classes: ["dim-label"] });
    row.append(weightLabel);

    const up = new Gtk.Button({ icon_name: "go-up-symbolic", sensitive: !isFirst, tooltip_text: "Move up" });
    up.connect("clicked", () => onSwap(-1));
    row.append(up);

    const down = new Gtk.Button({ icon_name: "go-down-symbolic", sensitive: !isLast, tooltip_text: "Move down" });
    down.connect("clicked", () => onSwap(+1));
    row.append(down);

    const shrink = new Gtk.Button({ icon_name: "list-remove-symbolic", tooltip_text: "Shrink" });
    shrink.connect("clicked", () => onChange(t => { t.weight = Math.max(1, (t.weight || 1) - 1); }));
    row.append(shrink);

    const grow = new Gtk.Button({ icon_name: "list-add-symbolic", tooltip_text: "Grow" });
    grow.connect("clicked", () => onChange(t => { t.weight = Math.min(8, (t.weight || 1) + 1); }));
    row.append(grow);

    const toggle = new Gtk.Switch({ active: entry.enabled, valign: Gtk.Align.CENTER });
    toggle.connect("notify::active", () => onChange(t => { t.enabled = toggle.active; }));
    row.append(toggle);

    return row;
}

// ── pop-out controls ────────────────────────────────────────────────────

function makePopoutGroup(settings) {
    const group = new Adw.PreferencesGroup({
        title: "Standalone window",
        description: "Open the dashboard as a draggable, resizable window. Position and size are remembered.",
    });

    const openRow = new Adw.ActionRow({
        title: "Show pop-out window",
        subtitle: "Mirrors the dropdown dashboard. Toggle off to close.",
    });
    const openSwitch = new Gtk.Switch({ valign: Gtk.Align.CENTER });
    settings.bind("popout-active", openSwitch, "active", Gio.SettingsBindFlags.DEFAULT);
    openRow.add_suffix(openSwitch);
    openRow.set_activatable_widget(openSwitch);
    group.add(openRow);

    group.add(makeSpin(settings, "popout-width",  "Width (px)",  400, 4096, 10));
    group.add(makeSpin(settings, "popout-height", "Height (px)", 240, 4096, 10));

    return group;
}
