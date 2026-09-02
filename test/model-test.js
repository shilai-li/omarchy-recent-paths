// Run with: bash test/model-test.sh
const { execFileSync } = require("child_process")
const fs = require("fs")
const os = require("os")
const path = require("path")
const M = require("../Model.js")

let passed = 0
const failures = []

function check(name, fn) {
  try {
    fn()
    passed++
  } catch (e) {
    failures.push(name + "\n    " + e.message)
  }
}

function eq(actual, expected, what) {
  const a = JSON.stringify(actual)
  const b = JSON.stringify(expected)
  if (a !== b) throw new Error((what || "value") + ": expected " + b + ", got " + a)
}

function ok(value, what) {
  if (!value) throw new Error((what || "assertion") + " was falsy")
}

// ---------------------------------------------------------------- settings

check("the display limit stays in the 10-20 range", () => {
  eq(M.clampLimit(15), 15, "nominal")
  eq(M.clampLimit(3), 10, "floor")
  eq(M.clampLimit(999), 20, "ceiling")
  eq(M.clampLimit(null), 15, "missing falls back")
  eq(M.clampLimit("nonsense"), 15, "garbage falls back")
})

// ------------------------------------------------------------------- paths

check("paths are normalized, not guessed at", () => {
  eq(M.normalizePath("/tmp/"), "/tmp", "trailing slash")
  eq(M.normalizePath("  /tmp/x  "), "/tmp/x", "surrounding space")
  eq(M.normalizePath("/"), "/", "root survives")
  eq(M.normalizePath("relative/path"), "", "relative is dropped")
  eq(M.normalizePath(""), "", "empty")
  eq(M.normalizePath(null), "", "null")
})

check("dedupe keeps the first occurrence and collapses slash variants", () => {
  eq(M.dedupe(["/a", "/b", "/a/", "/a"]), ["/a", "/b"])
  eq(M.dedupe(["nope", "/a"]), ["/a"], "unusable entries are dropped")
  eq(M.dedupe(null), [], "no list at all")
})

check("a directory named like an Object property is still just a path", () => {
  // Set membership is keyed with a prefix precisely so these do not collide
  // with Object.prototype.
  eq(M.dedupe(["/__proto__", "/constructor", "/__proto__"]), ["/__proto__", "/constructor"])
  eq(M.containsPath(["/a"], "/toString"), false)
})

// -------------------------------------------------------------- scan output

check("the scan output splits into pins, recents and a zoxide verdict", () => {
  const scan = M.parseScan("P\t/home/me\nR\t/home/me/src\nR\t/tmp\n")
  eq(scan.pinned, ["/home/me"])
  eq(scan.recents, ["/home/me/src", "/tmp"])
  eq(scan.zoxideMissing, false)
})

check("a missing zoxide is reported, not inferred from an empty list", () => {
  eq(M.parseScan("E\tzoxide\n").zoxideMissing, true, "explicit marker")
  eq(M.parseScan("").zoxideMissing, false, "empty output is not a missing zoxide")
  eq(M.parseScan(null).recents, [], "no output at all")
})

check("torn lines are skipped rather than shown", () => {
  const scan = M.parseScan("R\t/good\nno-tab-here\nR\trelative\nR\t\n")
  eq(scan.recents, ["/good"])
})

// -------------------------------------------------------------------- rows

check("pins lead, recents follow, and nothing appears twice", () => {
  eq(M.mergeRows(["/pin"], ["/a", "/pin", "/b"], 15), [
    { path: "/pin", pinned: true },
    { path: "/a", pinned: false },
    { path: "/b", pinned: false }
  ])
})

check("the row list is capped at the display limit", () => {
  const recents = []
  for (let i = 0; i < 40; i++) recents.push("/d" + i)
  eq(M.mergeRows([], recents, 10).length, 10, "cap applied")
  eq(M.mergeRows([], recents, 99).length, 20, "cap is clamped first")
  eq(M.mergeRows([], recents, 10)[0].path, "/d0", "order preserved")
})

check("filterKnown keeps only what the last scan proved exists", () => {
  eq(M.filterKnown(["/a", "/gone", "/b"], ["/b", "/a"]), ["/a", "/b"], "pin order, not scan order")
  eq(M.filterKnown(["/a"], []), [], "nothing known")
})

// -------------------------------------------------------------------- pins

