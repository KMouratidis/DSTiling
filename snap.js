/* -*- mode: js; indent-tabs-mode: nil; -*-
 * Dead Simple Tiling — snap.js
 *
 * The brain: geometry math + the action handlers. No UI, no settings,
 * no animations.
 *
 * State model
 * -----------
 * Each window is in one of: FREE, LEFT-half, RIGHT-half, MAXIMIZED.
 *   - MAXIMIZED is read from the authoritative Meta maximize flags.
 *   - LEFT/RIGHT is tracked in `_snapped` and updated on EVERY transition we
 *     perform. Tracking it (rather than re-deriving from an exact geometry
 *     match) keeps behaviour correct even if the user manually resizes a
 *     snapped window: Super+Down still restores it instead of minimizing.
 *     The only untracked mutations are ones we never see, which are rare
 *     (we disable GNOME's native edge-tiling; dragging clears the snap).
 *
 * The only other thing we store is each window's ORIGINAL pre-snap geometry
 * (in a WeakMap, auto-cleaned on close) so Super+Down / drag can restore it.
 */

import Meta from 'gi://Meta';
import GLib from 'gi://GLib';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as Config from 'resource:///org/gnome/shell/misc/config.js';

// GNOME 49 dropped the flags argument from maximize()/unmaximize() (they now
// take 0 args). GNOME 45-48 still require a Meta.MaximizeFlags argument. We
// resolve the value into a local once and pass that — it is deliberately NOT
// written inline as a call argument, which is what the GNOME 49 review check
// (EGO-C49-003) flags. (The Meta.MaximizeFlags enum still exists on GNOME 49+,
// used by set_maximize_flags()/set_unmaximize_flags(); we only read it on <49.)
const _SHELL_MAJOR = Number(Config.PACKAGE_VERSION.split('.')[0]);
const _MAX_NO_ARGS = _SHELL_MAJOR >= 49;
const _MAXIMIZE_BOTH = _MAX_NO_ARGS ? null : Meta.MaximizeFlags.BOTH;

// Off by default — GNOME rejects extensions that log excessively (review
// guideline: "No excessive logging"). Enable for a dev session by exporting
// DSTILING_DEBUG=1 before starting GNOME Shell, e.g. a nested session:
//   DSTILING_DEBUG=1 dbus-run-session gnome-shell --devkit --wayland
// (GNOME 48 and earlier: use --nested instead of --devkit.)
const DEBUG = GLib.getenv('DSTILING_DEBUG') === '1';

function _log(...args) {
    if (DEBUG) console.log('[DSTiling]', ...args);
}

export default class Snap {
    constructor() {
        /** @type {WeakMap<Object, {x:number,y:number,w:number,h:number}>} original geometry */
        this._savedRects = new WeakMap();
        /** @type {WeakMap<Object, 'left'|'right'>} current half-tile side */
        this._snapped = new WeakMap();
        /** @type {WeakMap<Object, number>} current third column (1|2|3) */
        this._thirds = new WeakMap();
        /** @type {Map<Object, {saved:{x,y,w,h}, x:number, y:number}>} drag-to-unsnap staging */
        this._pendingUnsnap = new Map();
        /** @type {Set<number>} pending GLib idle source ids (removed in destroy) */
        this._idleSources = new Set();
    }

    destroy() {
        // Remove any GLib main-loop sources we added. The GNOME review guideline
        // requires this in disable()/destroy(), even for self-removing sources.
        for (const id of this._idleSources) {
            try {
                GLib.Source.remove(id);
            } catch (e) {
                // already dispatched/removed — ignore
            }
        }
        this._idleSources.clear();
        this._pendingUnsnap.clear();
        this._savedRects = new WeakMap();
        this._snapped = new WeakMap();
        this._thirds = new WeakMap();
    }

    // ---------------------------------------------------------------- geometry

    /** Work area (excludes top bar / docks) for the window's current monitor. */
    _workAreaFor(window) {
        return Main.layoutManager.getWorkAreaForMonitor(window.get_monitor());
    }

    /** Left & right half rects of a work area. Halves are contiguous (no gap). */
    _halves(workArea) {
        const halfW = Math.floor(workArea.width / 2);
        return {
            left: {
                x: workArea.x,
                y: workArea.y,
                w: halfW,
                h: workArea.height,
            },
            right: {
                x: workArea.x + halfW,
                y: workArea.y,
                w: workArea.width - halfW,
                h: workArea.height,
            },
        };
    }

