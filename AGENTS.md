# AGENTS.md — omarchy-recent-paths

Maintenance notes for anyone (agent or human) editing this repo. The plugin is
built and working; this file covers what is *not* obvious from the code.
User-facing docs — install, keys, settings, IPC — live in `README.md`. Don't
duplicate them here.

## What it is

**Omarchy Recent Paths** (`shilai_li.recent-paths`) — a bar glyph that opens a
list of recently used directories and reopens one in a terminal or the file
manager. QML running inside the already-running `omarchy-shell` Quickshell
process. One kind: `bar-widget`.

Non-negotiables:

- **No Electron, no second Quickshell, no bundled runtime.**
- **No index, no daemon, no cache.** zoxide is the database; this reads it.
  If a feature needs its own store of paths, it is the wrong feature.
- **No accounts, no network, no telemetry.** One local JSON file, holding pins
  and nothing else.
- **Keyboard-driven.** Every action has a key; the mouse is optional.
- **Themed, never styled.** Zero hex literals, zero raw pixel sizes — only
  `Commons.Color.*` and `Style.*`, so `omarchy theme set` repaints the plugin.
- **Minimal is the feature.** v1 deliberately has no project detection, no git
  status, no fuzzy search, no per-path commands, no calibration. Ask before
  adding a surface, a kind, or a setting.

## Layout

```
manifest.json      one kind; barWidget.schema mirrors every setting
BarWidget.qml      bar glyph; owns the scan, the pin file, IPC, and both launches
Panel.qml          the list (loaded via Loader, NOT a declared kind)
Model.js           pure logic: limits, child env + argv, the scripts, paths, merge, pins
test/model-test.sh unit tests for Model.js — plain node, no compositor
```

`Model.js` stays **Qt- and locale-free** so it runs under `node`. Anything
needing a QML type, a theme color or a process belongs in the `.qml`. Add a
test alongside any logic you add there.

## Ground truth — read it, don't guess

| What | Path |
|---|---|
| Shell source / UI kit / theme singletons | `/usr/share/omarchy/shell/{,Ui/,Commons/}` |
| Plugin contract + IPC table | `/usr/share/omarchy/shell/README.md` |
| Bar host (`bar.*` API) | `/usr/share/omarchy/shell/plugins/bar/Bar.qml` |
| Closest structural reference | `~/.config/omarchy/plugins/shilai_li.eye-break/` |
| Row/cursor idiom for lists | `shell/plugins/panels/bluetooth/Panel.qml` |
| How Omarchy launches a terminal | `/usr/share/omarchy/bin/omarchy-launch-terminal` |
| Installed copy / user config | `~/.config/omarchy/plugins/<id>/`, `~/.config/omarchy/shell.json` |

## Architecture invariants

**One process per open, and only while the panel is open.** `Model.scanScript`
stats the pins, checks for zoxide, and filters its top `SCAN_DEPTH` entries in
a single `bash` run. The list is only ever looked at while the panel is on
screen, so that is the only time it is built — no timer, no watcher, no
`FileView` on zoxide's database. Adding a background refresh would buy a
freshness nobody can observe and cost a fork per tick, per monitor.

**Every path is data, never source.** Paths reach the scan and both launchers
as positional arguments (`/usr/bin/bash -c '<script>' $0 "$@"`), which bash
expands without re-tokenizing. Never interpolate a path into a command string —
a directory can legally be named `$(rm -rf ~)`, and zoxide will happily list
it. The **only** thing spliced into script source is the trusted bin-dir list,
and `Model.safeBinDirs` checks its shape first.

**Every child is on a short leash.** A plugin runs inside the shell process,
with its privileges and the session's whole environment, so `Model.js`'s
"children" section fixes all three ways in: a fixed interpreter path
(`Model.BASH`), `-c` rather than `-lc` so no startup file is sourced, and
`Model.childEnvironment` building the environment from an allowlist over a
fixed `PATH` instead of inheriting one. Helpers are found by `find_bin`, which
only ever looks in `Model.TRUSTED_BIN_DIRS`. Adding a child means adding it
there too — never `Util.execDetached`, which is `bash -lc` with the session's
environment.