check("pinning toggles and keeps pin order stable", () => {
  eq(M.togglePin([], "/a"), ["/a"], "first pin")
  eq(M.togglePin(["/a"], "/b"), ["/a", "/b"], "new pins go last")
  eq(M.togglePin(["/a", "/b"], "/a"), ["/b"], "toggling off")
  eq(M.togglePin(["/a"], "/a/"), [], "same directory, different spelling")
  eq(M.togglePin(["/a"], "relative"), ["/a"], "an unusable path changes nothing")
  eq(M.isPinned(["/a"], "/a/"), true)
})

check("the pin file survives being mangled", () => {
  eq(M.parsePinned('{"pinned":["/a","/a","/b"]}'), ["/a", "/b"], "deduped on read")
  eq(M.parsePinned("{not json"), [], "torn")
  eq(M.parsePinned("[]"), [], "wrong shape")
  eq(M.parsePinned(""), [], "empty")
  eq(M.parsePinned(M.serializePinned(["/a", "/b"])), ["/a", "/b"], "round trip")
})

// ----------------------------------------------------------------- display

check("home is abbreviated the way a shell prompt does", () => {
  eq(M.displayPath("/home/me/src", "/home/me"), "~/src")
  eq(M.displayPath("/home/me", "/home/me"), "~")
  eq(M.displayPath("/mnt/storage", "/home/me"), "/mnt/storage")
  eq(M.displayPath("/home/meilleur", "/home/me"), "/home/meilleur", "prefix is a path boundary, not a substring")
  eq(M.displayPath("/home/me/src", ""), "/home/me/src", "no home known")
})

check("the empty message says which kind of empty this is", () => {
  ok(M.emptyMessage(true, true).indexOf("zoxide") >= 0, "missing zoxide is named")
  ok(M.emptyMessage(false, false).indexOf("Reading") >= 0, "before the first scan")
  ok(M.emptyMessage(false, true).indexOf("No recent") >= 0, "after a scan that found nothing")
})

// ------------------------------------------------------------------ cursor

check("the cursor wraps at both ends and survives a shrinking list", () => {
  eq(M.moveIndex(0, -1, 3), 2, "up from the top wraps")
  eq(M.moveIndex(2, 1, 3), 0, "down from the bottom wraps")
  eq(M.moveIndex(0, 1, 0), 0, "empty list")
  eq(M.clampIndex(9, 3), 2, "past the end")
  eq(M.clampIndex(-4, 3), 0, "before the start")
  eq(M.clampIndex(1, 0), 0, "nothing to point at")
})

// ------------------------------------------------------- the scan script
//
// The script is the plugin's only contact with the filesystem, so it is
// tested by running it, not by reading it.

check("the scan script reports existing pins and skips missing ones", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "recent-paths-test-"))
  const real = path.join(dir, "real dir")
  fs.mkdirSync(real)

  // Not `bash -lc` as the plugin runs it: a login shell would source the
  // profile that puts zoxide back on PATH, and the point here is the branch
  // taken when it is absent.
  const out = execFileSync("/bin/bash", ["-c", M.scanScript(), "bash", real, path.join(dir, "gone")],
    { encoding: "utf8", env: { PATH: "/nonexistent" } })
  const scan = M.parseScan(out)

  eq(scan.pinned, [real], "a pin that exists, spaces and all")
  eq(scan.zoxideMissing, true, "no zoxide on PATH is reported as such")
  fs.rmSync(dir, { recursive: true, force: true })
})

check("a directory name a shell would love to expand stays a directory name", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "recent-paths-test-"))
  const nasty = path.join(dir, "$(touch pwned) 'quoted'")
  fs.mkdirSync(nasty)

  const out = execFileSync("/bin/bash", ["-c", M.scanScript(), "bash", nasty], { encoding: "utf8" })
  eq(M.parseScan(out).pinned, [nasty], "passed through as data")
  ok(!fs.existsSync(path.join(process.cwd(), "pwned")), "nothing was executed")
  fs.rmSync(dir, { recursive: true, force: true })
})

// ------------------------------------------------------------------ report

if (failures.length > 0) {
  console.error(failures.length + " failed, " + passed + " passed\n")
  failures.forEach(f => console.error("  ✗ " + f))
  process.exit(1)
}
console.log(passed + " passed")
