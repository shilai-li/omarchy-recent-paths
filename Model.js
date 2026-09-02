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

// ------------------------------------------------------------------ scripts
//
// Both scripts take their data in positional parameters, never interpolated
// into the source. A directory name is user data — it can contain quotes,
// spaces, or a $(...) that a shell would happily run.

// One process answers the whole question: which pinned paths still exist,
// whether zoxide is installed, and which of its top entries are real
// directories. Doing it in one pass keeps the panel to a single fork per
// open instead of one stat per row.
function scanScript(depth) {
  var n = clampInt(depth, 1, 5000, SCAN_DEPTH)
  return [
    'for p in "$@"; do [ -d "$p" ] && printf "P\\t%s\\n" "$p"; done',
    'command -v zoxide >/dev/null 2>&1 || { printf "E\\tzoxide\\n"; exit 0; }',
    'zoxide query -l 2>/dev/null | head -n ' + n
      + ' | while IFS= read -r p; do [ -d "$p" ] && printf "R\\t%s\\n" "$p"; done',
    'exit 0'
  ].join("\n")
}

// Omarchy launches graphical children through uwsm-app so they land in the
// right systemd scope, but a plugin that only works on a uwsm session is a
// plugin that breaks for the next person. Fall back to a bare setsid.
var LAUNCH_SCRIPT =
  'if command -v uwsm-app >/dev/null 2>&1; then exec setsid uwsm-app -- "$@"; fi\n'
  + 'exec setsid "$@"'

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
  var p = String(raw).replace(/^\s+|\s+$/g, "")
  if (p.charAt(0) !== "/") return ""
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
  var lines = String(text === undefined || text === null ? "" : text).split("\n")

  for (var i = 0; i < lines.length; i++) {
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

  result.pinned = dedupe(result.pinned)
  result.recents = dedupe(result.recents)
  return result
}

// ---------------------------------------------------------------------- rows
//
// Pins first in the order they were pinned, then zoxide's ranking with the
// pinned paths removed — a directory is one row or the other, never both.
function mergeRows(pinned, recents, limit) {
  var rows = []
  var seen = {}
  var pins = dedupe(pinned)
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
// already on screen.
function togglePin(pinned, path) {
  var target = normalizePath(path)
  if (!target) return dedupe(pinned)

  var current = dedupe(pinned)
  var out = []
  var removed = false
  for (var i = 0; i < current.length; i++) {
    if (current[i] === target) removed = true
    else out.push(current[i])
  }
  if (!removed) out.push(target)
  return out
}

// The state file holds pins and nothing else. A torn or hand-mangled file
// costs the user their pins, not a working panel.
function parsePinned(text) {
  try {
    var data = JSON.parse(String(text === undefined || text === null ? "" : text))
    if (!data || typeof data !== "object" || !Array.isArray(data.pinned)) return []
    return dedupe(data.pinned)
  } catch (e) {
    return []
  }
}

function serializePinned(pinned) {
  return JSON.stringify({ pinned: dedupe(pinned) }, null, 2) + "\n"
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

// What the panel says instead of a list. `scanned` distinguishes "we looked
// and there is nothing" from "we have not looked yet", so the panel never
// accuses zoxide of being empty before the first scan lands.
function emptyMessage(zoxideMissing, scanned) {
  if (zoxideMissing) return "zoxide is not installed. Install it, then cd around to build a list."
  if (!scanned) return "Reading recent directories…"
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
    LAUNCH_SCRIPT: LAUNCH_SCRIPT,
    scanScript: scanScript,
    clampInt: clampInt,
    clampLimit: clampLimit,
    normalizePath: normalizePath,
    dedupe: dedupe,
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
