#!/usr/bin/env bash
#
# enable-dimm-sensors.sh — expose ALL DIMM temperature sensors.
#
# On AMD Threadripper/EPYC (WRX80/sWRX8) boards the DIMM temperature sensors
# (JEDEC TSE2004 / "jc42") are spread across several SMBus segments, and the
# kernel often auto-detects only the ones on the first segment. This scans
# every AMD PIIX4 SMBus segment for temperature sensors and instantiates the
# jc42 driver for any that aren't already active.
#
# Safe + idempotent: it only probes the JEDEC temp-sensor address range
# (0x18-0x1f) and skips addresses that don't respond or are already set up.
#
#   sudo ./enable-dimm-sensors.sh            # enable now (until reboot)
#   sudo ./enable-dimm-sensors.sh --persist  # also re-enable automatically at boot
#
set -u

if [[ "${EUID}" -ne 0 ]]; then
  echo "This needs root (it writes to /sys/.../new_device). Re-run with:"
  echo "    sudo $0 $*"
  exit 1
fi

modprobe jc42 2>/dev/null || true

added=0
for busdir in /sys/bus/i2c/devices/i2c-*; do
  name=$(cat "$busdir/name" 2>/dev/null || true)
  [[ "$name" == *PIIX4* ]] || continue          # only the AMD SMBus segments carry DIMM sensors
  num=$(basename "$busdir"); num=${num#i2c-}
  echo "Scanning i2c-$num ($name) …"
  for a in 18 19 1a 1b 1c 1d 1e 1f; do
    client="/sys/bus/i2c/devices/${num}-00${a}"
    if [[ -e "$client" ]]; then
      continue                                   # something already instantiated here
    fi
    # Probe: read the capability word at register 0x00. A DIMM temp sensor answers.
    if i2cget -y "$num" "0x${a}" 0x00 w >/dev/null 2>&1; then
      if echo "jc42 0x${a}" > "$busdir/new_device" 2>/dev/null; then
        # jc42 verifies the chip ID on probe; if it bound, an hwmon appears.
        if [[ -d "$client/hwmon" ]]; then
          echo "  + DIMM sensor enabled at i2c-$num 0x${a}"
          added=$((added + 1))
        else
          # nothing compatible there — back it out so we don't leave junk
          echo "0x${a}" > "$busdir/delete_device" 2>/dev/null || true
        fi
      fi
    fi
  done
done

total=$(grep -lx jc42 /sys/class/hwmon/hwmon*/name 2>/dev/null | wc -l)
echo
echo "Done. Added $added sensor(s); $total DIMM temperature sensor(s) now active."
echo "Reload the dashboard in your browser — the new banks will appear automatically."

if [[ "${1:-}" == "--persist" ]]; then
  script="$(readlink -f "$0")"
  unit=/etc/systemd/system/dimm-temp-sensors.service
  cat > "$unit" <<EOF
[Unit]
Description=Instantiate DIMM (jc42) temperature sensors on AMD SMBus
After=multi-user.target

[Service]
Type=oneshot
ExecStart=$script
RemainAfterExit=yes

[Install]
WantedBy=multi-user.target
EOF
  systemctl daemon-reload
  systemctl enable dimm-temp-sensors.service >/dev/null 2>&1
  echo "Installed $unit — sensors will be re-enabled automatically on every boot."
fi
