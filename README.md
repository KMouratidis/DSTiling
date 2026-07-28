# Dead Simple Tiling (DSTiling)

> **DISCLAIMER**: Except this comment, _everything_ in this repository is
> AI slop. I only tested the behavior on my PC and a VM and it seemed good
> enough to me. I did glance at the code after GLM-5.2 generated it, but I'm
> sure it will still crash your PC, burn your house, claim your firstborn, and
> eat all your pizza. You are free to open issues and PRs, and they may or may
> not be looked at / appreciated / accepted / ..., so I'm releasing this under
> MIT license, just in case you don't want to deal with a pretentious a$$hole.
> If you have an issue with any of that, all the power to you, enjoy one of the
> tens of other extensions or make your own!

A minimal GNOME Shell extension that gives **Windows-style window snapping** — and
nothing else. No animations, no options, no layouts, no menus. Just correct
behavior.

## Shortcuts (fixed, not configurable)

| Shortcut                   | Action                                                                                                                                                                 |
| -------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Super + Left/Right`       | Snap to the left/right half of the current monitor. If already on that edge, jump to the opposite half of the **neighboring monitor** (A‑B‑C traversal).               |
| `Super + Alt + Left/Right` | Snap into **thirds** — walk one column (1↔2↔3) of the current monitor; at the edge, cross to column 3/1 of the neighboring monitor. Overrides native workspace-switch. |
| `Super + Up`               | Maximize. No-op if already maximized.                                                                                                                                  |
| `Super + Down`             | Restore (un‑snap / un‑maximize to original size), or **minimize** if already free. Repeated presses: maximized → restored → minimized.                                 |
| Drag a snapped window      | Returns it to its original size (Windows "unsnap").                                                                                                                    |

## How it works (why it shouldn't be buggy)

- Each window's snap state — left/right half, or third column (1/2/3) — is
  **tracked in `WeakMap`s**, updated on every transition we perform. Tracking it
  (rather than re-deriving from an exact geometry match) keeps behavior correct
  even if you manually resize a snapped window: `Super+Down` still restores it
  instead of minimizing. **Maximized** is read straight from the window's own
  flags, so it can never drift.
- The only other thing stored is each window's **original pre-snap size** (in a
  `WeakMap`, auto-cleaned when the window closes), used to restore it.
- All native GNOME shortcuts we override are **backed up** and restored on
  disable — even after a Shell crash (via a persisted `native-backup` key).

## Requirements

- GNOME Shell **45+** (plain JavaScript ESM, no build step for the code).
- `glib-compile-schemas` (from `glib2-devel` / GNOME SDK) — only to compile the
  settings schema.

## Install

```bash
cd DSTiling
make install          # copies into ~/.local/share/gnome-shell/extensions/ and compiles schemas
```

Then restart GNOME Shell:

- **Wayland (default on Bazzite):** log out and back in (or `loginctl terminate-session`).
- **X11:** `Alt+F2` → `r` → Enter.

Enable it via _Extensions_ app, or:

```bash
gnome-extensions enable dstiling@kmouratidis.com
```

## Develop / package

```bash
make schemas          # compile schemas only
make package          # build a zip (excludes the compiled schema, per GNOME convention)
make clean            # remove build artifacts
```

Tail the logs while testing:

```bash
journalctl -f /usr/bin/gnome-shell | grep DSTiling
```

## Files

- [`extension.js`](extension.js) — lifecycle + signal wiring
- [`snap.js`](snap.js) — geometry + snap / maximize / restore / minimize logic
- [`keybindings.js`](keybindings.js) — shortcut registration + native override/restore
- (no prefs.js — there are no options to configure)
- [`schemas/`](schemas/) — GSettings schema (keybinding keys + crash-safe backup)
- [`PLAN.md`](PLAN.md) — full design document

## Limitations (by design)

No quarter/corner tiling, no vertical halves, no gaps, no focus switching.
Fullscreen windows are ignored (use `F11`).
