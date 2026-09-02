// Pure path bookkeeping for the recent-paths plugin.
//
// Deliberately Qt- and locale-free so test/model-test.sh can run the whole
// file under plain node, with no compositor and no shell. Everything here is
// a transform over strings and arrays: the scan output goes in, the rows the
// panel paints come out. Anything that needs a QML type, a theme color or a
// process belongs in the .qml files.

// The panel is a shortcut list, not a file browser. Ten is enough to be
// useful; past twenty nobody is reading the list any more, they are
// searching it — and searching is what zoxide itself is for.
var MIN_LIMIT = 10
var MAX_LIMIT = 20
var DEFAULT_LIMIT = 15

// How far down zoxide's ranking the scan is willing to look. Every candidate
// past this point costs a stat and could not be shown anyway, since the
// display cap is MAX_LIMIT.
var SCAN_DEPTH = 200

var PIN_GLYPH = "★"

// ------------------------------------------------------------------- limits
//
// Everything that crosses a boundary — a file on disk, a pipe from a child, an
// argv — is bounded before it is allocated, parsed or passed on. The state
// file is the user's own, but "the user's own" includes "corrupt", "written by
// something else" and "grown without anyone noticing", and a bar widget that
// runs inside the shell process has no memory of its own to spare.

// PATH_MAX on Linux. A longer string is not a path anything could open.
var MAX_PATH_LENGTH = 4096

// Pins are added one keystroke at a time and only twenty rows are ever shown.
// A hundred is far past generous and still a small, fixed argv.
var MAX_PINS = 100

// MAX_PINS paths at PATH_MAX each, plus JSON overhead, rounded up.
var MAX_STATE_BYTES = 512 * 1024

// The scan's own output is bounded by the script — the pins, then at most
// SCAN_DEPTH rows — so these caps only ever fire on output that did not come
// from the script we sent.
var MAX_SCAN_BYTES = 2 * 1024 * 1024
var MAX_SCAN_LINES = 8192

// ----------------------------------------------------------------- children
//
// Every child this plugin starts is pinned down three ways, because a bar
// widget lives inside the shell process and inherits a whole desktop session's
// environment: a fixed interpreter path, a non-login non-interactive shell so
// that no startup file is ever sourced, and an environment built from scratch
// rather than inherited. Data — a directory name — is always a positional
// parameter, never text spliced into the source.

var BASH = "/usr/bin/bash"

// The only directories a helper is looked for in. Resolving against these
// rather than $PATH means nothing the session exported can point the scan or a
// launch at a different binary.
var TRUSTED_BIN_DIRS = ["/usr/local/bin", "/usr/bin"]

var TIMEOUT = "/usr/bin/timeout"

// One end-to-end deadline, imposed from outside the script. `timeout` runs the
// command in its own process group and signals the group, so a wedged zoxide
// or a stat blocked on a dead NFS mount takes the whole pipeline with it
// rather than leaving the widget waiting on a pipe forever.
var SCAN_TIMEOUT_SECONDS = 5
var STATE_TIMEOUT_SECONDS = 5
var KILL_GRACE_SECONDS = 1

var TERMINAL_TOOL = "xdg-terminal-exec"
var OPEN_TOOL = "xdg-open"

// The session variables a graphical child genuinely needs in order to find the
// compositor, the bus and the user's own configuration. Everything else the
// shell process inherited stops here.
var LAUNCH_ENV_KEYS = [
  "HOME", "USER", "LOGNAME", "LANG", "TERMINAL",
  "XDG_RUNTIME_DIR", "XDG_SESSION_ID", "XDG_SESSION_TYPE", "XDG_SESSION_CLASS",
  "XDG_SESSION_DESKTOP", "XDG_CURRENT_DESKTOP", "XDG_MENU_PREFIX",
  "XDG_CONFIG_HOME", "XDG_CONFIG_DIRS", "XDG_DATA_HOME", "XDG_DATA_DIRS",
  "XDG_CACHE_HOME", "XDG_STATE_HOME",
  "WAYLAND_DISPLAY", "DISPLAY", "DBUS_SESSION_BUS_ADDRESS",
  "HYPRLAND_INSTANCE_SIGNATURE"
]

// The scan talks to no one. It has to find zoxide's database and nothing else,
// and zoxide locates that from these three.
var SCAN_ENV_KEYS = ["HOME", "XDG_DATA_HOME", "_ZO_DATA_DIR"]