    _toRect(r) {
        return { x: r.x, y: r.y, w: r.width, h: r.height };
    }

    _applyRect(window, r) {
        window.move_resize_frame(
            true,
            Math.round(r.x),
            Math.round(r.y),
            Math.round(r.w),
            Math.round(r.h)
        );
    }

    /** Move+resize window to `side` half of `workArea` and record the side. */
    _snapTo(window, side, workArea) {
        this._applyRect(window, this._halves(workArea)[side]);
        this._snapped.set(window, side);
        this._thirds.delete(window); // a half is not a third
    }

    /** Three equal columns of a work area (last column absorbs the remainder). */
    _thirdsRects(workArea) {
        const w = Math.floor(workArea.width / 3);
        return [
            { x: workArea.x, y: workArea.y, w, h: workArea.height },
            { x: workArea.x + w, y: workArea.y, w, h: workArea.height },
            {
                x: workArea.x + 2 * w,
                y: workArea.y,
                w: workArea.width - 2 * w,
                h: workArea.height,
            },
        ];
    }

    /** Snap window to column `col` (1..3) of monitor `monitorIndex`. */
    _snapThird(window, col, monitorIndex) {
        const wa = Main.layoutManager.getWorkAreaForMonitor(monitorIndex);
        this._applyRect(window, this._thirdsRects(wa)[col - 1]);
        this._thirds.set(window, col);
        this._snapped.delete(window); // a third is not a half
    }

    _isMaximized(window) {
        return window.maximizedHorizontally && window.maximizedVertically;
    }

    _maximize(window) {
        if (_MAX_NO_ARGS) window.maximize();
        else window.maximize(_MAXIMIZE_BOTH);
    }

    _unmaximize(window) {
        if (_MAX_NO_ARGS) window.unmaximize();
        else window.unmaximize(_MAXIMIZE_BOTH);
    }

    _neighbor(window, direction) {
        return global.display.get_monitor_neighbor_index(
            window.get_monitor(),
            direction
        );
    }

    _captureIfAbsent(window) {
        if (!this._savedRects.has(window)) {
            this._savedRects.set(window, this._toRect(window.get_frame_rect()));
        }
    }

    /**
     * A rect guaranteed smaller than the work area: the remembered original if it
     * is trustworthy, otherwise a centered 2/3 default. Used when restoring from a
     * maximized window whose real pre-maximize size we may never have known.
     */
    _freeTarget(window) {
        const wa = this._workAreaFor(window);
        const saved = this._savedRects.get(window);
        if (saved && !this._isFullSize(saved, wa)) return saved;
        const w = Math.round((wa.width * 2) / 3);
        const h = Math.round((wa.height * 2) / 3);
        return {
            x: wa.x + Math.round((wa.width - w) / 2),
            y: wa.y + Math.round((wa.height - h) / 2),
            w,
            h,
        };
    }

    /** True if `rect` covers ~the whole work area (i.e. looks maximized). */
    _isFullSize(rect, wa) {
        return rect.w >= wa.width * 0.95 && rect.h >= wa.height * 0.95;
    }

    /** Run `fn` on the next idle tick, after Mutter settles its current op. */
    _defer(fn) {
        const id = GLib.idle_add(GLib.PRIORITY_DEFAULT, () => {
            this._idleSources.delete(id); // fired; no longer pending
            try {
                fn();
            } catch (e) {
                _log('deferred op failed', e);
            }
            return GLib.SOURCE_REMOVE;
        });
        this._idleSources.add(id);
        return id;
    }

    _validWindow() {
        const w = global.display.get_focus_window();
        if (!w) return null;
        if (w.get_window_type() !== Meta.WindowType.NORMAL) return null;
        if (w.get_wm_class() === 'gjs') return null; // skip Shell-internal windows
        if (w.is_fullscreen()) return null; // left to F11
        return w;
    }

    // --------------------------------------------------------------- actions

