#!/bin/sh
set -eu

ROOT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")/../.." && pwd)
if [ -n "${ATLAS_LIVE_PYTHON:-}" ]; then
  PYTHON_BIN=$ATLAS_LIVE_PYTHON
elif [ -x "$ROOT_DIR/.venv/bin/python" ]; then
  PYTHON_BIN="$ROOT_DIR/.venv/bin/python"
else
  PYTHON_BIN=$(command -v python3 || true)
fi
TARGET="$HOME/Library/LaunchAgents/ru.sber.atlas.live-signals.plist"
LOG_DIR="$HOME/Library/Logs/SberAtlas"

if [ ! -x "$PYTHON_BIN" ]; then
  echo "Python runtime not found: $PYTHON_BIN" >&2
  exit 1
fi
mkdir -p "$(dirname "$TARGET")" "$LOG_DIR"
cat > "$TARGET" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>ru.sber.atlas.live-signals</string>
  <key>ProgramArguments</key><array><string>$PYTHON_BIN</string><string>$ROOT_DIR/scripts/live/worker.py</string><string>--run</string></array>
  <key>WorkingDirectory</key><string>$ROOT_DIR</string>
  <key>RunAtLoad</key><true/><key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict>
  <key>ThrottleInterval</key><integer>30</integer>
  <key>StandardOutPath</key><string>$LOG_DIR/live-signals.log</string>
  <key>StandardErrorPath</key><string>$LOG_DIR/live-signals-error.log</string>
</dict></plist>
PLIST
plutil -lint "$TARGET"
echo "Wrote $TARGET. It is not loaded; activate explicitly with: launchctl bootstrap gui/$(id -u) $TARGET"