// Never passed to a child whatever an allowlist above says, because each one
// makes some program run code before it runs itself. The allowlists already
// exclude them; this is the check that keeps a later edit to those lists from
// quietly reopening the hole.
var ENV_HOOKS = [
  "ENV", "BASH_ENV", "SHELLOPTS", "BASHOPTS", "PS4", "IFS",
  "GLIBC_TUNABLES", "PERL5OPT", "PERL5LIB", "PYTHONSTARTUP", "PYTHONPATH",
  "NODE_OPTIONS", "GTK_MODULES", "GIO_EXTRA_MODULES", "QT_PLUGIN_PATH"
]

function isEnvHook(name) {
  var n = String(name === undefined || name === null ? "" : name)
  // Exported shell functions arrive as BASH_FUNC_name%%, and the dynamic
  // loader takes its orders from anything beginning LD_.
  if (n.indexOf("BASH_FUNC_") === 0 || n.indexOf("LD_") === 0) return true
  for (var i = 0; i < ENV_HOOKS.length; i++) {
    if (ENV_HOOKS[i] === n) return true
  }
  return false
}

// The child's whole environment, built from nothing: a fixed PATH plus those
// allowlisted variables that are actually set. `lookup` is the only Qt-shaped
// thing here and it is passed in, so this stays testable under node.
function childEnvironment(keys, lookup) {
  var env = { PATH: TRUSTED_BIN_DIRS.join(":") }
  for (var i = 0; i < (keys ? keys.length : 0); i++) {
    var name = String(keys[i])
    if (name === "PATH" || isEnvHook(name)) continue
    var value = lookup ? lookup(name) : undefined
    if (value === undefined || value === null) continue
    value = String(value)
    if (!value || value.indexOf("\u0000") >= 0) continue
    env[name] = value
  }
  return env
}

// The directory list is the one thing that does get interpolated into script
// source, so it is checked rather than trusted: absolute, and made only of
// characters that cannot end a word or begin a substitution. Callers pass a
// list of their own only in tests; anything unusable falls back to the
// constant rather than producing a script with a hole in it.
function safeBinDirs(dirs) {
  var list = (dirs && dirs.length) ? dirs : TRUSTED_BIN_DIRS
  var out = []
  for (var i = 0; i < list.length; i++) {
    var d = String(list[i])
    if (/^\/[A-Za-z0-9_.\/-]*$/.test(d)) out.push(d)
  }
  return out.length > 0 ? out : TRUSTED_BIN_DIRS
}

// The fixed-directory lookup that stands in for `command -v`, shared by all
// three scripts.
function findBinFunction(binDirs) {
  return [
    'find_bin() {',
    '  for d in ' + safeBinDirs(binDirs).join(" ") + '; do',
    '    if [ -x "$d/$1" ]; then printf "%s" "$d/$1"; return 0; fi',
    '  done',
    '  return 1',
    '}'
  ].join("\n")
}

// ------------------------------------------------------------------ scripts

// One process answers the whole question: which pinned paths still exist,
// whether zoxide is installed, and which of its top entries are real
// directories. Doing it in one pass keeps the panel to a single fork per
// open instead of one stat per row.
function scanScript(depth, binDirs) {
  var n = clampInt(depth, 1, 5000, SCAN_DEPTH)
  return [
    'set -u',
    findBinFunction(binDirs),
    '',
    '# The pins arrive as positional parameters and are never interpolated into',
    '# this source: a directory can legally be named "$(rm -rf ~)", and zoxide',
    '# will happily list it.',
    'for p in "$@"; do [ -d "$p" ] && printf "P\\t%s\\n" "$p"; done',
    '',
    'zoxide=$(find_bin zoxide) || { printf "E\\tzoxide\\n"; exit 0; }',
    '',
    '# The row cap lives in the reader rather than in a `head` down the pipe:',
    '# one less child, and a database with a million entries still costs a',
    '# bounded number of stats and a bounded amount of output.',
    '"$zoxide" query -l 2>/dev/null | {',
    '  n=0',
    '  while IFS= read -r p; do',
    '    n=$((n + 1))',
    '    if [ "$n" -gt ' + n + ' ]; then break; fi',
    '    [ -d "$p" ] && printf "R\\t%s\\n" "$p"',
    '  done',
    '}',
    'exit 0'
  ].join("\n")
}