**Every scan has a deadline and a generation.** `Model.scanCommand` puts
`timeout` in front of bash, so the whole pipeline dies as a process group
rather than holding a pipe forever; `scanDeadline`/`scanKill` in the widget are
the backstop for `timeout` itself wedging, and `Component.onDestruction` makes
sure nothing outlives the widget. Output is applied only when the run's
`generation` still matches `root.scanGeneration` **and** it exited zero — a
late or failed answer is not a current one, and `scanFailed` says so on screen
rather than passing it off as an empty list.

**Everything that crosses a boundary is bounded first.** The state file, the
scan's output and the pin argv all have caps in `Model.js`'s "limits" section,
applied before anything is allocated, parsed or passed to a child. `cappedPins`
is applied on read, on write and on the way into argv, so no single call site
has to be the one that remembers.

**The state directory is checked, not assumed.** `Model.stateDirScript` creates
it `0700` and then vouches for it — real directory, not a symlink, ours, with
the file inside it the same — and `stateReady` gates the `FileView` path and
`togglePin`. If it cannot be vouched for, the panel still lists directories; it
just has no pins. `onSaveFailed` reloads rather than leaving a pin on screen
that nothing on disk backs.

**Existence is re-checked, never remembered.** The scan is the only thing that
may claim a directory exists. `filterKnown` re-derives the visible pins from
what the *last* scan proved, which is why toggling a pin reorders the list on
the keystroke without a new stat.

**A missing pin is hidden, not forgotten.** `pins` (the file) and
`existingPins` (what the scan found) are separate on purpose. An unmounted
drive must not cost the user a pin.

**Missing zoxide is reported, never inferred.** The scan prints an explicit
`E<TAB>zoxide` line, because "no output" also happens on an empty database and
the two need different messages. `Model.emptyMessage` distinguishes four
states: not scanned yet, the scan itself failed, no zoxide, scanned and empty.

**The panel owns the cursor and nothing else.** Every path, pin and launch
lives on `BarWidget.qml`; the panel is a read-out that calls back into it. A
bar surface exists per monitor, so anything the panel owned would be state two
monitors could disagree about. Pins go through the state file, whose
`FileView { watchChanges: true }` fans the change out for free.

**One highlight on screen.** Rows paint from `CursorSurface.hasCursor`, never
from `containsMouse`; hover moves the same `selectedIndex` the arrows do.

**Bar-widget shape contract.** `Bar.findPanelWidget` routes `summon`/`hide`/
`toggle` by looking for `opened`, `open()`, `close()`, `toggle()`,
`closeForPopoutSwitch()` and `popoutSwitchClosing` on the widget **root** — all
forward to the loaded panel. The panel is injected with `bar`, `settings`,
`anchorItem`, `hostWidget`; `KeyboardPanel.owner` must be `hostWidget || root`,
because the bar identifies panels by the widget in its slot.

**`bar` is a facade, not the Bar.** What gets injected is a `PluginBarApi`
(`shell/Ui/PluginBarApi.qml`): presentation state mirrored as plain properties,
operations delegated through scoped callbacks. First-party panels get the real
`Bar.qml` and can write its properties; a plugin cannot. Anything shared and
mutable is exposed there **readonly** with a `setX()` beside it —
`centerHoverRevealSuppressed` / `setCenterHoverRevealSuppressed()` is the one
this plugin touches. Assigning to a readonly QML property throws a `TypeError`
rather than failing quietly, and the throw takes out the rest of the calling
function, so **call the setter and feature-test it with `typeof … ===
"function"`**, never `"name" in bar` — the `in` check passes on a readonly
property and tells you nothing.

