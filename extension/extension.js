// glance — GNOME Shell extension.
// Top-panel button → dropdown dashboard fed by a local Node.js backend.

import GObject     from "gi://GObject";
import GLib        from "gi://GLib";
import St          from "gi://St";
import Clutter     from "gi://Clutter";
import Gio         from "gi://Gio";

import { Extension } from "resource:///org/gnome/shell/extensions/extension.js";
import * as Main       from "resource:///org/gnome/shell/ui/main.js";
import * as PanelMenu  from "resource:///org/gnome/shell/ui/panelMenu.js";
import * as PopupMenu  from "resource:///org/gnome/shell/ui/popupMenu.js";

import { Backend, resolveServerPath, resolveNodePath } from "./lib/backend.js";
import * as api    from "./lib/api.js";
import * as fmt    from "./lib/format.js";
import { renderDashboard } from "./lib/render.js";

const GlanceIndicator = GObject.registerClass(
class GlanceIndicator extends PanelMenu.Button {
    _init(extension) {
        super._init(0.0, "Glance");
        this._extension = extension;
        this._settings  = extension.getSettings();
        this._state     = null;
        this._refreshTimer = 0;

        // ── panel button ────────────────────────────────────────────────
        const box = new St.BoxLayout({
            style_class: "panel-status-menu-box glance-panel",
            x_align: Clutter.ActorAlign.CENTER,
            y_align: Clutter.ActorAlign.CENTER,
        });
        this._dot = new St.Icon({
            icon_name: "view-grid-symbolic",
            style_class: "system-status-icon glance-dot",
        });
        this._label = new St.Label({
            text: "glance",
            y_align: Clutter.ActorAlign.CENTER,
            style_class: "glance-panel-label",
        });
        box.add_child(this._dot);
        box.add_child(this._label);
        this.add_child(box);

        // ── menu content (wide custom widget) ───────────────────────────
        this.menu.box.style_class = "popup-menu-content glance-menu";

        const item = new PopupMenu.PopupBaseMenuItem({
            reactive: false,
            can_focus: false,
            style_class: "glance-menu-item",
        });
        item.set_x_expand(true);

        this._dashboard = new St.BoxLayout({
            vertical: true,
            style_class: "glance-dashboard",
            x_expand: true,
            y_expand: true,
        });
        // Initial placeholder
        const placeholder = new St.Label({
            text: "starting glance backend…",
            style_class: "glance-placeholder",
            x_expand: true,
        });
        this._dashboard.add_child(placeholder);

        item.add_child(this._dashboard);
        this.menu.addMenuItem(item);

        // Resize the menu dynamically when opened.
        this.menu.connect("open-state-changed", (_m, open) => {
            if (open) this._onOpen();
        });

        // ── backend ─────────────────────────────────────────────────────
        const port = this._settings.get_int("backend-port");
        const explicitServer = this._settings.get_string("backend-path");
        const serverPath = resolveServerPath(explicitServer, extension.path);
        if (!serverPath) {
            this._showError("server.js not found — set backend-path in extension preferences.");
            return;
        }
        const nodePath = resolveNodePath();
        this._backend = new Backend({ nodePath, serverPath, port });

        if (this._settings.get_boolean("auto-start-backend")) {
            this._backend.start(() => log("[glance] backend exited"));
        }

        this._startPolling();
    }

    _showError(msg) {
        this._dashboard.destroy_all_children();
        this._dashboard.add_child(new St.Label({
            text: `glance: ${msg}`,
            style_class: "glance-error",
            x_expand: true,
        }));
    }

    _onOpen() {
        // Resize to a percentage of the primary monitor width.
        const monitor = Main.layoutManager.primaryMonitor;
        const pct = Math.max(30, Math.min(100, this._settings.get_int("dropdown-width-pct"))) / 100;
        const width  = Math.floor(monitor.width  * pct);
        const height = Math.floor(monitor.height * 0.42);
        this.menu.box.set_width(width);
        this._dashboard.set_width(width - 24);
        this._dashboard.set_height(height);
        // Immediate refresh on open so data is fresh.
        this._refresh();
    }

    _startPolling() {
        const interval = Math.max(5, this._settings.get_int("refresh-interval"));
        this._refresh();
        this._refreshTimer = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, interval, () => {
            this._refresh();
            return GLib.SOURCE_CONTINUE;
        });
    }

    async _refresh() {
        if (!this._backend) return;
        try {
            const state = await api.get(`${this._backend.url}/api/state`);
            this._state = state;
            this._updatePanel(state);
            // Only rebuild dashboard contents when menu is open (cheap optimisation).
            if (this.menu.isOpen) {
                renderDashboard(this._dashboard, state, {
                    onOpenUrl: (url) => api.post(`${this._backend.url}/api/open`, { url }).catch(() => {}),
                });
            }
        } catch (e) {
            this._label.text = "glance·offline";
            this._dot.style_class = "system-status-icon glance-dot offline";
            // If menu is open, surface the error
            if (this.menu.isOpen) this._showError(`backend unreachable at ${this._backend.url} (${e.message})`);
        }
    }

    _updatePanel(state) {
        // Compact summary in the top panel: P1 count + overdue + sessions.
        const lin = state.linear || { total: 0, overdue: 0, items: [] };
        const p1 = (lin.items || []).filter(i => i.priority === 1).length;
        const overdue = lin.overdue || 0;
        const sessions = (state.sessions || []).length;
        const drafts = (state.drafts || []).length;

        const parts = [];
        if (p1)       parts.push(`P1·${p1}`);
        if (overdue)  parts.push(`!${overdue}`);
        if (drafts)   parts.push(`⚑${drafts}`);
        if (sessions) parts.push(`▸${sessions}`);
        this._label.text = parts.length ? parts.join("  ") : "glance";
        this._dot.style_class = "system-status-icon glance-dot online" + (overdue ? " warn" : "");
    }

    destroy() {
        if (this._refreshTimer) {
            GLib.source_remove(this._refreshTimer);
            this._refreshTimer = 0;
        }
        if (this._backend && this._extension._settings.get_boolean("auto-start-backend")) {
            this._backend.stop();
        }
        super.destroy();
    }
});

export default class GlanceExtension extends Extension {
    enable() {
        this._settings  = this.getSettings();
        this._indicator = new GlanceIndicator(this);
        Main.panel.addToStatusArea(this.uuid, this._indicator, 0, "right");
    }

    disable() {
        if (this._indicator) {
            this._indicator.destroy();
            this._indicator = null;
        }
        this._settings = null;
    }
}