// Omarchy launches graphical children through uwsm-app so they land in the
// right systemd scope, but a plugin that only works on a uwsm session is a
// plugin that breaks for the next person. Fall back to a bare setsid, and to
// no wrapper at all if even that is missing.
function launchScript(binDirs) {
  return [
    'set -u',
    findBinFunction(binDirs),
    '',
    '# The tool name is a constant from this file; everything after it is user',
    '# data and stays a positional parameter the whole way down.',
    'exe=$(find_bin "$1") || exit 127',
    'shift',
    'set -- "$exe" "$@"',
    '',
    'if uwsm=$(find_bin uwsm-app); then set -- "$uwsm" -- "$@"; fi',
    'if setsid=$(find_bin setsid); then exec "$setsid" "$@"; fi',
    'exec "$@"'
  ].join("\n")
}

// The state directory is ours alone, and this is what says so: no symlink
// stands in for it or for the file inside it, both are ours, and the modes are
// put back the way we want them. Every component above the last is still an
// ordinary path lookup — QML has no openat — so this is a check, not a
// guarantee against a racing attacker who can already write inside $HOME.
function stateDirScript(binDirs) {
  return [
    'set -u',
    'umask 077',
    findBinFunction(binDirs),
    '',
    'dir=$1',
    'file=$2',
    '',
    'mkdirbin=$(find_bin mkdir) || exit 1',
    'chmodbin=$(find_bin chmod) || exit 1',
    '',
    '# A symlink where the directory or the file should be is not something to',
    '# follow: the write would land wherever it points.',
    'if [ -L "$dir" ] || [ -L "$file" ]; then exit 1; fi',
    '',
    'if [ ! -d "$dir" ]; then "$mkdirbin" -p -m 700 -- "$dir" || exit 1; fi',
    'if [ ! -d "$dir" ] || [ -L "$dir" ]; then exit 1; fi',
    '',
    '# Ours, and reachable by nobody else.',
    '[ -O "$dir" ] || exit 1',
    '"$chmodbin" 700 -- "$dir" || exit 1',
    '',
    'if [ -e "$file" ]; then',
    '  [ -f "$file" ] || exit 1',
    '  [ -O "$file" ] || exit 1',
    '  "$chmodbin" 600 -- "$file" || exit 1',
    'fi',
    '',
    'printf "OK\\n"',
    'exit 0'
  ].join("\n")
}

// ----------------------------------------------------------------- commands
//
// The argv each script is actually run with. Built here rather than in the
// .qml so the executable paths, the deadline and the argument cap are all
// visible in one place and checkable without a compositor.

function deadlineArgv(seconds) {
  return [TIMEOUT, "-k", String(KILL_GRACE_SECONDS), String(seconds)]
}

function scanCommand(pins, depth, binDirs) {
  return deadlineArgv(SCAN_TIMEOUT_SECONDS)
    .concat([BASH, "-c", scanScript(depth, binDirs), "recent-paths-scan"])
    .concat(cappedPins(pins))
}

function launchCommand(tool, args, binDirs) {
  var argv = [BASH, "-c", launchScript(binDirs), "recent-paths-launch", String(tool)]
  for (var i = 0; i < (args ? args.length : 0); i++) argv.push(String(args[i]))
  return argv
}

function stateDirCommand(dir, file, binDirs) {
  return deadlineArgv(STATE_TIMEOUT_SECONDS)
    .concat([BASH, "-c", stateDirScript(binDirs), "recent-paths-state",
             String(dir), String(file)])
}

// ----------------------------------------------------------------- settings

function clampInt(value, min, max, fallback) {
  // An absent key and a garbage one both mean "the user did not choose", and
  // Number(null) is 0 — which would silently clamp to the floor instead.
  if (value === undefined || value === null || value === "") return fallback
  var n = Number(value)
  if (!isFinite(n)) return fallback
  n = Math.round(n)
  return Math.max(min, Math.min(max, n))
}

function clampLimit(raw) { return clampInt(raw, MIN_LIMIT, MAX_LIMIT, DEFAULT_LIMIT) }

// -------------------------------------------------------------------- paths

// zoxide only ever stores absolute paths, so anything else in the scan output
// is a torn line or someone else's noise and is dropped rather than guessed
// at. Trailing slashes are stripped because "/tmp" and "/tmp/" are the same
// directory and would otherwise show up as two rows.
function normalizePath(raw) {
  if (raw === undefined || raw === null) return ""
  var p = String(raw)
  // Checked before the trim, so a megabyte of leading whitespace is refused
  // rather than walked.
  if (p.length > MAX_PATH_LENGTH) return ""
  p = p.replace(/^\s+|\s+$/g, "")
  if (p.charAt(0) !== "/") return ""
  // A tab or a newline inside a path would tear the scan's own line protocol,
  // and a NUL cannot survive being handed to a child at all. Spaces are
  // ordinary and stay.
  if (/[\t\n\r\u0000]/.test(p)) return ""
  while (p.length > 1 && p.charAt(p.length - 1) === "/") p = p.slice(0, -1)
  return p
}

