#!/usr/bin/env bash
# Launch the Temperature & System Monitor dashboard.
#
#   ./run.sh                 # serve on http://localhost:8420 (localhost only)
#   ./run.sh --port 9000     # custom port
#   ./run.sh --interval 2    # sample every 2 seconds
#   ./run.sh --host 0.0.0.0  # expose on your LAN (be deliberate about this)
#   ./run.sh --open          # also open it in your browser
set -euo pipefail

cd "$(dirname "$0")"

OPEN=0
ARGS=()
for a in "$@"; do
  if [[ "$a" == "--open" ]]; then OPEN=1; else ARGS+=("$a"); fi
done

# Prefer the project virtualenv created by setup.sh; fall back to system python.
if [[ -x "./.venv/bin/python3" ]]; then
  PY="./.venv/bin/python3"
else
  PY="python3"
fi

# Ensure psutil is importable; point at setup.sh if not.
if ! "$PY" -c "import psutil" >/dev/null 2>&1; then
  echo "psutil is not installed. Run the one-time setup first:"
  echo "    ./setup.sh"
  echo "or install psutil manually:  $PY -m pip install --user psutil"
  exit 1
fi

PORT=8420
for ((i=0; i<${#ARGS[@]}; i++)); do
  if [[ "${ARGS[$i]}" == "--port" ]]; then PORT="${ARGS[$((i+1))]:-8420}"; fi
done

if [[ "$OPEN" == "1" ]]; then
  ( sleep 1.5; xdg-open "http://localhost:${PORT}" >/dev/null 2>&1 || true ) &
fi

exec "$PY" server.py "${ARGS[@]}"
