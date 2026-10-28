#!/usr/bin/env bash
set -euo pipefail

# Adds a LumenDock launcher to the app grid and the desktop. Opening it starts the tray
# indicator, which starts the hub and the USB link; "Quit & Stop" in its menu ends them.
# Nothing is added to autostart: LumenDock runs only when you open it.
#
#   scripts/linux/install-desktop.sh            install or update the launcher
#   scripts/linux/install-desktop.sh --remove   remove it again

ROOT_DIR="$(cd "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")/../.." && pwd)"
DATA_DIR="${XDG_DATA_HOME:-$HOME/.local/share}"
APPS_DIR="$DATA_DIR/applications"
ICONS_DIR="$DATA_DIR/icons/hicolor"
DESKTOP_DIR="$(xdg-user-dir DESKTOP 2>/dev/null || true)"
[ -n "$DESKTOP_DIR" ] || DESKTOP_DIR="$HOME/Desktop"
ENTRY="lumendock.desktop"

if [ "${1:-}" = "--remove" ]; then
  rm -f "$APPS_DIR/$ENTRY" "$DESKTOP_DIR/$ENTRY" "$ICONS_DIR/256x256/apps/lumendock.png" "$ICONS_DIR/48x48/apps/phone-monitor.png"
  update-desktop-database "$APPS_DIR" >/dev/null 2>&1 || true
  echo "LumenDock launcher removed."
  exit 0
fi
if [ -n "${1:-}" ]; then
  echo "Usage: $0 [--remove]" >&2
  exit 2
fi

# The tray needs GTK and the AppIndicator bindings (preinstalled on Ubuntu with GNOME).
if ! python3 -c "import gi; gi.require_version('Gtk', '3.0'); gi.require_version('AyatanaAppIndicator3', '0.1')" >/dev/null 2>&1; then
  echo "Note: the tray needs: sudo apt install python3-gi gir1.2-ayatanaappindicator3-0.1" >&2
fi

install -Dm644 "$ROOT_DIR/scripts/linux/lumendock.png" "$ICONS_DIR/256x256/apps/lumendock.png"
# The tray looks for its icon under this name.
install -Dm644 "$ROOT_DIR/scripts/linux/lumendock-48.png" "$ICONS_DIR/48x48/apps/phone-monitor.png"
chmod 0755 "$ROOT_DIR/phone-monitor.sh" "$ROOT_DIR/scripts/phone-monitor.sh" "$ROOT_DIR/scripts/phone-monitor-tray.py" 2>/dev/null || true

# The launcher quotes the path (spaces are fine); these four characters would need Desktop
# Entry escaping, so such a folder is refused instead.
EXEC_PATH="$ROOT_DIR/phone-monitor.sh"
case "$EXEC_PATH" in
  *'"'* | *'`'* | *'$'* | *'\'*)
    echo "Move LumenDock to a folder whose path has no \" \` \$ or \\ characters, then run this again." >&2
    exit 1 ;;
esac
mkdir -p "$APPS_DIR"
cat > "$APPS_DIR/$ENTRY" <<EOF
[Desktop Entry]
Type=Application
Name=LumenDock
Comment=Phone desk display: start the hub and USB link with a tray icon
Exec="$EXEC_PATH" tray
Icon=lumendock
Terminal=false
Categories=Utility;
StartupNotify=false
EOF
chmod 0755 "$APPS_DIR/$ENTRY"
update-desktop-database "$APPS_DIR" >/dev/null 2>&1 || true
gtk-update-icon-cache -q "$ICONS_DIR" >/dev/null 2>&1 || true

if [ -d "$DESKTOP_DIR" ]; then
  install -m755 "$APPS_DIR/$ENTRY" "$DESKTOP_DIR/$ENTRY"
  # GNOME runs desktop launchers only once they are marked trusted.
  gio set "$DESKTOP_DIR/$ENTRY" metadata::trusted true >/dev/null 2>&1 || true
  echo "LumenDock launcher added to the app grid and $DESKTOP_DIR (no autostart)."
else
  echo "LumenDock launcher added to the app grid (no autostart)."
fi
