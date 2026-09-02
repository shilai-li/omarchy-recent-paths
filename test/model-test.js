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

// A scratch directory that cleans itself up even when the check throws.
function withTemp(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "recent-paths-test-"))
  try {
    return fn(dir)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
}

// An executable stand-in, dropped into a directory the script under test has
// been told to trust.
function fakeBin(dir, name, body) {
  const file = path.join(dir, name)
  fs.writeFileSync(file, "#!/bin/sh\n" + body + "\n")
  fs.chmodSync(file, 0o755)
  return file
}

// Every script is run the way the widget runs it: a fixed bash, `-c`, no login
// shell, and an environment of our own rather than this test process's.
function runScript(script, args, env) {
  return execFileSync(M.BASH, ["-c", script, "recent-paths-test"].concat(args || []),
    { encoding: "utf8", env: env || {} })
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

check("a space is part of a directory name; a tab or a newline is not", () => {
  // Spaces are ordinary and must survive — "~/My Documents" is a real place.
  eq(M.normalizePath("/home/me/My Documents"), "/home/me/My Documents", "space kept")
  // These would tear the scan's own tab-separated line protocol, so a path
  // carrying one is treated as a torn line rather than as a directory.
  eq(M.normalizePath("/a\tb"), "", "tab")
  eq(M.normalizePath("/a\nb"), "", "newline")
  eq(M.normalizePath("/a\u0000b"), "", "NUL")
})

check("a path longer than PATH_MAX is refused before it is walked", () => {
  eq(M.normalizePath("/" + "a".repeat(M.MAX_PATH_LENGTH)), "", "over the cap")
  eq(M.normalizePath("/" + "a".repeat(M.MAX_PATH_LENGTH - 2)).length, M.MAX_PATH_LENGTH - 1, "under it")
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

// -------------------------------------------------------------------- caps

check("the pin list is capped wherever it is handled", () => {
  const many = []
  for (let i = 0; i < M.MAX_PINS + 50; i++) many.push("/p" + i)

  eq(M.cappedPins(many).length, M.MAX_PINS, "in memory")
  eq(M.parsePinned(JSON.stringify({ pinned: many })).length, M.MAX_PINS, "on read")
  eq(M.parsePinned(M.serializePinned(many)).length, M.MAX_PINS, "on write")
  eq(M.mergeRows(many, [], 20).length, 20, "on display")

  // At the cap the list stops growing rather than the widget stopping work,
  // and unpinning is still the way back out.
  const full = M.cappedPins(many)
  eq(M.togglePin(full, "/one-more").length, M.MAX_PINS, "no room for another")
  eq(M.togglePin(full, "/p0").length, M.MAX_PINS - 1, "unpinning still works")
})

check("an oversized state file is refused rather than parsed", () => {
  const bloat = '{"pinned":["/a"],"pad":"' + "x".repeat(M.MAX_STATE_BYTES) + '"}'
  ok(bloat.length > M.MAX_STATE_BYTES, "the fixture is actually oversized")
  eq(M.parsePinned(bloat), [], "nothing is allocated from it")
})

check("scan output is bounded even if it did not come from our script", () => {
  const lines = []
  for (let i = 0; i < M.SCAN_DEPTH * 10; i++) lines.push("R\t/d" + i)
  const scan = M.parseScan(lines.join("\n"))
  eq(scan.recents.length, M.SCAN_DEPTH, "recents stop at the scan depth")

  const pins = []
  for (let i = 0; i < M.MAX_PINS + 50; i++) pins.push("P\t/p" + i)
  eq(M.parseScan(pins.join("\n")).pinned.length, M.MAX_PINS, "pins stop at the pin cap")
})

// ------------------------------------------------------- the child environment

check("a child's environment is built from an allowlist, not inherited", () => {
  const session = {
    HOME: "/home/me",
    WAYLAND_DISPLAY: "wayland-1",
    SECRET_TOKEN: "hunter2",
    PATH: "/tmp/evil"
  }
  const env = M.childEnvironment(["HOME", "WAYLAND_DISPLAY"], k => session[k])

  eq(env.HOME, "/home/me", "an allowlisted variable is carried over")
  eq(env.WAYLAND_DISPLAY, "wayland-1", "and so is the next one")
  eq(env.SECRET_TOKEN, undefined, "nothing else is")
  eq(env.PATH, M.TRUSTED_BIN_DIRS.join(":"), "PATH is ours, not the session's")
  eq(M.childEnvironment(["PATH"], k => session[k]).PATH, M.TRUSTED_BIN_DIRS.join(":"),
    "and cannot be asked for by name either")
})

check("no allowlist can carry a hook that makes a program run code first", () => {
  const hooks = ["LD_PRELOAD", "LD_AUDIT", "BASH_ENV", "ENV", "SHELLOPTS",
    "BASH_FUNC_ls%%", "GLIBC_TUNABLES", "PYTHONSTARTUP"]
  hooks.forEach(h => ok(M.isEnvHook(h), h + " is recognised as a hook"))

  // Even asked for by name, they do not make it into a child.
  const env = M.childEnvironment(hooks.concat(["HOME"]), () => "/tmp/evil")
  eq(Object.keys(env).sort(), ["HOME", "PATH"], "only PATH and the real variable")

  // And the lists the widget actually uses do not name one.
  M.LAUNCH_ENV_KEYS.concat(M.SCAN_ENV_KEYS).forEach(k =>
    ok(!M.isEnvHook(k), k + " is not a hook"))
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
  ok(M.emptyMessage(false, false, false).indexOf("Reading") >= 0, "before the first scan")
  ok(M.emptyMessage(false, true, true).indexOf("try again") >= 0, "the scan itself failed")
  ok(M.emptyMessage(true, true, false).indexOf("zoxide") >= 0, "missing zoxide is named")
  ok(M.emptyMessage(false, true, false).indexOf("No recent") >= 0, "a scan that found nothing")
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
// The scripts are the plugin's only contact with the filesystem and the only
// place it starts a process, so they are tested by running them, not by
// reading them. Every run below passes an empty environment: if a script needs
// something from the session it has to be something the widget put there.

check("the scan script reports existing pins and skips missing ones", () => {
  withTemp(dir => {
    const real = path.join(dir, "real dir")
    fs.mkdirSync(real)

    // No zoxide in the directories this run is told to trust. PATH is not
    // consulted at all any more, so it is not what makes this branch happen.
    const out = runScript(M.scanScript(200, ["/nonexistent"]), [real, path.join(dir, "gone")])
    const scan = M.parseScan(out)

    eq(scan.pinned, [real], "a pin that exists, spaces and all")
    eq(scan.zoxideMissing, true, "no zoxide where we look is reported as such")
  })
})

check("zoxide is looked for in trusted directories, never on PATH", () => {
  withTemp(dir => {
    const trusted = path.join(dir, "trusted")
    const onpath = path.join(dir, "onpath")
    fs.mkdirSync(trusted)
    fs.mkdirSync(onpath)
    fakeBin(onpath, "zoxide", 'echo "/should/not/run"')

    // The impostor is on PATH and in the current directory, and neither is a
    // place this script will look.
    const out = runScript(M.scanScript(200, [trusted]), [], { PATH: onpath })
    eq(M.parseScan(out).zoxideMissing, true, "the one on PATH was not used")
  })
})

check("the row cap is applied while reading, not after", () => {
  withTemp(dir => {
    const trusted = path.join(dir, "trusted")
    fs.mkdirSync(trusted)
    for (let i = 0; i < 5; i++) fs.mkdirSync(path.join(dir, "d" + i))
    // Reports far more than it will be allowed to hand back.
    fakeBin(trusted, "zoxide", 'for i in 0 1 2 3 4; do echo "' + dir + '/d$i"; done')

    const scan = M.parseScan(runScript(M.scanScript(2, [trusted]), []))
    eq(scan.recents, [path.join(dir, "d0"), path.join(dir, "d1")], "stopped at the cap")
  })
})

check("a directory name a shell would love to expand stays a directory name", () => {
  withTemp(dir => {
    const nasty = path.join(dir, "$(touch pwned) 'quoted'")
    fs.mkdirSync(nasty)

    const out = runScript(M.scanScript(200, ["/nonexistent"]), [nasty])
    eq(M.parseScan(out).pinned, [nasty], "passed through as data")
    ok(!fs.existsSync(path.join(process.cwd(), "pwned")), "nothing was executed")
    ok(!fs.existsSync(path.join(dir, "pwned")), "nothing was executed there either")
  })
})

check("the scan runs under a hard deadline it cannot outlive", () => {
  const cmd = M.scanCommand(["/a"], 200)
  eq(cmd.slice(0, 4), [M.TIMEOUT, "-k", String(M.KILL_GRACE_SECONDS), String(M.SCAN_TIMEOUT_SECONDS)],
    "the deadline comes first, before the interpreter")
  eq(cmd[4], M.BASH, "a fixed interpreter path")
  eq(cmd[5], "-c", "not a login shell, and not interactive")

  // A script that would otherwise hang forever comes back, and says why.
  let status = 0
  try {
    execFileSync(M.TIMEOUT, ["-k", "1", "1", M.BASH, "-c", "sleep 30"], { encoding: "utf8", env: {} })
  } catch (e) {
    status = e.status
  }
  eq(status, 124, "timeout reports the deadline, and the widget treats non-zero as a failed scan")
})

check("the pin list is capped before it becomes an argv", () => {
  const many = []
  for (let i = 0; i < M.MAX_PINS + 500; i++) many.push("/p" + i)
  const cmd = M.scanCommand(many, 200)
  // Four for the deadline, four for the interpreter and its $0.
  eq(cmd.length - 8, M.MAX_PINS, "argv cannot grow without bound")
})

// ----------------------------------------------------- the launch script

check("a launch resolves its tool in trusted directories only", () => {
  withTemp(dir => {
    const trusted = path.join(dir, "trusted")
    const onpath = path.join(dir, "onpath")
    fs.mkdirSync(trusted)
    fs.mkdirSync(onpath)
    const log = path.join(dir, "args")
    fakeBin(trusted, "opener", 'printf "%s\\n" "$@" > ' + JSON.stringify(log))
    fakeBin(onpath, "opener", 'echo impostor > ' + JSON.stringify(log))

    // Neither uwsm-app nor setsid lives in the trusted directory here, so this
    // exercises the bare fallback.
    runScript(M.launchScript([trusted]), ["opener", path.join(dir, "a dir")], { PATH: onpath })
    eq(fs.readFileSync(log, "utf8"), path.join(dir, "a dir") + "\n",
      "the trusted tool ran, and the path arrived as one argument")
  })
})

check("a tool that is not in a trusted directory is not run at all", () => {
  withTemp(dir => {
    const trusted = path.join(dir, "trusted")
    fs.mkdirSync(trusted)
    let status = 0
    try {
      runScript(M.launchScript([trusted]), ["nowhere-tool", "/tmp"])
    } catch (e) {
      status = e.status
    }
    eq(status, 127, "reported as not found rather than searched for elsewhere")
  })
})

check("a launch hands the path over as data, never as source", () => {
  withTemp(dir => {
    const trusted = path.join(dir, "trusted")
    fs.mkdirSync(trusted)
    const log = path.join(dir, "args")
    fakeBin(trusted, "opener", 'printf "%s\\n" "$@" > ' + JSON.stringify(log))

    const nasty = path.join(dir, "$(touch pwned)")
    runScript(M.launchScript([trusted]), ["opener", "--dir=" + nasty])
    eq(fs.readFileSync(log, "utf8"), "--dir=" + nasty + "\n", "passed through verbatim")
    ok(!fs.existsSync(path.join(dir, "pwned")), "nothing was executed")
  })
})

check("the launch argv names a fixed interpreter and a constant tool", () => {
  const cmd = M.launchCommand(M.TERMINAL_TOOL, ["--dir=/a b"])
  eq(cmd[0], M.BASH, "fixed interpreter path")
  eq(cmd[1], "-c", "no login shell")
  eq(cmd[4], "xdg-terminal-exec", "the tool name is a constant, not built from input")
  eq(cmd[5], "--dir=/a b", "the path is a positional parameter")
})

// ------------------------------------------------ the state directory script

check("the state directory is created private and vouched for", () => {
  withTemp(dir => {
    const state = path.join(dir, "state", "recent-paths")
    const file = path.join(state, "state.json")

    eq(runScript(M.stateDirScript(), [state, file]), "OK\n", "created and accepted")
    eq(fs.statSync(state).mode & 0o777, 0o700, "ours alone")

    // A second run over an existing directory is the ordinary case.
    fs.writeFileSync(file, '{"pinned":[]}')
    fs.chmodSync(file, 0o666)
    eq(runScript(M.stateDirScript(), [state, file]), "OK\n", "existing directory accepted")
    eq(fs.statSync(file).mode & 0o777, 0o600, "and the file's mode is put back")
  })
})

check("a symlink standing in for the state directory is refused", () => {
  withTemp(dir => {
    const elsewhere = path.join(dir, "elsewhere")
    const state = path.join(dir, "state")
    fs.mkdirSync(elsewhere)
    fs.symlinkSync(elsewhere, state)

    let status = 0
    try {
      runScript(M.stateDirScript(), [state, path.join(state, "state.json")])
    } catch (e) {
      status = e.status
    }
    eq(status, 1, "a write here would have landed somewhere else")
  })
})

check("a symlink standing in for the state file is refused", () => {
  withTemp(dir => {
    const state = path.join(dir, "state")
    const file = path.join(state, "state.json")
    fs.mkdirSync(state, { mode: 0o700 })
    fs.symlinkSync(path.join(dir, "target"), file)

    let status = 0
    try {
      runScript(M.stateDirScript(), [state, file])
    } catch (e) {
      status = e.status
    }
    eq(status, 1, "refused before anything is written")
  })
})

check("something that is not a regular file in the state file's place is refused", () => {
  withTemp(dir => {
    const state = path.join(dir, "state")
    const file = path.join(state, "state.json")
    fs.mkdirSync(state, { mode: 0o700 })
    fs.mkdirSync(file)

    let status = 0
    try {
      runScript(M.stateDirScript(), [state, file])
    } catch (e) {
      status = e.status
    }
    eq(status, 1, "a directory is not the record")
  })
})

check("an interpolated directory list is checked, not trusted", () => {
  // Only the bin-dir list is ever spliced into script source, so it is the one
  // thing that has to be shaped like a path before it goes in.
  eq(M.safeBinDirs(["/usr/bin"]), ["/usr/bin"], "an ordinary one passes")
  eq(M.safeBinDirs(["/usr/bin; rm -rf ~"]), M.TRUSTED_BIN_DIRS, "a command falls back")
  eq(M.safeBinDirs(["$(id)"]), M.TRUSTED_BIN_DIRS, "so does a substitution")
  eq(M.safeBinDirs(["relative"]), M.TRUSTED_BIN_DIRS, "and so does a relative path")
  eq(M.safeBinDirs([]), M.TRUSTED_BIN_DIRS, "an empty list is the default list")
})

// ------------------------------------------------------------------ report

if (failures.length > 0) {
  console.error(failures.length + " failed, " + passed + " passed\n")
  failures.forEach(f => console.error("  ✗ " + f))
  process.exit(1)
}
console.log(passed + " passed")
