// Glance preferences — backend connection + dashboard widget layout.

import Adw from "gi://Adw";
import Gtk from "gi://Gtk";
import Gio from "gi://Gio";
import GObject from "gi://GObject";

import { ExtensionPreferences } from "resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js";

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
        const cleanups = [];

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
        widgetPage.add(makeWidgetsGroup(settings, cleanups));

        const popoutPage = new Adw.PreferencesPage({ title: "Pop-out", icon_name: "video-display-symbolic" });
        window.add(popoutPage);
        popoutPage.add(makePopoutGroup(settings));

        const customPage = new Adw.PreferencesPage({ title: "Custom", icon_name: "network-transmit-receive-symbolic" });
        window.add(customPage);
        customPage.add(makeCustomWidgetsGroup(window, settings, cleanups));

        // Adw.PreferencesWindow may be opened and closed repeatedly without
        // the extension reloading. Disconnect every signal we wired so the
        // rebuild closures (and the rowsBox they capture) are eligible for GC.
        window.connect("close-request", () => {
            for (const fn of cleanups) {
                try { fn(); } catch (_) {}
            }
            cleanups.length = 0;
            return false;
        });
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

function makeWidgetsGroup(settings, cleanups) {
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
    const id = settings.connect("changed::widget-layout", rebuild);
    if (cleanups) cleanups.push(() => settings.disconnect(id));

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

// ── custom HTTP-endpoint widgets ────────────────────────────────────────

const CUSTOM_ID_RE = /^[a-z][a-z0-9_-]{0,31}$/;
const CUSTOM_VIEWS = ["auto", "kv", "list", "raw"];

function parseCustomWidgets(json) {
    let raw;
    try { raw = JSON.parse(json || "[]"); } catch { raw = []; }
    if (!Array.isArray(raw)) return [];
    return raw.filter(e => e && typeof e.id === "string");
}

function serializeCustomWidgets(list) {
    return JSON.stringify(list.map(e => ({
        id:         e.id,
        name:       e.name || e.id,
        url:        e.url || "",
        refreshSec: Number.isFinite(e.refreshSec) ? e.refreshSec : 60,
        view:       CUSTOM_VIEWS.includes(e.view) ? e.view : "auto",
        ...(e.jsonPath ? { jsonPath: e.jsonPath } : {}),
        ...(e.headers && Object.keys(e.headers).length ? { headers: e.headers } : {}),
    })));
}

function makeCustomWidgetsGroup(window, settings, cleanups) {
    const group = new Adw.PreferencesGroup({
        title: "Custom HTTP endpoints",
        description: "Each entry polls a URL and renders its JSON response as a dashboard column. URLs are sent to the local backend, which fetches them on the configured interval.",
    });

    const list = new Gtk.ListBox({
        selection_mode: Gtk.SelectionMode.NONE,
        css_classes: ["boxed-list"],
    });

    const rebuild = () => {
        let row = list.get_first_child();
        while (row) {
            const next = row.get_next_sibling();
            list.remove(row);
            row = next;
        }
        const entries = parseCustomWidgets(settings.get_string("custom-widgets"));
        if (!entries.length) {
            const empty = new Adw.ActionRow({ title: "No custom widgets yet", subtitle: "Click Add to create one." });
            list.append(empty);
        }
        entries.forEach((entry, idx) => {
            list.append(makeCustomWidgetRow({
                window, entry,
                onEdit: () => openCustomWidgetDialog(window, settings, entry, idx),
                onDelete: () => {
                    const next = parseCustomWidgets(settings.get_string("custom-widgets"));
                    next.splice(idx, 1);
                    settings.set_string("custom-widgets", serializeCustomWidgets(next));
                },
            }));
        });
    };

    rebuild();
    const sigId = settings.connect("changed::custom-widgets", rebuild);
    if (cleanups) cleanups.push(() => settings.disconnect(sigId));

    const wrapper = new Adw.PreferencesRow({ activatable: false, focusable: false });
    const box = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL, spacing: 0 });
    box.append(list);
    wrapper.set_child(box);
    group.add(wrapper);

    const addRow = new Adw.ActionRow({ title: "Add custom widget", activatable: true });
    const addBtn = new Gtk.Button({ icon_name: "list-add-symbolic", valign: Gtk.Align.CENTER });
    addBtn.connect("clicked", () => openCustomWidgetDialog(window, settings, null, -1));
    addRow.add_suffix(addBtn);
    addRow.set_activatable_widget(addBtn);
    group.add(addRow);

    return group;
}

function makeCustomWidgetRow({ entry, onEdit, onDelete }) {
    const row = new Adw.ActionRow({
        title:    entry.name || entry.id,
        subtitle: `${entry.url}  ·  every ${entry.refreshSec || 60}s  ·  ${entry.view || "auto"}`,
    });
    const editBtn = new Gtk.Button({ icon_name: "document-edit-symbolic", valign: Gtk.Align.CENTER });
    editBtn.connect("clicked", onEdit);
    row.add_suffix(editBtn);
    const delBtn = new Gtk.Button({ icon_name: "user-trash-symbolic", valign: Gtk.Align.CENTER, css_classes: ["destructive-action"] });
    delBtn.connect("clicked", onDelete);
    row.add_suffix(delBtn);
    return row;
}

