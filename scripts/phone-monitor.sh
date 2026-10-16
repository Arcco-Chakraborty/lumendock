#!/usr/bin/env bash
set -euo pipefail

# LumenDock laptop service controller (manual background execution)
# Manages both the desktop hub and the ADB reverse supervisor in the background.

# Determine repository root
SOURCE="${BASH_SOURCE[0]}"
while [ -h "$SOURCE" ]; do
  DIR="$(cd -P "$(dirname "$SOURCE")" && pwd)"
  SOURCE="$(readlink "$SOURCE")"
  [[ $SOURCE != /* ]] && SOURCE="$DIR/$SOURCE"
done
SCRIPT_DIR="$(cd -P "$(dirname "$SOURCE")" && pwd)"
if [ -f "$SCRIPT_DIR/package.json" ]; then
  ROOT_DIR="$SCRIPT_DIR"
else
  ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
fi

# Ensure Node 24 from project toolchain if available
TC="${HOME}/.local/share/phone-monitor/toolchains"
if [ -d "$TC/node-v24.22.0-linux-x64/bin" ]; then
  export PATH="$TC/node-v24.22.0-linux-x64/bin:$PATH"
fi

CONFIG_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/phone-monitor"
mkdir -p "$CONFIG_DIR"
chmod 0700 "$CONFIG_DIR"

PID_FILE="$CONFIG_DIR/phone-monitor.pid"
HUB_LOG="$CONFIG_DIR/hub.log"
CONNECT_LOG="$CONFIG_DIR/connect.log"

mask_serial() {
  local s="$1"
  if [ ${#s} -le 4 ]; then
    echo "****"
  else
    echo "${s:0:4}****"
  fi
}

get_single_serial() {
  local serial
  serial="$(adb get-serialno 2>/dev/null || true)"
  if [ -n "$serial" ] && [ "$serial" != "unknown" ] && [[ "$serial" != *"more than one"* ]]; then
    echo "$serial"
    return 0
  fi
  # Fallback to parsing adb devices
  local count
  count="$(adb devices | awk 'NR>1 && $2=="device" {print $1}' | wc -l)"
  if [ "$count" -eq 1 ]; then
    adb devices | awk 'NR>1 && $2=="device" {print $1}'
    return 0
  fi
  return 1
}

do_status() {
  local running_hub=0
  local running_conn=0
  local hub_pid=""
  local conn_pid=""

  if [ -f "$PID_FILE" ]; then
    read -r hub_pid conn_pid < "$PID_FILE" || true
    if [ -n "$hub_pid" ] && kill -0 "$hub_pid" 2>/dev/null; then
      running_hub=1
    fi
    if [ -n "$conn_pid" ] && kill -0 "$conn_pid" 2>/dev/null; then
      running_conn=1
    fi
  fi

  # Fallback process scan if pid file missing or stale
  if [ $running_hub -eq 0 ]; then
    local p
    p="$(pgrep -f "node.*desktop/dist/main.js" 2>/dev/null | head -n1 || true)"
    if [ -n "$p" ]; then running_hub=1; hub_pid="$p"; fi
  fi
  if [ $running_conn -eq 0 ]; then
    local p
    p="$(pgrep -f "node.*scripts/connect.mjs" 2>/dev/null | head -n1 || true)"
    if [ -n "$p" ]; then running_conn=1; conn_pid="$p"; fi
  fi

  echo "LumenDock background status:"
  if [ $running_hub -eq 1 ]; then
    echo "  [RUNNING] Desktop Hub (PID: $hub_pid) on 127.0.0.1:8765"
  else
    echo "  [STOPPED] Desktop Hub"
  fi

  if [ $running_conn -eq 1 ]; then
    echo "  [RUNNING] ADB Reverse Supervisor (PID: $conn_pid)"
  else
    echo "  [STOPPED] ADB Reverse Supervisor"
  fi

  local rev
  rev="$(adb reverse --list 2>/dev/null || true)"
  if [ -n "$rev" ]; then
    echo "  Active ADB reverse mappings: $rev"
  fi

  if [ $running_hub -eq 1 ] && [ $running_conn -eq 1 ]; then
    return 0
  else
    return 1
  fi
}

do_start() {
  if do_status >/dev/null 2>&1; then
    echo "LumenDock is already running."
    do_status
    return 0
  fi

  # Clean up any partial state
  do_stop >/dev/null 2>&1 || true

  local target_serial="${1:-}"
  if [ -z "$target_serial" ]; then
    if ! target_serial="$(get_single_serial)"; then
      echo "Error: No single authorized USB device detected." >&2
      echo "Connect your phone with USB debugging enabled, or specify serial: $0 start SERIAL" >&2
      return 1
    fi
  fi

  cd "$ROOT_DIR"

  # Ensure desktop build exists
  if [ ! -f "desktop/dist/main.js" ]; then
    echo "Building desktop hub..."
    npm run build --workspace @phone-monitor/desktop
  fi

  local masked
  masked="$(mask_serial "$target_serial")"
  echo "Starting LumenDock for device $masked..."

  # Start hub detached from controlling terminal
  setsid node desktop/dist/main.js </dev/null >> "$HUB_LOG" 2>&1 &
  local hub_pid=$!

  # Start connect supervisor detached from controlling terminal
  setsid node scripts/connect.mjs --serial "$target_serial" </dev/null >> "$CONNECT_LOG" 2>&1 &
  local conn_pid=$!

  echo "$hub_pid $conn_pid" > "$PID_FILE"

  sleep 1.5

  if kill -0 "$hub_pid" 2>/dev/null && kill -0 "$conn_pid" 2>/dev/null; then
    echo "LumenDock started successfully in background."
    echo "  Hub PID: $hub_pid (logs: $HUB_LOG)"
    echo "  ADB Connect PID: $conn_pid (logs: $CONNECT_LOG)"
    echo "Run '$0 status' to check state, '$0 logs' to view logs, or '$0 stop' to terminate."
  else
    echo "Error: Failed to start LumenDock processes. Check logs:" >&2
    tail -n 20 "$HUB_LOG" >&2
    tail -n 20 "$CONNECT_LOG" >&2
    do_stop >/dev/null 2>&1 || true
    return 1
  fi
}

do_stop() {
  local hub_pid=""
  local conn_pid=""

  if [ -f "$PID_FILE" ]; then
    read -r hub_pid conn_pid < "$PID_FILE" || true
    rm -f "$PID_FILE"
  fi

  # Only ever signal real node processes: a shell whose command line merely
  # mentions these paths (or a recycled PID from a stale PID file) is left alone.
  is_node() { [ "$(basename "$(readlink "/proc/$1/exe" 2>/dev/null)")" = "node" ]; }
  local pids=()
  [ -n "$hub_pid" ] && is_node "$hub_pid" && pids+=("$hub_pid")
  [ -n "$conn_pid" ] && is_node "$conn_pid" && pids+=("$conn_pid")

  # Also discover any lingering processes by commandline pattern
  while IFS= read -r p; do
    [ -n "$p" ] && is_node "$p" && pids+=("$p")
  done < <(pgrep -f "node.*desktop/dist/main.js|node.*scripts/connect.mjs" 2>/dev/null || true)

  if [ ${#pids[@]} -eq 0 ]; then
    echo "LumenDock is not running."
    return 0
  fi

  # De-duplicate pids
  local -A seen=()
  local unique_pids=()
  for p in "${pids[@]}"; do
    if [ -z "${seen[$p]:-}" ]; then
      seen[$p]=1
      unique_pids+=("$p")
    fi
  done

  echo "Stopping LumenDock (PIDs: ${unique_pids[*]})..."
  for p in "${unique_pids[@]}"; do
    kill -15 "$p" 2>/dev/null || true
  done

  # Wait up to 4 seconds for clean exit
  local waited=0
  while [ $waited -lt 8 ]; do
    local any_alive=0
    for p in "${unique_pids[@]}"; do
      if kill -0 "$p" 2>/dev/null; then
        any_alive=1
        break
      fi
    done
    if [ $any_alive -eq 0 ]; then
      break
    fi
    sleep 0.5
    waited=$((waited + 1))
  done

  # Force kill any stubborn remnants
  for p in "${unique_pids[@]}"; do
    if kill -0 "$p" 2>/dev/null; then
      kill -9 "$p" 2>/dev/null || true
    fi
  done

  echo "LumenDock stopped."
}

do_logs() {
  touch "$HUB_LOG" "$CONNECT_LOG"
  echo "Streaming LumenDock logs (Ctrl-C to exit)..."
  tail -n 30 -f "$HUB_LOG" "$CONNECT_LOG"
}

do_tray() {
  exec python3 "$SCRIPT_DIR/phone-monitor-tray.py" "$@"
}

action="${1:-}"
case "$action" in
  start)
    shift
    do_start "${1:-}"
    ;;
  stop)
    do_stop
    ;;
  restart)
    shift
    do_stop
    sleep 1
    do_start "${1:-}"
    ;;
  status)
    do_status
    ;;
  logs)
    do_logs
    ;;
  tray)
    shift
    do_tray "$@"
    ;;
  *)
    echo "Usage: $0 {start [SERIAL]|stop|restart [SERIAL]|status|logs|tray}" >&2
    exit 1
    ;;
esac
