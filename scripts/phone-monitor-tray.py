#!/usr/bin/env python3
"""
LumenDock Top Bar Indicator & Tray Application
Provides a native GNOME top-bar system tray indicator with status, logs, and a kill switch.
"""

import os
import sys
import signal
import subprocess
import threading
import time

import gi
gi.require_version('Gtk', '3.0')
gi.require_version('AyatanaAppIndicator3', '0.1')
from gi.repository import Gtk, AyatanaAppIndicator3, GLib

SCRIPT_DIR = os.path.dirname(os.path.realpath(__file__))
ROOT_DIR = os.path.dirname(SCRIPT_DIR)
SH_SCRIPT = os.path.join(SCRIPT_DIR, "phone-monitor.sh")

CONFIG_DIR = os.path.expanduser("~/.config/phone-monitor")
TRAY_PID_FILE = os.path.join(CONFIG_DIR, "phone-monitor-tray.pid")
ICON_PATH = os.path.expanduser("~/.local/share/icons/hicolor/48x48/apps/phone-monitor.png")
if not os.path.exists(ICON_PATH):
    ICON_PATH = "phone"


class PhoneMonitorTray:
    def __init__(self):
        self.indicator = AyatanaAppIndicator3.Indicator.new(
            "phone-monitor",
            ICON_PATH,
            AyatanaAppIndicator3.IndicatorCategory.APPLICATION_STATUS
        )
        self.indicator.set_status(AyatanaAppIndicator3.IndicatorStatus.ACTIVE)
        if os.path.exists(ICON_PATH):
            self.indicator.set_icon_full(ICON_PATH, "LumenDock")

        self.status_text = "Starting..."
        self.detail_text = ""
        self.is_running = False

        self.menu = Gtk.Menu()
        self._build_menu()
        self.indicator.set_menu(self.menu)

        # Check single instance
        self._check_single_instance()

        # Start services if not running
        threading.Thread(target=self._initial_start, daemon=True).start()

        # Periodic status check
        GLib.timeout_add_seconds(3, self._poll_status)

    def _check_single_instance(self):
        try:
            if os.path.exists(TRAY_PID_FILE):
                with open(TRAY_PID_FILE, "r") as f:
                    old_pid = int(f.read().strip())
                # Check if old pid is alive
                os.kill(old_pid, 0)
                print(f"LumenDock tray is already running (PID {old_pid}). Exiting.")
                sys.exit(0)
        except (ValueError, OSError):
            pass
        with open(TRAY_PID_FILE, "w") as f:
            f.write(str(os.getpid()))

    def _build_menu(self):
        # Header / Status Item
        self.item_status = Gtk.MenuItem(label="● LumenDock: Checking...")
        self.item_status.set_sensitive(False)
        self.menu.append(self.item_status)

        # Detail item
        self.item_detail = Gtk.MenuItem(label="Hub: 127.0.0.1:8765")
        self.item_detail.set_sensitive(False)
        self.menu.append(self.item_detail)

        self.menu.append(Gtk.SeparatorMenuItem())

        # Restart item
        self.item_restart = Gtk.MenuItem(label="Restart Services")
        self.item_restart.connect("activate", self._on_restart)
        self.menu.append(self.item_restart)

        # View logs item
        self.item_logs = Gtk.MenuItem(label="Open Log Directory")
        self.item_logs.connect("activate", self._on_open_logs)
        self.menu.append(self.item_logs)

        self.menu.append(Gtk.SeparatorMenuItem())

        # Kill / Quit Item
        self.item_quit_all = Gtk.MenuItem(label="Quit & Stop LumenDock")
        self.item_quit_all.connect("activate", self._on_quit_all)
        self.menu.append(self.item_quit_all)

        self.menu.show_all()

    def _initial_start(self):
        try:
            # Check if running first
            res = subprocess.run([SH_SCRIPT, "status"], capture_output=True, text=True)
            if res.returncode != 0:
                GLib.idle_add(self._update_ui_state, "⏳ Starting services...", "Please wait...")
                subprocess.run([SH_SCRIPT, "start"], capture_output=True, text=True)
        except Exception as e:
            print(f"Error during initial start: {e}", file=sys.stderr)
        self._check_status_now()

    def _poll_status(self):
        threading.Thread(target=self._check_status_now, daemon=True).start()
        return True

    def _check_status_now(self):
        try:
            res = subprocess.run([SH_SCRIPT, "status"], capture_output=True, text=True, timeout=5)
            output = res.stdout
            is_active = (res.returncode == 0)

            if is_active:
                status = "● LumenDock: Connected"
                detail = "Hub: 127.0.0.1:8765 | USB Reverse: Active"
            else:
                if "Active ADB reverse mappings" in output:
                    status = "● LumenDock: Reverse Active (Hub Stopped)"
                    detail = "Hub stopped"
                else:
                    status = "○ LumenDock: Stopped"
                    detail = "Services offline"

            GLib.idle_add(self._update_ui_state, status, detail, is_active)
        except Exception:
            GLib.idle_add(self._update_ui_state, "○ LumenDock: Offline", "Cannot reach service", False)

    def _update_ui_state(self, status, detail, is_active=True):
        self.item_status.set_label(status)
        self.item_detail.set_label(detail)
        self.is_running = is_active
        if is_active:
            self.indicator.set_status(AyatanaAppIndicator3.IndicatorStatus.ACTIVE)
        else:
            self.indicator.set_status(AyatanaAppIndicator3.IndicatorStatus.ATTENTION)

    def _on_restart(self, _widget):
        def _do_restart():
            GLib.idle_add(self._update_ui_state, "⏳ Restarting...", "Stopping & restarting...")
            subprocess.run([SH_SCRIPT, "restart"], capture_output=True, text=True)
            self._check_status_now()
        threading.Thread(target=_do_restart, daemon=True).start()

    def _on_open_logs(self, _widget):
        subprocess.Popen(["xdg-open", CONFIG_DIR])

    def _on_quit_all(self, _widget):
        self.item_status.set_label("⏳ Stopping LumenDock...")
        # Stop background services
        try:
            subprocess.run([SH_SCRIPT, "stop"], capture_output=True, text=True, timeout=10)
        except Exception as e:
            print(f"Error stopping: {e}", file=sys.stderr)
        self._cleanup()
        Gtk.main_quit()

    def _cleanup(self):
        try:
            if os.path.exists(TRAY_PID_FILE):
                os.remove(TRAY_PID_FILE)
        except OSError:
            pass


def main():
    signal.signal(signal.SIGINT, lambda _s, _f: Gtk.main_quit())
    signal.signal(signal.SIGTERM, lambda _s, _f: Gtk.main_quit())

    tray = PhoneMonitorTray()
    try:
        Gtk.main()
    finally:
        tray._cleanup()


if __name__ == "__main__":
    main()