function openCustomWidgetDialog(parent, settings, entry, index) {
    const isNew = !entry || index < 0;
    const dialog = new Adw.PreferencesWindow({
        title: isNew ? "Add custom widget" : "Edit custom widget",
        modal: true,
        transient_for: parent,
        default_width: 520,
        default_height: 480,
    });
    const page = new Adw.PreferencesPage();
    dialog.add(page);

    const fields = new Adw.PreferencesGroup({ title: "Endpoint" });
    page.add(fields);

    const idRow = new Adw.EntryRow({ title: "ID (a-z, 0-9, _, -)" });
    idRow.set_text(entry?.id || "");
    if (!isNew) idRow.set_sensitive(false);
    fields.add(idRow);

    const nameRow = new Adw.EntryRow({ title: "Display name" });
    nameRow.set_text(entry?.name || "");
    fields.add(nameRow);

    const urlRow = new Adw.EntryRow({ title: "URL (http/https)" });
    urlRow.set_text(entry?.url || "");
    fields.add(urlRow);

    const refreshRow = new Adw.SpinRow({
        title: "Refresh (seconds)",
        adjustment: new Gtk.Adjustment({ lower: 5, upper: 3600, step_increment: 5, value: entry?.refreshSec || 60 }),
    });
    fields.add(refreshRow);

    const viewModel = new Gtk.StringList();
    for (const v of CUSTOM_VIEWS) viewModel.append(v);
    const viewRow = new Adw.ComboRow({ title: "View", model: viewModel });
    const idx = CUSTOM_VIEWS.indexOf(entry?.view || "auto");
    viewRow.set_selected(idx >= 0 ? idx : 0);
    fields.add(viewRow);

    const jsonPathRow = new Adw.EntryRow({ title: "JSON path (optional, e.g. data.items)" });
    jsonPathRow.set_text(entry?.jsonPath || "");
    fields.add(jsonPathRow);

    const headers = new Adw.PreferencesGroup({
        title: "Headers (optional)",
        description: "One header per line, formatted as Name: Value.",
    });
    page.add(headers);

    const headerView = new Gtk.TextView({
        monospace: true,
        wrap_mode: Gtk.WrapMode.WORD_CHAR,
        height_request: 96,
    });
    const headerScroll = new Gtk.ScrolledWindow({ hexpand: true, vexpand: false, child: headerView });
    const headerRow = new Adw.PreferencesRow({ activatable: false, focusable: false });
    headerRow.set_child(headerScroll);
    headers.add(headerRow);

    const headerTextInitial = entry?.headers
        ? Object.entries(entry.headers).map(([k, v]) => `${k}: ${v}`).join("\n")
        : "";
    headerView.buffer.set_text(headerTextInitial, headerTextInitial.length);

    const actions = new Adw.PreferencesGroup();
    page.add(actions);

    const statusRow = new Adw.ActionRow({ title: "" });
    const statusLabel = new Gtk.Label({ label: "", xalign: 0, css_classes: ["error"] });
    statusRow.add_prefix(statusLabel);
    actions.add(statusRow);

    const saveRow = new Adw.ActionRow({ title: "" });
    const cancelBtn = new Gtk.Button({ label: "Cancel", valign: Gtk.Align.CENTER });
    cancelBtn.connect("clicked", () => dialog.close());
    saveRow.add_suffix(cancelBtn);
    const saveBtn = new Gtk.Button({ label: isNew ? "Add" : "Save", valign: Gtk.Align.CENTER, css_classes: ["suggested-action"] });
    saveRow.add_suffix(saveBtn);
    actions.add(saveRow);

    saveBtn.connect("clicked", () => {
        const id = idRow.get_text().trim();
        const name = nameRow.get_text().trim();
        const url = urlRow.get_text().trim();
        const refreshSec = Math.max(5, Math.min(3600, refreshRow.get_value() | 0));
        const view = CUSTOM_VIEWS[viewRow.get_selected()] || "auto";
        const jsonPath = jsonPathRow.get_text().trim();

        if (!CUSTOM_ID_RE.test(id)) {
            statusLabel.set_label("id must start with a letter and contain only a-z, 0-9, _, -");
            return;
        }
        if (!name) { statusLabel.set_label("display name is required"); return; }
        try {
            const u = new URL(url);
            if (u.protocol !== "http:" && u.protocol !== "https:") throw new Error("must be http or https");
        } catch (e) {
            statusLabel.set_label("invalid URL: " + e.message);
            return;
        }

        const headerText = headerView.buffer.text || "";
        const parsedHeaders = {};
        for (const line of headerText.split("\n")) {
            const trimmed = line.trim();
            if (!trimmed) continue;
            const sep = trimmed.indexOf(":");
            if (sep <= 0) {
                statusLabel.set_label(`bad header line: "${trimmed}"`);
                return;
            }
            const k = trimmed.slice(0, sep).trim();
            const v = trimmed.slice(sep + 1).trim();
            if (!/^[A-Za-z0-9-]+$/.test(k)) {
                statusLabel.set_label(`header name "${k}" must match [A-Za-z0-9-]`);
                return;
            }
            parsedHeaders[k] = v;
        }

        const next = parseCustomWidgets(settings.get_string("custom-widgets"));
        if (isNew && next.some(e => e.id === id)) {
            statusLabel.set_label(`id "${id}" already exists`);
            return;
        }
        const updated = { id, name, url, refreshSec, view };
        if (jsonPath) updated.jsonPath = jsonPath;
        if (Object.keys(parsedHeaders).length) updated.headers = parsedHeaders;

        if (isNew) next.push(updated);
        else next[index] = updated;

        settings.set_string("custom-widgets", serializeCustomWidgets(next));
        dialog.close();
    });

    dialog.present();
}