// Key prefix so a directory literally named "__proto__" or "constructor"
// cannot collide with Object.prototype when used as a set member.
function seenKey(path) { return ":" + path }

function dedupe(list) {
  var seen = {}
  var out = []
  for (var i = 0; i < (list ? list.length : 0); i++) {
    var p = normalizePath(list[i])
    if (!p || seen[seenKey(p)]) continue
    seen[seenKey(p)] = true
    out.push(p)
  }
  return out
}

// The pin list as it is allowed to exist anywhere: in memory, in the file, and
// in an argv. Applied on read, on write and again on the way to the scan, so
// that no single one of those has to be the place that remembers.
function cappedPins(list) {
  return dedupe(list).slice(0, MAX_PINS)
}

function indexOfPath(rows, path) {
  var target = normalizePath(path)
  if (!target) return -1
  for (var i = 0; i < (rows ? rows.length : 0); i++) {
    if (rows[i] && rows[i].path === target) return i
  }
  return -1
}

function containsPath(list, path) {
  var target = normalizePath(path)
  if (!target) return false
  for (var i = 0; i < (list ? list.length : 0); i++) {
    if (normalizePath(list[i]) === target) return true
  }
  return false
}

// Keep only the paths that the last scan proved exist. Used when a pin is
// added or removed between scans: the list the user pinned from was itself
// existence-checked, so no new stat is needed to keep the panel honest.
function filterKnown(list, known) {
  var out = []
  var candidates = dedupe(list)
  for (var i = 0; i < candidates.length; i++) {
    if (containsPath(known, candidates[i])) out.push(candidates[i])
  }
  return out
}

// ---------------------------------------------------------------- scan output
//
// Three line kinds, tab-separated: P<TAB>path (a pin that exists), R<TAB>path
// (a zoxide entry that exists), E<TAB>zoxide (zoxide is not installed).

function parseScan(text) {
  var result = { pinned: [], recents: [], zoxideMissing: false }
  var raw = String(text === undefined || text === null ? "" : text)
  // Bounded before the split, which is where the allocation actually happens.
  // The script cannot produce this much; anything that does is not the script.
  if (raw.length > MAX_SCAN_BYTES) raw = raw.slice(0, MAX_SCAN_BYTES)
  var lines = raw.split("\n")
  var count = Math.min(lines.length, MAX_SCAN_LINES)

  for (var i = 0; i < count; i++) {
    var line = lines[i]
    var tab = line.indexOf("\t")
    if (tab < 0) continue

    var kind = line.slice(0, tab)
    if (kind === "E") {
      result.zoxideMissing = true
      continue
    }

    var path = normalizePath(line.slice(tab + 1))
    if (!path) continue
    if (kind === "P") result.pinned.push(path)
    else if (kind === "R") result.recents.push(path)
  }

  result.pinned = cappedPins(result.pinned)
  result.recents = dedupe(result.recents).slice(0, SCAN_DEPTH)
  return result
}

// ---------------------------------------------------------------------- rows
//
// Pins first in the order they were pinned, then zoxide's ranking with the
// pinned paths removed — a directory is one row or the other, never both.
function mergeRows(pinned, recents, limit) {
  var rows = []
  var seen = {}
  var pins = cappedPins(pinned)
  var i

  for (i = 0; i < pins.length; i++) {
    seen[seenKey(pins[i])] = true
    rows.push({ path: pins[i], pinned: true })
  }

  var rest = dedupe(recents)
  for (i = 0; i < rest.length; i++) {
    if (seen[seenKey(rest[i])]) continue
    rows.push({ path: rest[i], pinned: false })
  }

  return rows.slice(0, clampLimit(limit))
}

// ---------------------------------------------------------------------- pins

function isPinned(pinned, path) { return containsPath(pinned, path) }

// New pins go on the end, so pinning something does not reshuffle the pins
// already on screen. At MAX_PINS the list stops growing rather than the widget
// stopping work; unpinning still works, which is the way back out.
function togglePin(pinned, path) {
  var target = normalizePath(path)
  if (!target) return cappedPins(pinned)

  var current = cappedPins(pinned)
  var out = []
  var removed = false
  for (var i = 0; i < current.length; i++) {
    if (current[i] === target) removed = true
    else out.push(current[i])
  }
  if (!removed && out.length < MAX_PINS) out.push(target)
  return out
}

