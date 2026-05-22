// Standalone dashboard window. Implemented as a Main.layoutManager chrome
// actor with a draggable header. Renders the same dashboard the dropdown
// does, driven by the same state polling.
//
// Resizing happens via the gschema keys popout-width / popout-height,
// editable from Extension prefs ("Pop-out" page). A drag handle inside an
// St.BoxLayout fights the box's layout manager; resizing via setting keeps
// the popout robust across shell versions.

import Clutter from "gi://Clutter";
import GObject from "gi://GObject";
import St      from "gi://St";

import * as Main from "resource:///org/gnome/shell/ui/main.js";

const MIN_W = 400;
const MIN_H = 240;

export const PopoutWindow = GObject.registerClass(
class PopoutWindow extends St.BoxLayout {
    _init({ x, y, width, height, onClose, onMove }) {
        super._init({
            vertical: true,
            style_class: "glance-popout",
            reactive: true,
            track_hover: true,
            x_expand: false,
            y_expand: false,
        });

        this._onMoveCb   = onMove;
        this._onCloseCb  = onClose;

        this._w = Math.max(MIN_W, width  | 0);
        this._h = Math.max(MIN_H, height | 0);
        this._x = x | 0;
        this._y = y | 0;

        this.set_size(this._w, this._h);
        this.set_position(this._x, this._y);

        this._header = new St.BoxLayout({
            vertical: false,
            style_class: "glance-popout-head",
            reactive: true,
            track_hover: true,
            x_expand: true,
        });
        const title = new St.Label({
            text: "klarum glance",
            style_class: "glance-popout-title",
            y_align: Clutter.ActorAlign.CENTER,
            x_expand: true,
        });
        this._header.add_child(title);

        const close = new St.Button({
            label: "✕",
            style_class: "glance-popout-close",
            can_focus: true,
        });
        close.connect("clicked", () => this._onCloseCb && this._onCloseCb());
        this._header.add_child(close);
        this.add_child(this._header);

        this._content = new St.BoxLayout({
            vertical: true,
            style_class: "glance-popout-body",
            x_expand: true,
            y_expand: true,
        });
        this.add_child(this._content);

        this._wireDrag();
    }

    get contentBox() { return this._content; }

    // addGrip kept as a no-op so callers don't break across versions. If we
    // ever wire a true resize grip we'll reinstate the implementation here.
    addGrip() {}

    moveTo(x, y) {
        // Clamp against the primary monitor so a drag past an edge can't strand
        // the popout off-screen (recoverable only via dconf otherwise).
        const m = Main.layoutManager.primaryMonitor;
        const maxX = m ? Math.max(0, m.width  - this._w) : Number.POSITIVE_INFINITY;
        const maxY = m ? Math.max(0, m.height - this._h) : Number.POSITIVE_INFINITY;
        this._x = Math.max(0, Math.min(maxX, x | 0));
        this._y = Math.max(0, Math.min(maxY, y | 0));
        this.set_position(this._x, this._y);
    }

    sizeTo(w, h) {
        this._w = Math.max(MIN_W, w | 0);
        this._h = Math.max(MIN_H, h | 0);
        this.set_size(this._w, this._h);
        // A resize may push the bottom-right past the monitor edge — reapply
        // the move clamp so we don't end up partially off-screen.
        this.moveTo(this._x, this._y);
    }

    geometry() { return { x: this._x, y: this._y, w: this._w, h: this._h }; }

    _wireDrag() {
        this._headerHandlers = [];
        let dragging = false;
        let startX = 0, startY = 0, origX = 0, origY = 0;
        const id1 = this._header.connect("button-press-event", (_a, ev) => {
            if (ev.get_button() !== 1) return Clutter.EVENT_PROPAGATE;
            dragging = true;
            const [sx, sy] = ev.get_coords();
            startX = sx; startY = sy;
            origX = this._x; origY = this._y;
            return Clutter.EVENT_STOP;
        });
        const id2 = this._header.connect("motion-event", (_a, ev) => {
            if (!dragging) return Clutter.EVENT_PROPAGATE;
            const [sx, sy] = ev.get_coords();
            this.moveTo(origX + (sx - startX), origY + (sy - startY));
            return Clutter.EVENT_STOP;
        });
        const id3 = this._header.connect("button-release-event", (_a, ev) => {
            if (!dragging) return Clutter.EVENT_PROPAGATE;
            dragging = false;
            if (this._onMoveCb) this._onMoveCb(this._x, this._y);
            return Clutter.EVENT_STOP;
        });
        this._headerHandlers.push(id1, id2, id3);
    }

    destroy() {
        if (this._headerHandlers) {
            for (const id of this._headerHandlers) {
                try { this._header.disconnect(id); } catch (_) {}
            }
            this._headerHandlers = null;
        }
        this._content = null;
        this._header  = null;
        super.destroy();
    }
});

export function addPopoutToShell(popout) {
    Main.layoutManager.addChrome(popout, {
        affectsInputRegion: true,
        affectsStruts:      false,
        trackFullscreen:    false,
    });
}

export function removePopoutFromShell(popout) {
    try { Main.layoutManager.removeChrome(popout); } catch (_) {}
}
