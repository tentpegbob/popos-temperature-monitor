#!/usr/bin/env bash
#
# setup.sh — one-time setup for the Temperature & System Monitor.
#
# Creates a self-contained Python virtualenv with the only hard dependency
# (psutil), then reports which optional sensor tools are available. It never
# needs root and touches nothing outside this folder.
#
#   ./setup.sh
#
set -euo pipefail
cd "$(dirname "$0")"

bold() { printf '\033[1m%s\033[0m\n' "$*"; }
ok()   { printf '  \033[32m✓\033[0m %s\n' "$*"; }
no()   { printf '  \033[33m✗\033[0m %s\n' "$*"; }

bold "Temperature & System Monitor — setup"
echo

# --- required: python3 -------------------------------------------------------
if ! command -v python3 >/dev/null 2>&1; then
  echo "ERROR: python3 was not found. Install Python 3.8+ and re-run ./setup.sh"
  exit 1
fi
ok "python3 — $(python3 --version 2>&1)"

# --- required: psutil, isolated in a project virtualenv ----------------------
if [[ ! -x .venv/bin/python3 ]]; then
  echo "  Creating virtual environment in ./.venv …"
  if ! python3 -m venv .venv 2>/dev/null; then
    no "python3 venv module missing."
    echo "      Debian/Ubuntu/Pop!_OS:  sudo apt install -y python3-venv python3-pip"
    echo "      Fedora:                 sudo dnf install -y python3-virtualenv"
    echo "      Arch:                   (venv ships with python)"
    echo "      Then re-run ./setup.sh"
    exit 1
  fi
fi
.venv/bin/python3 -m pip install --quiet --upgrade pip >/dev/null 2>&1 || true
if .venv/bin/python3 -m pip install --quiet psutil; then
  ok "psutil installed in ./.venv ($(.venv/bin/python3 -c 'import psutil;print(psutil.__version__)'))"
else
  echo "ERROR: failed to install psutil (no internet?). Try again or install manually:"
  echo "    .venv/bin/python3 -m pip install psutil"
  exit 1
fi

# --- optional sensor sources -------------------------------------------------
echo
bold "Optional sensor sources (each just adds more to the dashboard):"
command -v sensors     >/dev/null 2>&1 && ok "lm-sensors  — CPU / DIMM / board temperatures" \
                                        || no "lm-sensors  — install for CPU/board temps (apt/dnf/pacman: lm-sensors / lm_sensors)"
command -v nvidia-smi  >/dev/null 2>&1 && ok "nvidia-smi  — NVIDIA GPU metrics" \
                                        || no "nvidia-smi  — only needed if you have an NVIDIA GPU"
ls /sys/class/hwmon/*/name >/dev/null 2>&1 && grep -qx amdgpu /sys/class/hwmon/*/name 2>/dev/null \
                                        && ok "amdgpu      — AMD GPU metrics (via sysfs)" \
                                        || no "amdgpu      — only present if you have an AMD GPU"
command -v ipmitool    >/dev/null 2>&1 && ok "ipmitool    — all DIMM temps via BMC/IPMI" \
                                        || no "ipmitool    — optional; reads every DIMM temp if the board has a BMC"
[[ -e /dev/ipmi0 ]] && ok "/dev/ipmi0  — BMC present (see SETUP.md to enable IPMI DIMM temps)" \
                    || no "/dev/ipmi0  — no BMC detected (DIMM temps will use the SMBus sensors)"

echo
bold "Done. Start the dashboard with:"
echo "    ./run.sh --open      # opens http://localhost:8420 in your browser"
echo
echo "See USER.md (using the dashboard) and SETUP.md (optional sensors, BMC, autostart)."
