/* -*- mode: js; indent-tabs-mode: nil; -*-
 * Dead Simple Tiling — keybindings.js
 *
 * Registers our 4 keyboard shortcuts and neutralizes the native GNOME
 * keybindings that would otherwise compete for Super+Arrows.
 *
 * Crash-safety is a hard requirement (the reference project left users with
 * permanently broken shortcuts on crash). So every native key we touch is:
 *   - backed up to the `native-backup` gschema key (persisted JSON), and
 *   - restored on disable, OR on the next enable if we crashed last time.
 */

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Meta from 'gi://Meta';
import Shell from 'gi://Shell';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

// Off by default — GNOME rejects extensions that log excessively (review
// guideline: "No excessive logging"). Enable for a dev session by exporting
// DSTILING_DEBUG=1 before starting GNOME Shell (see snap.js for the command).
const DEBUG = GLib.getenv('DSTILING_DEBUG') === '1';

function _log(...args) {
    if (DEBUG) console.log('[DSTiling]', ...args);
}

// Native GNOME settings we neutralize so our shortcuts always win.
// (edge-tiling disables GNOME's drag-to-edge half-snap; we own snapping.)
const NATIVE_OVERRIDES = [
    { schemaId: 'org.gnome.mutter.keybindings', key: 'toggle-tiled-left' },
    { schemaId: 'org.gnome.mutter.keybindings', key: 'toggle-tiled-right' },
    { schemaId: 'org.gnome.desktop.wm.keybindings', key: 'maximize' },
    { schemaId: 'org.gnome.desktop.wm.keybindings', key: 'unmaximize' },
    // Super+Alt+Left/Right (native: switch workspace) -> our thirds walk
    {
        schemaId: 'org.gnome.desktop.wm.keybindings',
        key: 'switch-to-workspace-left',
    },
    {
        schemaId: 'org.gnome.desktop.wm.keybindings',
        key: 'switch-to-workspace-right',
    },
    { schemaId: 'org.gnome.mutter', key: 'edge-tiling' },
];

function _neutralValue(key) {
    return key === 'edge-tiling'
        ? new GLib.Variant('b', false)
        : new GLib.Variant('as', []);
}

export default class Keybindings {
    /**
     * @param {Gio.Settings} settings our extension's settings (has the 4 keys)
     * @param {object} snap the Snap instance whose action methods we call
     */
    constructor(settings, snap) {
        this._settings = settings;
        this._snap = snap;
        this._names = [
            'snap-left',
            'snap-right',
            'snap-third-left',
            'snap-third-right',
            'toggle-maximize',
            'restore-minimize',
        ];
        /** persisted backup: { "schemaId/key": "<GVariant print(true)>" } */
        this._backup = {};
    }

    enable() {
        this._restoreNatives(); // (1) undo leftovers from a possible crash
        this._overrideNatives(); // (2) back up the real values, then neutralize
        this._register(); // (3) install our 4 shortcuts
        _log('enabled');
    }

    disable() {
        this._unregister();
        this._restoreNatives();
        this._settings.set_string('native-backup', '');
        _log('disabled (native shortcuts restored)');
    }

    // ----------------------------------------------------------- backup I/O

    _loadBackup() {
        const raw = this._settings.get_string('native-backup');
        if (!raw) return {};
        try {
            return JSON.parse(raw);
        } catch (e) {
            _log('native-backup was corrupt, ignoring', e);
            return {};
        }
    }

    _saveBackup() {
        this._settings.set_string(
            'native-backup',
            JSON.stringify(this._backup)
        );
    }

    _id(o) {
        return o.schemaId + '/' + o.key;
    }

    // ---------------------------------------------------- native overrides

    /** Restore every backed-up native key to its original value. */
    _restoreNatives() {
        this._backup = this._loadBackup();
        for (const o of NATIVE_OVERRIDES) {
            const str = this._backup[this._id(o)];
            if (str === undefined) continue;
            try {
                const s = new Gio.Settings({ schema_id: o.schemaId });
                s.set_value(o.key, GLib.Variant.parse(null, str, null, null));
            } catch (e) {
                _log('failed to restore', o.key, e);
            }
        }
    }

    /**
     * Back up each native key's CURRENT value (the true original) and then set
     * it to a neutral value so it no longer fires. Because _restoreNatives ran
     * first, "current" is guaranteed to be the original even after a crash.
     */
    _overrideNatives() {
        this._backup = {};
        for (const o of NATIVE_OVERRIDES) {
            try {
                const s = new Gio.Settings({ schema_id: o.schemaId });
                this._backup[this._id(o)] = s.get_value(o.key).print(true);
                s.set_value(o.key, _neutralValue(o.key));
            } catch (e) {
                _log('failed to override', o.key, e);
            }
        }
        this._saveBackup();
    }

    // --------------------------------------------------------- our bindings

    _register() {
        const add = (name, fn) =>
            Main.wm.addKeybinding(
                name,
                this._settings,
                Meta.KeyBindingFlags.NONE,
                Shell.ActionMode.NORMAL,
                fn
            );
        add('snap-left', () => this._snap.snapLeft());
        add('snap-right', () => this._snap.snapRight());
        add('snap-third-left', () => this._snap.snapThirdLeft());
        add('snap-third-right', () => this._snap.snapThirdRight());
        add('toggle-maximize', () => this._snap.toggleMaximize());
        add('restore-minimize', () => this._snap.restoreOrMinimize());
    }

    _unregister() {
        for (const name of this._names) {
            try {
                Main.wm.removeKeybinding(name);
            } catch (e) {
                _log('could not remove', name);
            }
        }
    }
}
