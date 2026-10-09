import QtQuick
import Quickshell
import Quickshell.Io
import qs.Commons
import qs.Ui
import "Model.js" as Model

// The bar face of Recent Paths, and the only place that touches the outside
// world: it runs the scan, writes the pin file, and launches the terminal and
// the file manager. Panel.qml is a read-out of this widget and calls back
// into it, so a two-monitor desktop cannot end up with two disagreeing lists.
//
// Nothing here is a background job. The scan is one short-lived process, run
// when the shell starts and again on every panel open, because the answer is
// only ever looked at while the panel is on screen.
//
// A plugin runs inside the shell process, with the shell process's privileges
// and the session's whole environment. Every child started from here therefore
// gets a fixed interpreter, a non-login shell, and an environment built from
// scratch rather than inherited — see the "children" section of Model.js — and
// every one of them has a deadline it cannot outlive.
BarWidget {
  id: root
  moduleName: "shilai_li.recent-paths"

  readonly property int limit: Model.clampLimit(setting("limit", Model.DEFAULT_LIMIT))

  readonly property string home: Quickshell.env("HOME")
  readonly property string stateDir: home + "/.local/state/omarchy/recent-paths"
  readonly property string statePath: stateDir + "/state.json"

  // Pins as stored. A pinned directory that has gone missing — an unmounted
  // drive, a project moved aside — stays in this list and simply drops out of
  // `existingPins` until it is back. Forgetting it would mean the user loses
  // a pin every time a disk is unplugged.
  property var pins: []

  // What the last scan proved exists, which is all the panel may show.
  property var existingPins: []
  property var existingRecents: []

  property bool zoxideMissing: false
  property bool scanned: false

  // A scan that timed out, died on a signal, or came back non-zero. Kept
  // separate from `scanned` so the panel can say "the look failed" rather than
  // "there is nothing there", which are not the same sentence.
  property bool scanFailed: false

  // The state directory has been checked and is ours. Until it is, there is
  // nothing to read pins from and nowhere safe to write them, so the pin file
  // is not touched at all.
  property bool stateReady: false

  readonly property var rows: Model.mergeRows(existingPins, existingRecents, limit)

  // ---- The environment every child gets. Built once, from an allowlist, so
  //      nothing exported into this session — a loader hook, a shell startup
  //      hook, a PATH entry — is passed on to anything this widget starts.
  function envLookup(name) { return Quickshell.env(name) }

  readonly property var scanEnv: Model.childEnvironment(Model.SCAN_ENV_KEYS, root.envLookup)
  readonly property var launchEnv: Model.childEnvironment(Model.LAUNCH_ENV_KEYS, root.envLookup)

  // ---- Scanning. One process answers the whole question; see Model.scanScript.
  //
  // Each run carries a generation. A scan that is superseded, that overruns its
  // deadline, or that outlives the widget has its generation left behind, and
  // whatever it eventually prints is dropped rather than believed: a late
  // answer is not a current one.
  property int scanGeneration: 0

  function refresh() {
    // A scan already in flight is the current one, and it has a deadline. The
    // panel opening again while it runs is not a reason to start a second.
    if (scanProc.running) return

    root.scanGeneration++
    scanProc.generation = root.scanGeneration
    scanProc.command = Model.scanCommand(root.pins, Model.SCAN_DEPTH)
    scanProc.running = true
    scanDeadline.restart()
  }

  // Give up on whatever is running and make sure nothing it prints is taken as
  // the current state. Used by the deadline, and on the way out.
  function abandonScan() {
    scanDeadline.stop()
    root.scanGeneration++
    if (scanProc.running) {
      scanProc.signal(15)
      scanKill.restart()
    }
  }

  function applyScan(text) {
    var scan = Model.parseScan(text)
    root.existingPins = Model.filterKnown(root.pins, scan.pinned)
    root.existingRecents = scan.recents
    root.zoxideMissing = scan.zoxideMissing
    root.scanFailed = false
    root.scanned = true
  }

  // A failed scan leaves the last good list on screen. The alternative — an
  // empty panel — throws away a working answer because the newest one did not
  // arrive, which is the wrong trade for a shortcut list.
  function noteScanFailed() {
    root.scanFailed = true
    root.scanned = true
  }

  // ---- Pins. The file is the record; `existingPins` is re-derived from the
  //      paths the last scan already proved exist, so toggling a pin needs no
  //      new stat and the list reorders on the keystroke itself.
  function togglePin(path) {
    // No vouched-for state directory means no record to change. Pretending
    // otherwise would show a pin that disappears at the next restart.
    if (!root.stateReady) return

    var next = Model.togglePin(root.pins, path)
    root.pins = next
    root.existingPins = Model.filterKnown(next, root.existingPins.concat(root.existingRecents))
    stateFile.setText(Model.serializePinned(next))
  }

  function isPinned(path) { return Model.isPinned(root.pins, path) }

  // ---- Launching. Both actions hand the path over as a positional argument
  //      rather than building a command line, so a directory named with a
  //      quote or a $(...) is opened, not executed. The tool name is a
  //      constant, and the script resolves it inside a fixed list of trusted
  //      directories rather than through an inherited PATH.
  function launch(tool, args) {
    Quickshell.execDetached({
      command: Model.launchCommand(tool, args),
      environment: root.launchEnv,
      clearEnvironment: true
    })
  }

  function openTerminal(path) {
    if (!path) return
    // The same xdg-terminal-exec omarchy-launch-terminal uses, so the plugin
    // follows `omarchy default terminal` with no setting of its own.
    root.launch(Model.TERMINAL_TOOL, ["--dir=" + path])
  }

  function openFiles(path) {
    if (!path) return
    // xdg-open rather than nautilus by name: on a stock Omarchy it is
    // nautilus anyway, and on a machine where the user swapped file managers
    // this is the one that opens theirs.
    root.launch(Model.OPEN_TOOL, [path])
  }

  function statusJson() {
    var list = []
    for (var i = 0; i < root.rows.length; i++) {
      list.push({ path: root.rows[i].path, pinned: root.rows[i].pinned })
    }
    return JSON.stringify({
      zoxide: !root.zoxideMissing,
      scanned: root.scanned,
      scanFailed: root.scanFailed,
      state: root.stateReady ? "ready" : "unavailable",
      count: list.length,
      limit: root.limit,
      paths: list
    })
  }

  // ---- Panel plumbing. Shape contract for shell.summon/hide/toggle routing:
  //      Bar.findPanelWidget requires open/close/opened on the bar-widget
  //      root, and the popout coordinator prefers closeForPopoutSwitch.
  readonly property bool opened: panelLoader.item ? panelLoader.item.opened === true : false
  readonly property bool popoutSwitchClosing: panelLoader.item ? panelLoader.item.popoutSwitchClosing === true : false

  function open() { if (panelLoader.item) panelLoader.item.open() }
  function close() { if (panelLoader.item) panelLoader.item.close() }
  function togglePanel() { if (panelLoader.item) panelLoader.item.toggle() }
  function closeForPopoutSwitch() { if (panelLoader.item) panelLoader.item.closeForPopoutSwitch() }

  function injectPanel() {
    var target = panelLoader.item
    if (!target) return
    if ("bar" in target) target.bar = root.bar
    if ("settings" in target) target.settings = root.settings
    if ("anchorItem" in target) target.anchorItem = button
    if ("hostWidget" in target) target.hostWidget = root
  }

  // Same glyph and button the shell's own icon widgets use: BarIconButton
  // centers the ink optically, and the open-panel mark takes the shell's default.
  readonly property string iconText: "󰉋"

  implicitWidth: button.implicitWidth
  implicitHeight: button.implicitHeight

  onBarChanged: injectPanel()
  onSettingsChanged: injectPanel()

  Component.onCompleted: {
    if (!root.home) {
      // No $HOME is no state directory to find, let alone one to vouch for.
      // The list still works; it just has no pins.
      root.refresh()
      return
    }
    stateProc.running = true
  }

  // Nothing this widget started may outlive it. The panel is destroyed on a
  // shell reload as well as on shutdown, and a scan left running would go on
  // holding a pipe nobody is reading.
  Component.onDestruction: {
    scanKill.stop()
    root.abandonScan()
    if (scanProc.running) scanProc.running = false
  }

  // The state directory is ours alone, so establishing that is a one-shot at
  // startup rather than something every write has to redo: it is created 0700
  // if missing, and then checked for being a real directory, not a symlink,
  // owned by us, with the file inside it the same. Anything else and the pin
  // file is left alone entirely.
  Process {
    id: stateProc
    clearEnvironment: true
    environment: root.scanEnv
    command: Model.stateDirCommand(root.stateDir, root.statePath)
    stdout: StdioCollector { id: stateOut; waitForEnd: true }
    onExited: function (exitCode, exitStatus) {
      root.stateReady = exitStatus === 0 && exitCode === 0
        && String(stateOut.text).indexOf("OK") === 0
      // Either way the list itself is worth having, so the scan runs. Binding
      // the file's path to `stateReady` is what starts the read.
      if (!root.stateReady) root.refresh()
    }
  }

  FileView {
    id: stateFile
    // Empty until the directory has been vouched for: no path, no read, no
    // write, and no chance of either landing somewhere it should not.
    path: root.stateReady ? root.statePath : ""
    watchChanges: true
    atomicWrites: true
    printErrors: false
    onLoaded: {
      root.pins = Model.parsePinned(stateFile.text())
      root.refresh()
    }
    onFileChanged: stateFile.reload()
    // No file yet is the ordinary first run: no pins, and the scan still has
    // zoxide's list to show.
    onLoadFailed: root.refresh()
    // Fail closed. The file is the record, so if the write did not land, the
    // list in memory is a claim nothing backs; go and read what is actually
    // there instead of leaving a pin on screen that no longer exists.
    onSaveFailed: stateFile.reload()
  }

  Process {
    id: scanProc
    clearEnvironment: true
    environment: root.scanEnv
    stdout: StdioCollector { id: scanOut; waitForEnd: true }

    // Which refresh this run belongs to. Compared against root.scanGeneration
    // on the way out; anything else is a late answer to a question that has
    // already been asked again or abandoned.
    property int generation: 0

    onExited: function (exitCode, exitStatus) {
      scanDeadline.stop()
      scanKill.stop()
      if (scanProc.generation !== root.scanGeneration) return
      // exitStatus is QProcess.NormalExit; a non-zero code covers the script
      // failing, `timeout` reporting 124, and the pipeline being killed.
      if (exitStatus !== 0 || exitCode !== 0) {
        root.noteScanFailed()
        return
      }
      root.applyScan(scanOut.text)
    }
  }

  // The scan already carries its own deadline — `timeout`, which signals the
  // whole process group. This is the backstop for the case that leaves out:
  // `timeout` itself never reporting. It fires late enough that a healthy scan
  // has always finished and a timed-out one has always been reaped.
  Timer {
    id: scanDeadline
    interval: (Model.SCAN_TIMEOUT_SECONDS + Model.KILL_GRACE_SECONDS + 2) * 1000
    onTriggered: root.abandonScan()
  }

  Timer {
    id: scanKill
    interval: Model.KILL_GRACE_SECONDS * 1000
    onTriggered: if (scanProc.running) scanProc.signal(9)
  }

  Loader {
    id: panelLoader
    active: true
    source: Qt.resolvedUrl("Panel.qml")
    visible: false
    onLoaded: {
      root.injectPanel()
      Qt.callLater(root.injectPanel)
    }
  }

  IpcHandler {
    target: "shilai_li.recent-paths"

    function toggle(): void { root.togglePanel() }
    function open(): void { root.open() }
    function close(): void { root.close() }
    function show(): void { root.open() }
    function hide(): void { root.close() }
    function refresh(): void { root.refresh() }
    function status(): string { return root.statusJson() }
  }

  BarIconButton {
    id: button
    anchors.fill: parent
    bar: root.bar
    text: root.iconText
    tooltipText: "Recent paths"

    onPressed: function(b) { root.togglePanel() }
  }
}