**Closing may not depend on anything.** `close()` hides first and does the
cosmetic work after. The panel is a full-screen layer-shell surface holding
keyboard focus: anything that throws ahead of `controller.hide()` strands the
user behind a surface that eats every key and click, including the escape and
the outside-click that would have dismissed it, and the bar reads as frozen.
Omarchy 4.0.3 turned `centerHoverRevealSuppressed` readonly and did exactly
that. Order the function so the release is unconditional.

## Style rules

| Do | Don't |
|---|---|
| `Commons.Color.foreground/.accent/.popups.*` (`import qs.Commons as Commons`) | any hex literal, or a bare `Color.*` |
| `Style.space(12)`, `Style.font.caption…body` | raw pixels, `pixelSize: 14` |
| `Style.cornerRadius` (may be `0`), `CursorSurface` | always-rounded, hand-rolled hover fills |
| `bar ? bar.foreground : Commons.Color.foreground` | assuming `bar` is set at construction |

A bare `Color.foreground` does not fail at load: Qt 6.12's own `Color` type
shadows the palette, the read comes back `undefined`, and the paint goes black
or throws on every frame. Always read the palette through `Commons.Color`.

Comment *why*, not *what*, in full sentences — match the shell's habit of a
few lines above a block explaining the trade-off.

`PanelKeyCatcher` consumes keys before `onTextKey` sees them: `h j k l` are
movement, `x` is delete, `space`/`enter` activate, `esc` closes, `tab`
switches panels. New bindings can't use those — `f`, `p` and `r` are free,
which is why they are the ones bound.

## Dev workflow

```bash
cp -r . ~/.config/omarchy/plugins/shilai_li.recent-paths   # no symlinks; validator rejects them
omarchy plugin validate ~/.config/omarchy/plugins/shilai_li.recent-paths

# Bare `qmllint` here is a Qt5-era build that chokes on typed QML functions
# and exits 255 silently. Use the Qt6 binary explicitly.
QT_FORCE_STDERR_LOGGING=1 /usr/lib/qt6/bin/qmllint -I /usr/share/omarchy/shell BarWidget.qml
/usr/lib/qt6/bin/qmlformat BarWidget.qml > /dev/null    # pure syntax gate

bash test/model-test.sh
omarchy-shell shilai_li.recent-paths status             # JSON smoke test
```

Saving under `~/.config/omarchy/plugins/` hot-reloads QML — the edit loop is
save → open the panel. **Two things do not hot-reload:** an already-bound
`IpcHandler` target (the first handler owns it for the life of the shell
process, so a new IPC method or `status` field keeps answering with the old
code), and `Model.js`, whose imported copy stays cached. Both need
`omarchy-restart-shell`.

**Reading qmllint output:** `qs.Commons` / `qs.Ui` can't resolve outside
Quickshell, so every file emits a cascade of `[import]`, `[unqualified]`,
`[unresolved-type]`, `[missing-property]`, `[required]`,
`[signal-handler-parameters]`, `[inheritance-cycle]`. That is noise — the
shipped built-ins emit the same. Compare *categories* against a built-in, not
counts; a category yours emits that theirs doesn't is worth chasing.

Shell-side errors go to the `omarchy-shell` journal — check there first when a
widget silently fails to appear.

## Rules for agents

1. Read the real file before writing. The eye-break plugin answers most
   "how do I…" for the bar-widget-plus-panel shape.
2. No new dependencies. QML + Quickshell + the shell's singletons + zoxide.
3. Plugins run unsandboxed. Write nothing outside
   `~/.local/state/omarchy/recent-paths/` and the widget's `shell.json` entry.
   No network, no `sudo`, ever. Nothing here may *modify* zoxide's database;
   this plugin reads it.
4. Keep settings mirrored in three places: `setting()` reads, `Model` clamps,
   and `manifest.json`'s `barWidget.schema`.
5. Before declaring done: `omarchy plugin validate` clean, qmllint categories
   match a built-in, `bash test/model-test.sh` green, panel opens and closes,
   `enter` lands a terminal in the right directory, `f` lands the file
   manager there, a pin survives a shell restart.