// The state file holds pins and nothing else. A torn or hand-mangled file
// costs the user their pins, not a working panel — and an oversized one costs
// neither, because it is refused before it is parsed.
function parsePinned(text) {
  var raw = String(text === undefined || text === null ? "" : text)
  if (raw.length > MAX_STATE_BYTES) return []
  try {
    var data = JSON.parse(raw)
    if (!data || typeof data !== "object" || !Array.isArray(data.pinned)) return []
    return cappedPins(data.pinned)
  } catch (e) {
    return []
  }
}

function serializePinned(pinned) {
  return JSON.stringify({ pinned: cappedPins(pinned) }, null, 2) + "\n"
}

// ------------------------------------------------------------------ display

// $HOME is where most of these live, and "~/Projects/thing" is both shorter
// and easier to recognise than the absolute path.
function displayPath(path, home) {
  var p = normalizePath(path)
  var h = normalizePath(home)
  if (!p) return ""
  if (!h) return p
  if (p === h) return "~"
  if (p.indexOf(h + "/") === 0) return "~" + p.slice(h.length)
  return p
}

// What the panel says instead of a list. Four different sentences, because
// "we have not looked yet", "the look failed", "there is no zoxide to ask" and
// "we looked and there is nothing" are four different situations and only the
// last one is the user's to fix by cd-ing somewhere.
function emptyMessage(zoxideMissing, scanned, scanFailed) {
  if (!scanned) return "Reading recent directories…"
  if (scanFailed) return "Could not read the directory list. Press r to try again."
  if (zoxideMissing) return "zoxide is not installed. Install it, then cd around to build a list."
  return "No recent directories yet. cd somewhere and come back."
}

function clampIndex(index, count) {
  if (count <= 0) return 0
  var n = Number(index)
  if (!isFinite(n)) return 0
  return Math.max(0, Math.min(count - 1, Math.round(n)))
}

// Wraps at both ends: the list is short and a cursor that stops dead at the
// bottom just makes the user press Up ten times.
function moveIndex(index, delta, count) {
  if (count <= 0) return 0
  var n = clampIndex(index, count) + delta
  while (n < 0) n += count
  return n % count
}

if (typeof module !== "undefined" && module.exports) {
  module.exports = {
    MIN_LIMIT: MIN_LIMIT,
    MAX_LIMIT: MAX_LIMIT,
    DEFAULT_LIMIT: DEFAULT_LIMIT,
    SCAN_DEPTH: SCAN_DEPTH,
    PIN_GLYPH: PIN_GLYPH,
    MAX_PATH_LENGTH: MAX_PATH_LENGTH,
    MAX_PINS: MAX_PINS,
    MAX_STATE_BYTES: MAX_STATE_BYTES,
    MAX_SCAN_BYTES: MAX_SCAN_BYTES,
    MAX_SCAN_LINES: MAX_SCAN_LINES,
    BASH: BASH,
    TIMEOUT: TIMEOUT,
    TRUSTED_BIN_DIRS: TRUSTED_BIN_DIRS,
    SCAN_TIMEOUT_SECONDS: SCAN_TIMEOUT_SECONDS,
    STATE_TIMEOUT_SECONDS: STATE_TIMEOUT_SECONDS,
    KILL_GRACE_SECONDS: KILL_GRACE_SECONDS,
    TERMINAL_TOOL: TERMINAL_TOOL,
    OPEN_TOOL: OPEN_TOOL,
    LAUNCH_ENV_KEYS: LAUNCH_ENV_KEYS,
    SCAN_ENV_KEYS: SCAN_ENV_KEYS,
    ENV_HOOKS: ENV_HOOKS,
    isEnvHook: isEnvHook,
    childEnvironment: childEnvironment,
    safeBinDirs: safeBinDirs,
    scanScript: scanScript,
    launchScript: launchScript,
    stateDirScript: stateDirScript,
    scanCommand: scanCommand,
    launchCommand: launchCommand,
    stateDirCommand: stateDirCommand,
    clampInt: clampInt,
    clampLimit: clampLimit,
    normalizePath: normalizePath,
    dedupe: dedupe,
    cappedPins: cappedPins,
    indexOfPath: indexOfPath,
    containsPath: containsPath,
    filterKnown: filterKnown,
    parseScan: parseScan,
    mergeRows: mergeRows,
    isPinned: isPinned,
    togglePin: togglePin,
    parsePinned: parsePinned,
    serializePinned: serializePinned,
    displayPath: displayPath,
    emptyMessage: emptyMessage,
    clampIndex: clampIndex,
    moveIndex: moveIndex
  }
}
