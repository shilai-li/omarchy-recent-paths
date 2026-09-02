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

  readonly property var rows: Model.mergeRows(existingPins, existingRecents, limit)

  // ---- Scanning. One process answers the whole question; see Model.scanScript.
  function refresh() {
    if (scanProc.running) return
    scanProc.command = ["bash", "-lc", Model.scanScript(Model.SCAN_DEPTH), "bash"].concat(root.pins)
    scanProc.running = true
  }

  function applyScan(text) {
    var scan = Model.parseScan(text)
    root.existingPins = Model.filterKnown(root.pins, scan.pinned)
    root.existingRecents = scan.recents
    root.zoxideMissing = scan.zoxideMissing
    root.scanned = true
  }

  // ---- Pins. The file is the record; `existingPins` is re-derived from the
  //      paths the last scan already proved exist, so toggling a pin needs no
  //      new stat and the list reorders on the keystroke itself.
  function togglePin(path) {
    var next = Model.togglePin(root.pins, path)
    root.pins = next
    root.existingPins = Model.filterKnown(next, root.existingPins.concat(root.existingRecents))
    stateFile.setText(Model.serializePinned(next))
  }

  function isPinned(path) { return Model.isPinned(root.pins, path) }

  // ---- Launching. Both actions hand the path over as a positional argument
  //      rather than building a command line, so a directory named with a
  //      quote or a $(...) is opened, not executed.
  function launch(argv) {
    Quickshell.execDetached(["bash", "-lc", Model.LAUNCH_SCRIPT, "bash"].concat(argv))
  }

  function openTerminal(path) {
    if (!path) return
    // The same xdg-terminal-exec omarchy-launch-terminal uses, so the plugin
    // follows `omarchy default terminal` with no setting of its own.
    root.launch(["xdg-terminal-exec", "--dir=" + path])
  }

  function openFiles(path) {
    if (!path) return
    // xdg-open rather than nautilus by name: on a stock Omarchy it is
    // nautilus anyway, and on a machine where the user swapped file managers
    // this is the one that opens theirs.
    root.launch(["xdg-open", path])
  }

  function statusJson() {
    var list = []
    for (var i = 0; i < root.rows.length; i++) {
      list.push({ path: root.rows[i].path, pinned: root.rows[i].pinned })
    }
    return JSON.stringify({
      zoxide: !root.zoxideMissing,
      scanned: root.scanned,
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

  readonly property real openPanelIndicatorWidth: button.labelWidth
  readonly property real openPanelIndicatorHeight: Math.max(Style.space(10), Math.round(Style.bar.iconSlot * 0.55))

  implicitWidth: button.implicitWidth
  implicitHeight: button.implicitHeight

  onBarChanged: injectPanel()
  onSettingsChanged: injectPanel()

  Component.onCompleted: ensureDirProc.running = true

  // The state directory is ours alone, so creating it is a one-shot at
  // startup rather than something every write has to check.
  Process {
    id: ensureDirProc
    command: ["mkdir", "-p", root.stateDir]
    onExited: Qt.callLater(function() { stateFile.reload() })
  }

  FileView {
    id: stateFile
    path: root.statePath
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
  }

  Process {
    id: scanProc
    stdout: StdioCollector { id: scanOut; waitForEnd: true }
    onExited: root.applyScan(scanOut.text)
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

  WidgetButton {
    id: button
    anchors.fill: parent
    bar: root.bar
    text: "󰉋"
    active: root.opened
    horizontalMargin: 8.75
    verticalPadding: 8.75
    tooltipText: "Recent paths"

    onPressed: function(b) { root.togglePanel() }
  }
}
