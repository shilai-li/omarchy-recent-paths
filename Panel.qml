import QtQuick
import qs.Commons
import qs.Commons as Commons
import qs.Ui
import "Model.js" as Model

// The list: pinned directories in one group, zoxide's ranking in another,
// each row the directory's name over the place it lives.
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

  readonly property bool hasRows: rows.length > 0
  readonly property string scanState: Model.scanState(zoxideMissing, scanned, scanFailed)
  readonly property bool scanUrgent: Model.statusIsUrgent(scanState)
  readonly property string notice: hasRows ? Model.noticeMessage(zoxideMissing, scanned, scanFailed) : ""

  property int selectedIndex: 0
  property bool cursorActive: false

  readonly property string currentPath: selectedIndex >= 0 && selectedIndex < rows.length
    ? rows[selectedIndex].path
    : ""

  // ---- Theme. Nothing here names a color; the palette does. Every fill is
  //      one of the shell's state tokens, so a theme that tunes its hover or
  //      selection alphas tunes this panel with them.
  readonly property color contentForeground: bar ? bar.foreground : Commons.Color.foreground
  readonly property string contentFontFamily: bar ? bar.fontFamily : Style.font.family
  readonly property color dim: Qt.darker(contentForeground, 1.5)
  readonly property color dimmer: Qt.darker(contentForeground, 2.0)
  readonly property color accentColor: Commons.Color.accent
  readonly property color urgentColor: Commons.Color.urgent
  // Ink on an accent-filled tile: the background is the one palette color
  // a theme guarantees reads against its own accent.
  readonly property color onAccent: Commons.Color.background
  readonly property color groupFill: Style.normalFillFor(contentForeground, accentColor)
  readonly property color chipFill: Style.hoverFillFor(contentForeground, accentColor)
  readonly property color tileFill: Style.selectedFillFor(contentForeground, accentColor)
  readonly property color urgentFill: Style.selectedFillFor(urgentColor, urgentColor)
  readonly property color hoverFill: Style.hoverFillFor(contentForeground, accentColor)
  readonly property color selectedFill: Style.selectedFillFor(contentForeground, accentColor)

  // ---- Geometry. A group sits a little outside its rows so the cursor fill
  //      has room to show its own corners; with a square theme both are 0.
  readonly property int groupInset: Style.space(4)
  readonly property int groupRadius: Style.cornerRadius > 0 ? Style.cornerRadius + groupInset : 0
  readonly property int tileSize: Style.space(30)
  readonly property int rowHeight: Math.max(tileSize + Style.space(16),
    Math.ceil((Style.font.body + Style.font.bodySmall) * 1.35) + Style.space(14))
  // Ten rows before the list starts scrolling, plus room for the two group
  // titles. The panel is a shortcut, not a window: past this it stops being
  // something you read at a glance.
  readonly property int listCap: rowHeight * 10 + Style.space(72)

  // Pills and chips follow the theme's rounding but never past a capsule.
  function capsuleRadius(height) { return Math.min(Style.cornerRadius, height / 2) }

  // ---- Lifecycle. Mirrors the clock's: the popout coordinator is handed
  //      over on show, so the hover-reveal flag is set after, not before.
  function open() {
    root.selectedIndex = 0
    root.cursorActive = true
    pathList.positionViewAtBeginning()
    // The list is only ever looked at while it is open, so this is the one
    // moment it needs to be true. A directory removed since the last open
    // disappears here rather than failing on Enter.
    if (root.host) root.host.refresh()
    root.controller.show()
    Qt.callLater(function() {
      if (root.opened) root.setCenterHoverRevealSuppressed(true)
    })
  }

  // The hide goes first. Everything after it is cosmetic, and this panel is
  // a full-screen layer-shell surface holding keyboard focus: a call that
  // throws before the hide lands leaves the user with no way out of it and a
  // bar that no longer answers. Nothing decorative gets to stand in front of
  // the one line that releases the screen.
  function close() {
    root.controller.hide()
    root.setCenterHoverRevealSuppressed(false)
  }

  function toggle() { root.opened ? root.close() : root.open() }

  function switchPanel(direction) {
    if (root.bar && typeof root.bar.switchPanelFrom === "function")
      return root.bar.switchPanelFrom(root.barIdentity, direction)
    return false
  }

  // Summoning by hotkey moves no pointer, so a hover the bar was still
  // holding must not keep the center indicators revealed behind the panel.
  //
  // The setter is the supported route: the `bar` a plugin is handed is a
  // PluginBarApi facade, where this flag is readonly and backed by a scoped
  // callback. Assigning to it throws rather than failing quietly, which is
  // why the direct write is only the fallback for a host that predates the
  // setter — and why it is now second.
  function setCenterHoverRevealSuppressed(value) {
    if (root.bar && typeof root.bar.setCenterHoverRevealSuppressed === "function")
      root.bar.setCenterHoverRevealSuppressed(value)
    else if (root.bar && "centerHoverRevealSuppressed" in root.bar)
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

  // Deferred a turn, as bluetooth's list does: a pin rebuilds `rows`, and
  // the view repositioned straight out of that change is repositioned against
  // delegates that are about to be replaced. Contain only moves when the row
  // is actually clipped, so a hovering mouse never makes the list lurch.
  function ensureVisible() {
    Qt.callLater(function() {
      if (root.selectedIndex >= 0 && root.selectedIndex < pathList.count)
        pathList.positionViewAtIndex(root.selectedIndex, ListView.Contain)
    })
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
    // Pinning moves the row into the other group. Follow it, so the cursor
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

  // ---- One row: a tile that says pinned or not, the name over its parent,
  //      and — on the row under the cursor only — the three things a row can
  //      do, for the mouse. The keys do the same without them.
  component PathRow: CursorSurface {
    id: row

    required property int index
    required property var modelData

    readonly property string path: modelData ? modelData.path : ""
    readonly property bool isPinned: modelData ? modelData.pinned === true : false
    readonly property var label: Model.splitDisplayPath(row.path, root.home)

    hasCursor: root.cursorActive && root.selectedIndex === index
    foreground: root.contentForeground
    accent: root.accentColor
    fill: root.hoverFill
    currentFill: root.selectedFill

    // Every action names its row first, so a click lands on the directory
    // under the pointer even if the keyboard had the cursor somewhere else.
    function pick() {
      root.cursorActive = true
      root.selectedIndex = row.index
    }

    MouseArea {
      anchors.fill: parent
      hoverEnabled: true
      acceptedButtons: Qt.LeftButton | Qt.RightButton
      cursorShape: Qt.PointingHandCursor

      onContainsMouseChanged: if (containsMouse) row.pick()

      onClicked: function(mouse) {
        row.pick()
        if (mouse.button === Qt.RightButton) root.togglePin()
        else root.openTerminal()
      }
    }

    Rectangle {
      id: tile
      anchors.left: parent.left
      anchors.leftMargin: Style.space(8)
      anchors.verticalCenter: parent.verticalCenter
      width: root.tileSize
      height: root.tileSize
      radius: root.capsuleRadius(height)
      color: row.isPinned ? root.accentColor : root.tileFill

      Text {
        anchors.centerIn: parent
        textFormat: Text.PlainText
        text: row.isPinned ? Model.GLYPH.star : Model.GLYPH.folder
        color: row.isPinned ? root.onAccent : root.contentForeground
        font.family: root.contentFontFamily
        font.pixelSize: Style.font.icon
      }
    }

    Column {
      anchors.left: tile.right
      anchors.leftMargin: Style.space(12)
      anchors.right: actions.visible ? actions.left : parent.right
      anchors.rightMargin: Style.space(8)
      anchors.verticalCenter: parent.verticalCenter
      spacing: Style.space(2)

      Text {
        width: parent.width
        textFormat: Text.PlainText
        text: row.label.name
        color: root.contentForeground
        font.family: root.contentFontFamily
        font.pixelSize: Style.font.body
        font.bold: true
        elide: Text.ElideRight
      }

      // The tail of the parent is the part nearest the name, so a long one
      // loses its head rather than its end.
      Text {
        width: parent.width
        visible: row.label.parent !== ""
        textFormat: Text.PlainText
        text: row.label.parent
        color: root.dim
        font.family: root.contentFontFamily
        font.pixelSize: Style.font.bodySmall
        elide: Text.ElideLeft
      }
    }

    Row {
      id: actions
      anchors.right: parent.right
      anchors.rightMargin: Style.space(6)
      anchors.verticalCenter: parent.verticalCenter
      spacing: Style.space(2)
      visible: row.hasCursor

      PanelActionButton {
        iconText: Model.GLYPH.terminal
        tooltipText: "Open in terminal  (enter)"
        foreground: root.dim
        hoverColor: root.contentForeground
        fontFamily: root.contentFontFamily
        onClicked: { row.pick(); root.openTerminal() }
      }

      PanelActionButton {
        iconText: Model.GLYPH.folderOpen
        tooltipText: "Open in file manager  (f)"
        foreground: root.dim
        hoverColor: root.contentForeground
        fontFamily: root.contentFontFamily
        onClicked: { row.pick(); root.openFiles() }
      }

      PanelActionButton {
        iconText: row.isPinned ? Model.GLYPH.star : Model.GLYPH.starOutline
        tooltipText: row.isPinned ? "Unpin  (p)" : "Pin  (p)"
        foreground: row.isPinned ? root.accentColor : root.dim
        hoverColor: root.accentColor
        fontFamily: root.contentFontFamily
        onClicked: { row.pick(); root.togglePin() }
      }
    }
  }

  KeyboardPanel {
    id: panel
    anchorItem: root.anchorItem
    owner: root.barIdentity
    bar: root.bar
    open: root.opened
    focusTarget: keyCatcher
    contentWidth: panel.fittedContentWidth(Style.space(380))
    contentHeight: panel.fittedContentHeight(content.implicitHeight)

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
        id: content
        width: parent.width
        spacing: Style.space(12)

        // ---- Header: what this is, and where the scan stands.
        Item {
          width: parent.width
          height: Math.max(titleRow.implicitHeight, badge.height)

          Row {
            id: titleRow
            anchors.left: parent.left
            anchors.leftMargin: Style.space(4)
            anchors.verticalCenter: parent.verticalCenter
            spacing: Style.space(8)

            Text {
              anchors.verticalCenter: parent.verticalCenter
              textFormat: Text.PlainText
              text: Model.GLYPH.folder
              color: root.scanUrgent ? root.dim : root.accentColor
              font.family: root.contentFontFamily
              font.pixelSize: Style.font.icon
            }

            Text {
              anchors.verticalCenter: parent.verticalCenter
              textFormat: Text.PlainText
              text: "Recent Paths"
              color: root.contentForeground
              font.family: root.contentFontFamily
              font.pixelSize: Style.font.title
              font.bold: true
            }
          }

          Rectangle {
            id: badge
            anchors.right: parent.right
            anchors.rightMargin: Style.space(4)
            anchors.verticalCenter: parent.verticalCenter
            width: badgeText.implicitWidth + Style.space(16)
            height: badgeText.implicitHeight + Style.space(4)
            radius: root.capsuleRadius(height)
            color: root.scanUrgent ? root.urgentFill : root.chipFill

            Text {
              id: badgeText
              anchors.centerIn: parent
              textFormat: Text.PlainText
              text: Model.statusLabel(root.scanState, root.rows.length)
              color: root.scanUrgent ? root.urgentColor : root.dim
              font.family: root.contentFontFamily
              font.pixelSize: Style.font.caption
              font.bold: true
            }
          }
        }

        // ---- The list. A ListView rather than a Flickable over a Column: it
        //      owns the scroll position, so keeping the cursor row in view is
        //      one call, and the group titles riding inside the delegates are
        //      counted for free.
        ListView {
          id: pathList
          width: parent.width
          height: Math.min(contentHeight, root.listCap)
          visible: root.hasRows
          clip: true
          boundsBehavior: Flickable.StopAtBounds
          interactive: contentHeight > height
          model: root.rows

          delegate: Item {
            id: slot

            required property var modelData
            required property int index

            readonly property string section: Model.sectionTitle(root.rows, index)
            readonly property bool groupStart: section !== ""
            readonly property bool groupEnd: Model.isGroupEnd(root.rows, index)

            width: ListView.view.width
            height: slotColumn.implicitHeight

            Column {
              id: slotColumn
              width: parent.width

              // Air between the two groups.
              Item {
                width: 1
                height: slot.groupStart && slot.index > 0 ? Style.space(12) : 0
              }

              PanelSectionHeader {
                visible: slot.groupStart
                height: visible ? implicitHeight + Style.space(6) : 0
                leftPadding: Style.space(12)
                text: slot.section
                font.capitalization: Font.AllUppercase
                font.letterSpacing: 1
                foreground: root.contentForeground
                fontFamily: root.contentFontFamily
              }

              // The group's fill is drawn a row at a time, rounded only where
              // the group starts and ends, so the list stays one flat model
              // and pinning needs no regrouping.
              Rectangle {
                width: parent.width
                height: root.rowHeight
                  + (slot.groupStart ? root.groupInset : 0)
                  + (slot.groupEnd ? root.groupInset : 0)
                color: root.groupFill
                topLeftRadius: slot.groupStart ? root.groupRadius : 0
                topRightRadius: slot.groupStart ? root.groupRadius : 0
                bottomLeftRadius: slot.groupEnd ? root.groupRadius : 0
                bottomRightRadius: slot.groupEnd ? root.groupRadius : 0

                PathRow {
                  x: root.groupInset
                  y: slot.groupStart ? root.groupInset : 0
                  width: parent.width - root.groupInset * 2
                  height: root.rowHeight
                  index: slot.index
                  modelData: slot.modelData
                }
              }
            }
          }
        }

        // ---- A list that is on screen but not the whole story says so.
        Rectangle {
          width: parent.width
          visible: root.notice !== ""
          height: visible ? noticeText.implicitHeight + Style.space(24) : 0
          radius: root.groupRadius
          color: root.groupFill

          Text {
            id: noticeGlyph
            anchors.left: parent.left
            anchors.leftMargin: Style.space(14)
            anchors.top: noticeText.top
            textFormat: Text.PlainText
            text: Model.GLYPH.alert
            color: root.urgentColor
            font.family: root.contentFontFamily
            font.pixelSize: Style.font.icon
          }

          Text {
            id: noticeText
            anchors.left: noticeGlyph.right
            anchors.leftMargin: Style.space(10)
            anchors.right: parent.right
            anchors.rightMargin: Style.space(14)
            anchors.verticalCenter: parent.verticalCenter
            textFormat: Text.PlainText
            text: root.notice
            color: root.dim
            font.family: root.contentFontFamily
            font.pixelSize: Style.font.bodySmall
            wrapMode: Text.WordWrap
          }
        }

        // ---- No list: one centered statement of which kind of empty this
        //      is, because only one of the four is the user's to fix.
        Rectangle {
          width: parent.width
          visible: !root.hasRows
          height: visible ? emptyColumn.implicitHeight + Style.space(48) : 0
          radius: root.groupRadius
          color: root.groupFill

          Column {
            id: emptyColumn
            anchors.centerIn: parent
            width: parent.width - Style.space(48)
            spacing: Style.space(10)

            Rectangle {
              anchors.horizontalCenter: parent.horizontalCenter
              width: Style.space(56)
              height: width
              radius: root.capsuleRadius(height)
              color: root.scanUrgent ? root.urgentFill : root.tileFill

              Text {
                anchors.centerIn: parent
                textFormat: Text.PlainText
                text: Model.emptyGlyph(root.scanState)
                color: root.scanUrgent ? root.urgentColor : root.contentForeground
                font.family: root.contentFontFamily
                font.pixelSize: Style.font.display
              }
            }

            Text {
              width: parent.width
              horizontalAlignment: Text.AlignHCenter
              textFormat: Text.PlainText
              text: Model.emptyTitle(root.scanState)
              color: root.contentForeground
              font.family: root.contentFontFamily
              font.pixelSize: Style.font.title
              font.bold: true
            }

            Text {
              width: parent.width
              horizontalAlignment: Text.AlignHCenter
              textFormat: Text.PlainText
              text: Model.emptyMessage(root.zoxideMissing, root.scanned, root.scanFailed)
              color: root.dim
              font.family: root.contentFontFamily
              font.pixelSize: Style.font.bodySmall
              wrapMode: Text.WordWrap
            }
          }
        }

        // ---- The key rail is the plugin's promise that this thing is
        //      keyboard-driven, so it stays even when the list is empty — it
        //      just offers the keys that still do something.
        Item {
          width: parent.width
          height: rail.implicitHeight + Style.space(4)

          Row {
            id: rail
            anchors.horizontalCenter: parent.horizontalCenter
            anchors.bottom: parent.bottom
            spacing: Style.space(12)

            Repeater {
              model: Model.railKeys(root.hasRows)

              Row {
                required property var modelData
                spacing: Style.space(4)

                Rectangle {
                  anchors.verticalCenter: parent.verticalCenter
                  width: keyText.implicitWidth + Style.space(10)
                  height: keyText.implicitHeight + Style.space(2)
                  radius: root.capsuleRadius(Style.space(10))
                  color: root.tileFill

                  Text {
                    id: keyText
                    anchors.centerIn: parent
                    textFormat: Text.PlainText
                    text: modelData.key
                    color: root.dim
                    font.family: root.contentFontFamily
                    font.pixelSize: Style.font.caption
                    font.bold: true
                  }
                }

                Text {
                  anchors.verticalCenter: parent.verticalCenter
                  textFormat: Text.PlainText
                  text: modelData.label
                  color: root.dimmer
                  font.family: root.contentFontFamily
                  font.pixelSize: Style.font.caption
                }
              }
            }
          }
        }
      }
    }
  }
}