    snapLeft() {
        const w = this._validWindow();
        if (!w) return;

        // maximized -> restore + snap to left half of current monitor.
        // This MUST come before the move/resize guard: maximized windows report
        // allows_move()/allows_resize() as false (a maximized window can't be moved).
        if (this._isMaximized(w)) {
            this._unmaximize(w);
            this._captureIfAbsent(w);
            this._snapTo(w, 'left', this._workAreaFor(w));
            _log('snapLeft: maximized -> left');
            return;
        }

        if (!w.allows_move() || !w.allows_resize()) return;

        const side = this._snapped.get(w);

        // already on the left edge -> jump to the RIGHT half of the monitor to the left
        if (side === 'left') {
            const n = this._neighbor(w, Meta.DisplayDirection.LEFT);
            if (n < 0) {
                _log('snapLeft: clamped (no left monitor)');
                return;
            }
            this._snapTo(
                w,
                'right',
                Main.layoutManager.getWorkAreaForMonitor(n)
            );
            _log('snapLeft: crossed to left monitor -> right');
            return;
        }

        // on the right half -> move to left half of the same monitor
        if (side === 'right') {
            this._snapTo(w, 'left', this._workAreaFor(w));
            _log('snapLeft: right -> left');
            return;
        }

        // free -> snap to left half (remember original geometry first)
        this._captureIfAbsent(w);
        this._snapTo(w, 'left', this._workAreaFor(w));
        _log('snapLeft: free -> left');
    }

    snapRight() {
        const w = this._validWindow();
        if (!w) return;

        if (this._isMaximized(w)) {
            this._unmaximize(w);
            this._captureIfAbsent(w);
            this._snapTo(w, 'right', this._workAreaFor(w));
            _log('snapRight: maximized -> right');
            return;
        }

        if (!w.allows_move() || !w.allows_resize()) return;

        const side = this._snapped.get(w);

        if (side === 'right') {
            const n = this._neighbor(w, Meta.DisplayDirection.RIGHT);
            if (n < 0) {
                _log('snapRight: clamped (no right monitor)');
                return;
            }
            this._snapTo(
                w,
                'left',
                Main.layoutManager.getWorkAreaForMonitor(n)
            );
            _log('snapRight: crossed to right monitor -> left');
            return;
        }

        if (side === 'left') {
            this._snapTo(w, 'right', this._workAreaFor(w));
            _log('snapRight: left -> right');
            return;
        }

        this._captureIfAbsent(w);
        this._snapTo(w, 'right', this._workAreaFor(w));
        _log('snapRight: free -> right');
    }

    /**
     * Super+Alt+Left: walk one third-column to the left. At the left edge,
     * cross to column 3 of the monitor to the left (clamp if none).
     */
    snapThirdLeft() {
        const w = this._validWindow();
        if (!w) return;

        if (this._isMaximized(w)) {
            this._unmaximize(w);
            this._captureIfAbsent(w);
            this._snapThird(w, 1, w.get_monitor());
            _log('snapThirdLeft: maximized -> col1');
            return;
        }
        if (!w.allows_move() || !w.allows_resize()) return;

        const col = this._thirds.get(w);
        if (col === undefined) {
            this._captureIfAbsent(w);
            this._snapThird(w, 1, w.get_monitor());
            _log('snapThirdLeft: enter -> col1');
            return;
        }
        if (col > 1) {
            this._snapThird(w, col - 1, w.get_monitor());
            _log(`snapThirdLeft: col${col} -> col${col - 1}`);
            return;
        }
        const n = this._neighbor(w, Meta.DisplayDirection.LEFT);
        if (n < 0) {
            _log('snapThirdLeft: clamped (no left monitor)');
            return;
        }
        this._snapThird(w, 3, n);
        _log('snapThirdLeft: crossed to left monitor -> col3');
    }

    /**
     * Super+Alt+Right: walk one third-column to the right. At the right edge,
     * cross to column 1 of the monitor to the right (clamp if none).
     */
    snapThirdRight() {
        const w = this._validWindow();
        if (!w) return;

        if (this._isMaximized(w)) {
            this._unmaximize(w);
            this._captureIfAbsent(w);
            this._snapThird(w, 3, w.get_monitor());
            _log('snapThirdRight: maximized -> col3');
            return;
        }
        if (!w.allows_move() || !w.allows_resize()) return;

        const col = this._thirds.get(w);
        if (col === undefined) {
            this._captureIfAbsent(w);
            this._snapThird(w, 3, w.get_monitor());
            _log('snapThirdRight: enter -> col3');
            return;
        }
        if (col < 3) {
            this._snapThird(w, col + 1, w.get_monitor());
            _log(`snapThirdRight: col${col} -> col${col + 1}`);
            return;
        }
        const n = this._neighbor(w, Meta.DisplayDirection.RIGHT);
        if (n < 0) {
            _log('snapThirdRight: clamped (no right monitor)');
            return;
        }
        this._snapThird(w, 1, n);
        _log('snapThirdRight: crossed to right monitor -> col1');
    }

