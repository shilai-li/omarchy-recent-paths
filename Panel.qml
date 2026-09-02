import QtQuick
import qs.Commons
import qs.Ui
import "Model.js" as Model

// The list: pinned directories first, then zoxide's ranking, one row each.
//
// The panel owns the cursor and nothing else. Every path, every pin and every
// launch lives on BarWidget.qml, so the two monitors showing this panel see
// the same list and a pin toggled on one appears on the other.
//
// One highlight on screen at a time: rows paint from CursorSurface's
// `hasCursor`, never from `containsMouse`, and the mouse moves the same
// cursor the arrow keys do.
Panel {
  id: root
  moduleName: "shilai_li.recent-paths"
  ipcTarget: "shilai_li.recent-paths"
  manageIpc: false

  property var anchorItem: null

  // The bar tracks the widget mounted in its slot — BarWidget.qml — not this
  // nested panel, so everything the bar identifies a panel by has to be that
  // widget.
  property var hostWidget: null
  readonly property var barIdentity: hostWidget || root
  readonly property var host: hostWidget

  // ---- Read-out of the host. Guarded throughout: the bar-widget contract
  //      instantiates this bare, before injection.
  readonly property var rows: host ? host.rows : []
  readonly property string home: host ? host.home : ""
  readonly property bool zoxideMissing: host ? host.zoxideMissing : false
  readonly property bool scanned: host ? host.scanned : false
  readonly property bool scanFailed: host ? host.scanFailed : false

  property int selectedIndex: 0
  property bool cursorActive: false

  readonly property string currentPath: selectedIndex >= 0 && selectedIndex < rows.length
    ? rows[selectedIndex].path
    : ""

  // ---- Theme. Nothing here names a color; the palette does.
  readonly property color contentForeground: bar ? bar.foreground : Color.foreground
  readonly property string contentFontFamily: bar ? bar.fontFamily : Style.font.family
  readonly property color dim: Qt.darker(contentForeground, 1.5)
  readonly property color dimmer: Qt.darker(contentForeground, 2.0)
  readonly property color accentColor: Style.selectedStateColor(contentForeground, Color.accent)
  readonly property color hoverFill: Style.hoverFillFor(contentForeground, Color.accent)
  readonly property color selectedFill: Style.selectedFillFor(contentForeground, Color.accent)

  readonly property int rowHeight: Math.max(Style.space(24), Style.font.body + Style.space(12))
  // Twelve rows before the list starts scrolling. The panel is a shortcut,
  // not a window: past this it stops being something you read at a glance.
  readonly property int listHeight: Math.min(rows.length * rowHeight, rowHeight * 12)

  // ---- Lifecycle. Mirrors the clock's: the popout coordinator is handed
  //      over on show, so the hover-reveal flag is set after, not before.
  function open() {
    root.selectedIndex = 0
    root.cursorActive = true
    // The list is only ever looked at while it is open, so this is the one
    // moment it needs to be true. A directory removed since the last open
    // disappears here rather than failing on Enter.
    if (root.host) root.host.refresh()
    root.controller.show()
    Qt.callLater(function() {
      if (root.opened) root.setCenterHoverRevealSuppressed(true)
    })
  }

  function close() {
    root.setCenterHoverRevealSuppressed(false)
    root.controller.hide()
  }

  function toggle() { root.opened ? root.close() : root.open() }

  function switchPanel(direction) {
    if (root.bar && typeof root.bar.switchPanelFrom === "function")
      return root.bar.switchPanelFrom(root.barIdentity, direction)
    return false
  }

  // Summoning by hotkey moves no pointer, so a hover the bar was still
  // holding must not keep the center indicators revealed behind the panel.
  function setCenterHoverRevealSuppressed(value) {
    if (root.bar && "centerHoverRevealSuppressed" in root.bar)
      root.bar.centerHoverRevealSuppressed = value
  }

  // ---- Cursor.
  function moveCursor(delta) {
    if (root.rows.length === 0) return
    root.cursorActive = true
    root.selectedIndex = Model.moveIndex(root.selectedIndex, delta, root.rows.length)
    root.ensureVisible()
  }

  function focusPath(path) {
    var index = Model.indexOfPath(root.rows, path)
    if (index < 0) return
    root.selectedIndex = index
    root.ensureVisible()
  }

  // Rows are a fixed height, so the position of the selected one is
  // arithmetic rather than a lookup into the Repeater's items.
  function ensureVisible() {
    var top = root.selectedIndex * root.rowHeight
    var bottom = top + root.rowHeight
    if (top < scroll.contentY) scroll.contentY = top
    else if (bottom > scroll.contentY + scroll.height) scroll.contentY = bottom - scroll.height
  }

  // ---- Actions. Opening a path is the end of the interaction, so both
  //      launches close the panel; pinning is a list edit and leaves it up.
  function openTerminal() {
    if (!root.host || !root.currentPath) return
    root.host.openTerminal(root.currentPath)
    root.close()
  }

  function openFiles() {
    if (!root.host || !root.currentPath) return
    root.host.openFiles(root.currentPath)
    root.close()
  }

  function togglePin() {
    if (!root.host || !root.currentPath) return
    var path = root.currentPath
    root.host.togglePin(path)
    // Pinning moves the row to the top of the list. Follow it, so the cursor
    // stays on the directory the user was looking at rather than on whatever
    // slid into its place.
    root.focusPath(path)
  }

  function handleTextKey(text) {
    var key = String(text).toLowerCase()
    if (key === "f") root.openFiles()
    else if (key === "p") root.togglePin()
    else if (key === "r" && root.host) root.host.refresh()
  }

  // A pin removed elsewhere, or a directory that vanished between scans, can
  // leave the cursor past the end of the list.
  onRowsChanged: root.selectedIndex = Model.clampIndex(root.selectedIndex, root.rows.length)

  // ---- One row: pin marker, path, nothing else.
  component PathRow: CursorSurface {
    id: row

    required property int index
    required property var modelData

    readonly property string path: modelData ? modelData.path : ""
    readonly property bool isPinned: modelData ? modelData.pinned === true : false

    width: parent ? parent.width : 0
    height: root.rowHeight
    hasCursor: root.cursorActive && root.selectedIndex === index
    foreground: root.contentForeground
    accent: Color.accent
    fill: root.hoverFill
    currentFill: root.selectedFill

    MouseArea {
      anchors.fill: parent
      hoverEnabled: true
      acceptedButtons: Qt.LeftButton | Qt.RightButton
      cursorShape: Qt.PointingHandCursor

      onContainsMouseChanged: if (containsMouse) {
        root.cursorActive = true
        root.selectedIndex = row.index
      }

      onClicked: function(mouse) {
        root.selectedIndex = row.index
        if (mouse.button === Qt.RightButton) root.togglePin()
        else root.openTerminal()
      }
    }

    Text {
      id: pinMark
      anchors.left: parent.left
      anchors.leftMargin: Style.space(8)
      anchors.verticalCenter: parent.verticalCenter
      width: Style.space(14)
      textFormat: Text.PlainText
      text: row.isPinned ? Model.PIN_GLYPH : ""
      color: root.accentColor
      font.family: root.contentFontFamily
      font.pixelSize: Style.font.bodySmall
    }

    Text {
      anchors.left: pinMark.right
      anchors.leftMargin: Style.space(4)
      anchors.right: parent.right
      anchors.rightMargin: Style.space(8)
      anchors.verticalCenter: parent.verticalCenter
      textFormat: Text.PlainText
      text: Model.displayPath(row.path, root.home)
      color: root.contentForeground
      font.family: root.contentFontFamily
      font.pixelSize: Style.font.body
      // The tail of a path is the part that identifies it, so a long one
      // loses its head rather than its name.
      elide: Text.ElideLeft
    }
  }

  KeyboardPanel {
    id: panel
    anchorItem: root.anchorItem
    owner: root.barIdentity
    bar: root.bar
    open: root.opened
    focusTarget: keyCatcher
    contentWidth: panel.fittedContentWidth(Style.space(460))
    contentHeight: panel.fittedContentHeight(rowColumn.implicitHeight)

    PanelKeyCatcher {
      id: keyCatcher
      anchors.fill: parent

      onCloseRequested: root.close()
      onActivateRequested: root.openTerminal()
      onTabRequested: function(direction) { root.switchPanel(direction) }
      onTextKey: function(t) { root.handleTextKey(t) }
      // Down is +1. Left and right have nothing to walk here, so they are
      // left alone rather than mapped to something invented.
      onMoveRequested: function(dx, dy) { if (dy !== 0) root.moveCursor(dy) }

      Column {
        id: rowColumn
        width: parent.width
        spacing: Style.space(6)

        Text {
          width: parent.width
          textFormat: Text.PlainText
          text: "Recent Paths"
          color: root.dim
          font.family: root.contentFontFamily
          font.pixelSize: Style.font.caption
          font.letterSpacing: 1
          font.bold: true
        }

        PanelSeparator {
          width: parent.width
          foreground: root.contentForeground
        }

        Text {
          width: parent.width
          visible: root.rows.length === 0
          textFormat: Text.PlainText
          text: Model.emptyMessage(root.zoxideMissing, root.scanned, root.scanFailed)
          color: root.dim
          font.family: root.contentFontFamily
          font.pixelSize: Style.font.bodySmall
          wrapMode: Text.WordWrap
          topPadding: Style.space(6)
          bottomPadding: Style.space(6)
        }

        Flickable {
          id: scroll
          width: parent.width
          height: root.listHeight
          visible: root.rows.length > 0
          contentWidth: width
          contentHeight: root.rows.length * root.rowHeight
          clip: true
          boundsBehavior: Flickable.StopAtBounds
          interactive: contentHeight > height

          Column {
            width: scroll.width

            Repeater {
              model: root.rows
              delegate: PathRow {}
            }
          }
        }

        PanelSeparator {
          width: parent.width
          foreground: root.contentForeground
        }

        // The key rail is the plugin's promise that this thing is
        // keyboard-driven, so it stays even when the list is empty.
        Text {
          width: parent.width
          textFormat: Text.PlainText
          text: "↑↓ move   enter terminal   f files   p pin   esc close"
          color: root.dimmer
          font.family: root.contentFontFamily
          font.pixelSize: Style.font.caption
          wrapMode: Text.WordWrap
        }
      }
    }
  }
}
