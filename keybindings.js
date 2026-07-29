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

import Gio from "gi://Gio";
import GLib from "gi://GLib";
import Meta from "gi://Meta";
import Shell from "gi://Shell";
import * as Main from "resource:///org/gnome/shell/ui/main.js";

// Off by default — GNOME rejects extensions that log excessively (review
// guideline: "No excessive logging"). Enable for a dev session by exporting
// DSTILING_DEBUG=1 before starting GNOME Shell (see snap.js for the command).
const DEBUG = GLib.getenv("DSTILING_DEBUG") === "1";

function _log(...args) {
  if (DEBUG) console.log("[DSTiling]", ...args);
}

// Native GNOME settings we neutralize so our shortcuts always win.
// (edge-tiling disables GNOME's drag-to-edge half-snap; we own snapping.)
const NATIVE_OVERRIDES = [
  { schemaId: "org.gnome.mutter.keybindings", key: "toggle-tiled-left" },
  { schemaId: "org.gnome.mutter.keybindings", key: "toggle-tiled-right" },
  { schemaId: "org.gnome.desktop.wm.keybindings", key: "maximize" },
  { schemaId: "org.gnome.desktop.wm.keybindings", key: "unmaximize" },
  // The native switch-workspace keys default to <Super><Alt>Left/Right — the
  // very combo our thirds-walk (snap-third-left/right) needs. But these keys
  // hold a *list* of accelerators, and a user may keep unrelated bindings on
  // them (e.g. <Ctrl><Alt>Left). So instead of blanking the whole list to []
  // (which would also nuke the user's binding), we strip ONLY the conflicting
  // <Super><Alt>Left/Right entry and preserve the rest. See _neutralValue().
  {
    schemaId: "org.gnome.desktop.wm.keybindings",
    key: "switch-to-workspace-left",
    conflicts: ["<Super><Alt>Left"],
  },
  {
    schemaId: "org.gnome.desktop.wm.keybindings",
    key: "switch-to-workspace-right",
    conflicts: ["<Super><Alt>Right"],
  },
  { schemaId: "org.gnome.mutter", key: "edge-tiling" },
];

// Canonicalize a GTK/GSettings accelerator string so equivalent spellings
// compare equal: modifier tokens are sorted, and the Ctrl synonyms
// (<Primary>/<Control>/<Ctrl>) collapse to one. This lets us match a stored
// binding like '<Ctrl><Alt>Left' against our target regardless of which synonym
// or modifier order GNOME/gsettings happened to write.
function _normalizeAccel(accel) {
  if (typeof accel !== "string" || accel.length === 0) return "";
  const mods = [];
  const key = accel
    .toLowerCase()
    .replace(/<[^>]+>/g, (token) => {
      let t = token.slice(1, -1);
      if (t === "control" || t === "ctrl") t = "primary";
      mods.push(t);
      return "";
    })
    .trim();
  mods.sort();
  return mods.map((m) => `<${m}>`).join("") + key;
}

/**
 * Compute the value to write while we're active.
 *  - edge-tiling: a hard off (we own edge-snapping).
 *  - keys we fully own (no `conflicts`): a hard empty list.
 *  - "partial conflict" keys: strip ONLY the accelerators listed in
 *    `o.conflicts` and preserve any unrelated binding the user keeps (e.g.
 *    <Ctrl><Alt>Left on the switch-workspace keys). Backing up still stores the
 *    FULL original, so disable() restores it verbatim.
 */
function _neutralValue(settings, o) {
  if (o.key === "edge-tiling") return new GLib.Variant("b", false);
  if (!o.conflicts || o.conflicts.length === 0) return new GLib.Variant("as", []);

  const strip = new Set(o.conflicts.map(_normalizeAccel));
  const kept = settings.get_strv(o.key).filter((a) => !strip.has(_normalizeAccel(a)));
  return new GLib.Variant("as", kept);
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
      "snap-left",
      "snap-right",
      "snap-third-left",
      "snap-third-right",
      "toggle-maximize",
      "restore-minimize",
    ];
    /** persisted backup: { "schemaId/key": "<GVariant print(true)>" } */
    this._backup = {};
  }

  enable() {
    this._restoreNatives(); // (1) undo leftovers from a possible crash
    this._overrideNatives(); // (2) back up the real values, then neutralize
    this._register(); // (3) install our 4 shortcuts
    _log("enabled");
  }

  disable() {
    this._unregister();
    this._restoreNatives();
    this._settings.set_string("native-backup", "");
    _log("disabled (native shortcuts restored)");
  }

  // ----------------------------------------------------------- backup I/O

  _loadBackup() {
    const raw = this._settings.get_string("native-backup");
    if (!raw) return {};
    try {
      return JSON.parse(raw);
    } catch (e) {
      _log("native-backup was corrupt, ignoring", e);
      return {};
    }
  }

  _saveBackup() {
    this._settings.set_string("native-backup", JSON.stringify(this._backup));
  }

  _id(o) {
    return o.schemaId + "/" + o.key;
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
        _log("failed to restore", o.key, e);
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
        s.set_value(o.key, _neutralValue(s, o));
      } catch (e) {
        _log("failed to override", o.key, e);
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
        fn,
      );
    add("snap-left", () => this._snap.snapLeft());
    add("snap-right", () => this._snap.snapRight());
    add("snap-third-left", () => this._snap.snapThirdLeft());
    add("snap-third-right", () => this._snap.snapThirdRight());
    add("toggle-maximize", () => this._snap.toggleMaximize());
    add("restore-minimize", () => this._snap.restoreOrMinimize());
  }

  _unregister() {
    for (const name of this._names) {
      try {
        Main.wm.removeKeybinding(name);
      } catch (e) {
        _log("could not remove", name);
      }
    }
  }
}