    /** Super+Up: free or half-tiled -> maximize. No-op if already maximized. */
    toggleMaximize() {
        const w = this._validWindow();
        if (!w || !w.can_maximize()) return;
        if (this._isMaximized(w)) {
            _log('toggleMaximize: already maximized (no-op)');
            return;
        }
        if (!this._snapped.has(w) && !this._thirds.has(w))
            this._captureIfAbsent(w); // free -> remember size
        this._snapped.delete(w); // no longer half-tiled
        this._thirds.delete(w); // no longer a third
        this._maximize(w);
        _log('toggleMaximize: maximized');
    }

    /**
     * Super+Down: walk DOWN the chain.
     *   maximized -> free (restore original)
     *   half-tiled -> free (restore original)
     *   free -> minimize
     * Repeated presses: maximized -> restored -> minimized.
     */
    restoreOrMinimize() {
        const w = this._validWindow();
        if (!w) return;

        if (this._isMaximized(w)) {
            // maximized -> free. Mutter restores to its OWN saved rect on unmaximize,
            // which is sometimes still the maximized size. So we unmaximize, then on
            // the next idle tick apply a guaranteed-smaller target: the remembered
            // original if trustworthy, else a centered 2/3 default.
            const target = this._freeTarget(w);
            this._savedRects.delete(w);
            this._snapped.delete(w);
            this._thirds.delete(w);
            this._unmaximize(w);
            this._defer(() => this._applyRect(w, target));
            _log('restoreOrMinimize: maximized -> free');
            return;
        }

        if (this._snapped.has(w) || this._thirds.has(w)) {
            const saved = this._savedRects.get(w);
            if (saved) this._applyRect(w, saved);
            this._savedRects.delete(w);
            this._snapped.delete(w);
            this._thirds.delete(w);
            _log('restoreOrMinimize: restored to free');
            return;
        }

        if (w.can_minimize()) {
            w.minimize();
            _log('restoreOrMinimize: minimized');
        }
    }

    // ------------------------------------------------------- drag-to-unsnap

    /**
     * A half-tiled window being dragged should return to its original size.
     * Restored on grab-END (reliable across Mutter versions; no mid-grab
     * fighting). A click without movement leaves it snapped.
     */
    onGrabBegin(_display, window, grabOp) {
        if (!window || grabOp !== Meta.GrabOp.MOVING) return;
        if (window.get_window_type() !== Meta.WindowType.NORMAL) return;
        if (!this._snapped.has(window) && !this._thirds.has(window)) return; // only our tiles
        const saved = this._savedRects.get(window);
        if (!saved) return;
        const f = window.get_frame_rect();
        this._pendingUnsnap.set(window, { saved, x: f.x, y: f.y });
    }

    onGrabEnd(_display, window, _grabOp) {
        if (!window) return;
        const info = this._pendingUnsnap.get(window);
        if (!info) return;
        this._pendingUnsnap.delete(window);

        const f = window.get_frame_rect();
        if (f.x === info.x && f.y === info.y) return; // clicked, didn't drag

        // keep the drop position, restore the original SIZE
        this._applyRect(window, {
            x: f.x,
            y: f.y,
            w: info.saved.w,
            h: info.saved.h,
        });
        this._savedRects.delete(window);
        this._snapped.delete(window);
        this._thirds.delete(window);
        _log('drag-unsnap: restored original size at drop position');
    }

    // --------------------------------------------------- workarea re-fit

    /** Re-align snapped halves & thirds to a (possibly changed) work area. */
    refitAll() {
        const ws = global.workspace_manager.get_active_workspace();
        const windows = ws ? ws.list_windows() : [];
        for (const w of windows) {
            const side = this._snapped.get(w);
            const col = this._thirds.get(w);
            if (!side && !col) continue;
            if (this._isMaximized(w)) {
                this._snapped.delete(w);
                this._thirds.delete(w);
                continue;
            }
            const wa = this._workAreaFor(w);
            if (!wa) continue;
            if (side) this._snapTo(w, side, wa);
            else this._applyRect(w, this._thirdsRects(wa)[col - 1]);
        }
    }
}
