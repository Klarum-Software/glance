// Standalone dashboard window. A Main.layoutManager chrome actor that
// behaves like a small window: drag the header to move, drag the corner /
// edges to resize. Renders the same dashboard the dropdown does.
//
// The outer container uses Clutter.BinLayout so the resize zones can
// overlay the vertical stack of header + body without participating in its
// flow. Each zone is its own reactive St.Widget child, sized explicitly so
// BinLayout positions it at the right edge / bottom edge / corner.

import Clutter from "gi://Clutter";
import GObject from "gi://GObject";
import St      from "gi://St";

import * as Main from "resource:///org/gnome/shell/ui/main.js";

const MIN_W      = 400;
const MIN_H      = 240;
const CORNER_PX  = 28;
const EDGE_PX    = 10;

export const PopoutWindow = GObject.registerClass(
class PopoutWindow extends St.Widget {
    _init({ x, y, width, height, onClose, onMove, onResize }) {
        super._init({
            layout_manager: new Clutter.BinLayout(),
            style_class: "glance-popout",
            reactive: true,
            track_hover: true,
            x_expand: false,
            y_expand: false,
        });

        this._onMoveCb    = onMove;
        this._onCloseCb   = onClose;
        this._onResizeCb  = onResize;
        this._signalIds   = [];

        this._w = Math.max(MIN_W, width  | 0);
        this._h = Math.max(MIN_H, height | 0);
        this._x = x | 0;
        this._y = y | 0;

        this.set_size(this._w, this._h);
        this.set_position(this._x, this._y);

        this._stack = new St.BoxLayout({
            vertical: true,
            x_expand: true,
            y_expand: true,
            x_align:  Clutter.ActorAlign.FILL,
            y_align:  Clutter.ActorAlign.FILL,
        });
        this.add_child(this._stack);

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
        this._stack.add_child(this._header);

        this._content = new St.BoxLayout({
            vertical: true,
            style_class: "glance-popout-body",
            x_expand: true,
            y_expand: true,
        });
        this._stack.add_child(this._content);

        // Resize zones. Order matters: BinLayout picks last-added first when
        // children overlap. The corner sits inside both edges, so it must be
        // added LAST so it wins in the overlap region.
        this._edgeR = this._makeResizeZone("glance-popout-edge-r", { dx: 1, dy: 0 },
            Clutter.ActorAlign.END, Clutter.ActorAlign.FILL, EDGE_PX, 0);
        this._edgeB = this._makeResizeZone("glance-popout-edge-b", { dx: 0, dy: 1 },
            Clutter.ActorAlign.FILL, Clutter.ActorAlign.END, 0, EDGE_PX);
        this._corner = this._makeResizeZone("glance-popout-grip", { dx: 1, dy: 1 },
            Clutter.ActorAlign.END, Clutter.ActorAlign.END, CORNER_PX, CORNER_PX);

        this._wireMove();
    }

    get contentBox() { return this._content; }

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
        const m = Main.layoutManager.primaryMonitor;
        const maxW = m ? Math.max(MIN_W, m.width  - this._x) : Number.POSITIVE_INFINITY;
        const maxH = m ? Math.max(MIN_H, m.height - this._y) : Number.POSITIVE_INFINITY;
        this._w = Math.max(MIN_W, Math.min(maxW, w | 0));
        this._h = Math.max(MIN_H, Math.min(maxH, h | 0));
        this.set_size(this._w, this._h);
    }

    geometry() { return { x: this._x, y: this._y, w: this._w, h: this._h }; }

    _makeResizeZone(styleClass, axis, xAlign, yAlign, w, h) {
        const zone = new St.Widget({
            style_class: styleClass,
            reactive: true,
            track_hover: true,
            x_align: xAlign,
            y_align: yAlign,
        });
        // Explicit size — BinLayout uses each child's preferred size when
        // alignment is not FILL. width:0 / height:0 means "use FILL on that
        // axis", so the edge zones span the full popout on one axis.
        if (w > 0) zone.set_width(w);
        if (h > 0) zone.set_height(h);
        this.add_child(zone);
        this._wireResize(zone, axis);
        return zone;
    }

    _wireMove() {
        let dragging = false;
        let startX = 0, startY = 0, origX = 0, origY = 0;
        this._signalIds.push([this._header, this._header.connect("button-press-event", (_a, ev) => {
            if (ev.get_button() !== 1) return Clutter.EVENT_PROPAGATE;
            dragging = true;
            const [sx, sy] = ev.get_coords();
            startX = sx; startY = sy;
            origX = this._x; origY = this._y;
            return Clutter.EVENT_STOP;
        })]);
        this._signalIds.push([this._header, this._header.connect("motion-event", (_a, ev) => {
            if (!dragging) return Clutter.EVENT_PROPAGATE;
            const [sx, sy] = ev.get_coords();
            this.moveTo(origX + (sx - startX), origY + (sy - startY));
            return Clutter.EVENT_STOP;
        })]);
        this._signalIds.push([this._header, this._header.connect("button-release-event", (_a, ev) => {
            if (!dragging) return Clutter.EVENT_PROPAGATE;
            dragging = false;
            if (this._onMoveCb) this._onMoveCb(this._x, this._y);
            return Clutter.EVENT_STOP;
        })]);
    }

    _wireResize(zone, axis) {
        let resizing = false;
        let startX = 0, startY = 0, origW = 0, origH = 0;
        this._signalIds.push([zone, zone.connect("button-press-event", (_a, ev) => {
            if (ev.get_button() !== 1) return Clutter.EVENT_PROPAGATE;
            resizing = true;
            const [sx, sy] = ev.get_coords();
            startX = sx; startY = sy;
            origW = this._w; origH = this._h;
            return Clutter.EVENT_STOP;
        })]);
        this._signalIds.push([zone, zone.connect("motion-event", (_a, ev) => {
            if (!resizing) return Clutter.EVENT_PROPAGATE;
            const [sx, sy] = ev.get_coords();
            const dw = axis.dx * (sx - startX);
            const dh = axis.dy * (sy - startY);
            this.sizeTo(origW + dw, origH + dh);
            return Clutter.EVENT_STOP;
        })]);
        this._signalIds.push([zone, zone.connect("button-release-event", (_a, ev) => {
            if (!resizing) return Clutter.EVENT_PROPAGATE;
            resizing = false;
            if (this._onResizeCb) this._onResizeCb(this._w, this._h);
            return Clutter.EVENT_STOP;
        })]);
    }

    destroy() {
        for (const [obj, id] of this._signalIds) {
            try { obj.disconnect(id); } catch (_) {}
        }
        this._signalIds = [];
        this._content = null;
        this._header  = null;
        this._stack   = null;
        this._corner  = null;
        this._edgeR   = null;
        this._edgeB   = null;
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
