// glance — GNOME Shell extension.
// Top-panel button → dropdown dashboard fed by a local Node.js backend.
// Same dashboard can be popped out as a draggable, resizable standalone
// chrome window. Layout is configurable: which widgets appear, in what
// order, with what relative size.

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
import { renderDashboard, moveWidget, resizeWidget, setWidgetEnabled } from "./lib/render.js";
import { parseLayout, serializeLayout } from "./lib/widgets.js";
import { PopoutWindow, addPopoutToShell, removePopoutFromShell } from "./lib/popout.js";

const GlanceIndicator = GObject.registerClass(
class GlanceIndicator extends PanelMenu.Button {
    _init(extension) {
        super._init(0.0, "Glance");
        this._extension = extension;
        this._settings  = extension.getSettings();
        this._state     = null;
        this._refreshTimer = 0;
        this._handlerIds   = [];
        this._cancellable  = new Gio.Cancellable();
        this._popout      = null;

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
        const placeholder = new St.Label({
            text: "starting glance backend...",
            style_class: "glance-placeholder",
            x_expand: true,
        });
        this._dashboard.add_child(placeholder);

        item.add_child(this._dashboard);
        this.menu.addMenuItem(item);

        this._handlerIds.push([this.menu, this.menu.connect("open-state-changed", (_m, open) => {
            if (open) this._onOpen();
        })]);

        // Track layout changes so an edit in prefs is reflected immediately.
        this._handlerIds.push([this._settings, this._settings.connect("changed::widget-layout", () => this._rerender())]);
        this._handlerIds.push([this._settings, this._settings.connect("changed::edit-mode",     () => this._rerender())]);
        this._handlerIds.push([this._settings, this._settings.connect("changed::popout-active", () => {
            const want = this._settings.get_boolean("popout-active");
            if (want && !this._popout) this._openPopout();
            else if (!want && this._popout) this._closePopout();
        })]);
        this._handlerIds.push([this._settings, this._settings.connect("changed::popout-width",  () => this._reflowPopout())]);
        this._handlerIds.push([this._settings, this._settings.connect("changed::popout-height", () => this._reflowPopout())]);

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
            this._backend.start((info) => {
                if (info && info.fastExit) {
                    const tail = info.stderr ? ` — ${info.stderr}` : "";
                    Main.notify("glance backend failed to start",
                                `exit ${info.status}${tail}`);
                }
            });
        }

        this._startPolling();

        if (this._settings.get_boolean("popout-active")) {
            this._openPopout();
        }
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
        const monitor = Main.layoutManager.primaryMonitor;
        const pct = Math.max(30, Math.min(100, this._settings.get_int("dropdown-width-pct"))) / 100;
        const width  = Math.floor(monitor.width  * pct);
        const height = Math.floor(monitor.height * 0.42);
        // set_width is clamped by PopupMenu on some shell versions; min-width via
        // inline style on our .glance-menu style_class survives the clamp.
        this.menu.box.set_style(`min-width: ${width}px;`);
        this._dashboard.set_style(`min-width: ${width - 24}px; min-height: ${height}px;`);
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
        if (this._cancellable.is_cancelled()) return;
        try {
            const state = await api.get(`${this._backend.url}/api/state`, this._cancellable);
            this._state = state;
            this._updatePanel(state);
            this._rerender();
        } catch (e) {
            if (this._cancellable.is_cancelled()) return;
            this._label.text = "glance·offline";
            this._dot.style_class = "system-status-icon glance-dot offline";
            if (this.menu.isOpen) this._showError(`backend unreachable at ${this._backend.url} (${e.message})`);
            if (this._popout)     this._showPopoutError(`backend unreachable at ${this._backend.url} (${e.message})`);
        }
    }

    _rerender() {
        if (!this._state) return;
        const base = this._renderOpts();
        if (this.menu.isOpen) {
            renderDashboard(this._dashboard, this._state, { ...base, onPopOut: () => this._openPopout() });
        }
        if (this._popout) {
            renderDashboard(this._popout.contentBox, this._state, { ...base, onClosePopOut: () => this._closePopout() });
        }
    }

    _renderOpts() {
        const layoutJson = this._settings.get_string("widget-layout");
        const editMode   = this._settings.get_boolean("edit-mode");
        return {
            layoutJson,
            editMode,
            onOpenUrl:       (url) => this._openUrl(url),
            onToggleEdit:    () => this._settings.set_boolean("edit-mode", !editMode),
            onMoveWidget:    (id, dir) => this._mutateLayout(layout => moveWidget(layout, id, dir)),
            onResizeWidget:  (id, dir) => this._mutateLayout(layout => resizeWidget(layout, id, dir)),
            onHideWidget:    (id)      => this._mutateLayout(layout => setWidgetEnabled(layout, id, false)),
        };
    }

    _openUrl(url) {
        if (!this._backend || !url) return;
        api.post(`${this._backend.url}/api/open`, { url }, this._cancellable).catch(() => {});
    }

    _mutateLayout(fn) {
        const layout = parseLayout(this._settings.get_string("widget-layout"));
        const next   = fn(layout);
        this._settings.set_string("widget-layout", serializeLayout(next));
    }

    _showPopoutError(msg) {
        if (!this._popout) return;
        const body = this._popout.contentBox;
        body.destroy_all_children();
        body.add_child(new St.Label({ text: `glance: ${msg}`, style_class: "glance-error", x_expand: true }));
    }

    // ── pop-out window ──────────────────────────────────────────────────

    _openPopout() {
        if (this._popout) return;
        const x = this._settings.get_int("popout-x");
        const y = this._settings.get_int("popout-y");
        const w = this._settings.get_int("popout-width");
        const h = this._settings.get_int("popout-height");
        this._popout = new PopoutWindow({
            x, y, width: w, height: h,
            onClose:  () => this._closePopout(),
            onMove:   (nx, ny) => { this._settings.set_int("popout-x", nx); this._settings.set_int("popout-y", ny); },
            onResize: (nw, nh) => { this._settings.set_int("popout-width", nw); this._settings.set_int("popout-height", nh); },
        });
        addPopoutToShell(this._popout);
        this._settings.set_boolean("popout-active", true);
        if (this._state) this._rerender();
    }

    _closePopout() {
        if (!this._popout) return;
        removePopoutFromShell(this._popout);
        this._popout.destroy();
        this._popout = null;
        this._settings.set_boolean("popout-active", false);
    }

    _reflowPopout() {
        if (!this._popout) return;
        const w = this._settings.get_int("popout-width");
        const h = this._settings.get_int("popout-height");
        this._popout.sizeTo(w, h);
    }

    _updatePanel(state) {
        const lin = state.linear || { total: 0, overdue: 0, items: [] };
        const p1 = (lin.items || []).filter(i => i.priority === 1).length;
        const overdue = lin.overdue || 0;
        const sessions = (state.sessions || []).length;
        const unread = (state.inbox && state.inbox.unread_count) || 0;

        const parts = [];
        if (p1)       parts.push(`P1·${p1}`);
        if (overdue)  parts.push(`!${overdue}`);
        if (sessions) parts.push(`▸${sessions}`);
        if (unread)   parts.push(`✉${unread}`);
        this._label.text = parts.length ? parts.join("  ") : "glance";
        this._dot.style_class = "system-status-icon glance-dot online" + (overdue ? " warn" : "");
    }

    destroy() {
        if (this._cancellable) this._cancellable.cancel();
        if (this._refreshTimer) {
            GLib.source_remove(this._refreshTimer);
            this._refreshTimer = 0;
        }
        for (const [obj, id] of this._handlerIds) {
            try { obj.disconnect(id); } catch (_) {}
        }
        this._handlerIds.length = 0;
        if (this._popout) {
            removePopoutFromShell(this._popout);
            this._popout.destroy();
            this._popout = null;
        }
        if (this._backend && this._extension._settings.get_boolean("auto-start-backend")) {
            this._backend.stop();
        }
        super.destroy();
        this._dashboard = null;
        this._dot       = null;
        this._label     = null;
        this._backend   = null;
        this._state     = null;
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
