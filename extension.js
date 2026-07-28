/* -*- mode: js; indent-tabs-mode: nil; -*-
 * Dead Simple Tiling — extension.js (entry point)
 *
 * Lifecycle + signal wiring only. The real work lives in snap.js (actions) and
 * keybindings.js (shortcuts + native override).
 *
 *   Super+Left / Super+Right  -> snap to half; traverse monitors at the edge
 *   Super+Up                  -> maximize (no-op if already maximized)
 *   Super+Down                -> restore (un-snap/un-maximize) or minimize
 */

import { Extension } from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import Snap from './snap.js';
import Keybindings from './keybindings.js';

export default class DSTilingExtension extends Extension {
    enable() {
        this._signals = [];

        this._snap = new Snap();
        this._kb = new Keybindings(this.getSettings(), this._snap);
        this._kb.enable();

        // Drag-to-unsnap: restore a snapped window's original size when dragged.
        this._connect(global.display, 'grab-op-begin', (d, w, op) =>
            this._snap.onGrabBegin(d, w, op)
        );
        this._connect(global.display, 'grab-op-end', (d, w, op) =>
            this._snap.onGrabEnd(d, w, op)
        );

        // Keep snapped halves aligned when the work area changes (panel/dock).
        this._connect(global.display, 'workareas-changed', () =>
            this._snap.refitAll()
        );

        console.log('[DSTiling] enabled');
    }

    disable() {
        this._disconnectAll();
        if (this._kb) {
            this._kb.disable();
            this._kb = null;
        }
        if (this._snap) {
            this._snap.destroy();
            this._snap = null;
        }
        this._signals = null;
        console.log('[DSTiling] disabled');
    }

    // ------------------------------------------------------ signal helpers

    _connect(obj, signal, callback) {
        const id = obj.connect(signal, callback);
        this._signals.push([obj, id]);
    }

    _disconnectAll() {
        if (!this._signals) return;
        for (const [obj, id] of this._signals) {
            try {
                obj.disconnect(id);
            } catch (e) {
                // already disconnected; ignore
            }
        }
        this._signals = [];
    }
}
