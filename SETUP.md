# Setup & configuration

## 1. Install

```bash
git clone https://github.com/tentpegbob/popos-temperature-monitor.git
cd popos-temperature-monitor
./setup.sh
```

`setup.sh` is non-interactive and needs no root. It:

1. checks for `python3` (3.8+),
2. creates a project-local virtualenv in `./.venv` and installs **psutil** into
   it (nothing is installed system-wide), and
3. reports which optional sensor tools it found.

Then start it:

```bash
./run.sh --open      # http://localhost:8420
```

### Manual install (without setup.sh)

The only hard requirement is `psutil`:

```bash
python3 -m pip install --user psutil
python3 server.py            # or ./run.sh
```

If `python3 -m venv` fails, install the venv/pip packages for your distro:

| Distro | Command |
|--------|---------|
| Debian / Ubuntu / Pop!_OS | `sudo apt install -y python3-venv python3-pip` |
| Fedora | `sudo dnf install -y python3-pip python3-virtualenv` |
| Arch | `sudo pacman -S python` (venv is included) |

## 2. Optional sensor tools

Everything below is **optional** — install only what's relevant to your machine.
The dashboard auto-detects each one and simply omits anything missing.

| Feature | Tool | Install |
|---------|------|---------|
| CPU / DIMM / board temps | **lm-sensors** | `sudo apt install lm-sensors` · `sudo dnf install lm_sensors` · `sudo pacman -S lm_sensors`, then `sudo sensors-detect --auto` |
| NVIDIA GPU | **nvidia-smi** | ships with the NVIDIA driver |
| AMD GPU | **amdgpu** (in-kernel) | nothing to install; read from `/sys/class/hwmon` |
| All DIMM temps via BMC | **ipmitool** | `sudo apt install ipmitool` · `sudo dnf install ipmitool` · `sudo pacman -S ipmitool` |

## 3. DIMM temperatures

The dashboard shows a temperature bar per populated memory bank, using the most
complete source available:

1. **BMC / IPMI (preferred).** If the board has a BMC (`/dev/ipmi*`) and
   `ipmitool` is installed, every bank is read by slot name (`DIMMA1…`) with the
   BMC's own thresholds. The BMC device is normally root-only, so the server
   runs `sudo -n ipmitool`. To make that work without a password prompt, allow
   just that command via sudoers:

   ```bash
   echo "$USER ALL=(root) NOPASSWD: /usr/bin/ipmitool" | sudo tee /etc/sudoers.d/ipmitool-dashboard
   sudo chmod 0440 /etc/sudoers.d/ipmitool-dashboard
   ```

   Prefer no sudo at all? Grant your user the IPMI device via udev instead, then
   re-log in:

   ```bash
   echo 'KERNEL=="ipmi*", MODE="0660", GROUP="ipmi"' | sudo tee /etc/udev/rules.d/90-ipmi.rules
   sudo groupadd -f ipmi && sudo usermod -aG ipmi "$USER"
   ```

   Use `./run.sh --no-ipmi` to skip the BMC entirely.

2. **SMBus `jc42` sensors (fallback).** The DIMM temperature sensors Linux reads
   directly via lm-sensors. On some AMD HEDT/workstation boards the firmware
   only exposes a *subset* of these to the OS. On boards **without** a BMC, the
   included `enable-dimm-sensors.sh` can instantiate any the kernel missed:

   ```bash
   sudo ./enable-dimm-sensors.sh            # enable now
   sudo ./enable-dimm-sensors.sh --persist  # and re-enable on every boot
   ```

   (If your board *has* a BMC, you don't need this — IPMI already reports all
   banks.)

## 4. Exposing on your network

By default the server is **localhost-only**. To reach it from another device:

```bash
./run.sh --host 0.0.0.0 --port 8420
```

⚠️ There is **no authentication** — anyone who can reach the host can view your
telemetry and process list. Only do this on a trusted network, and consider a
firewall rule or an SSH tunnel instead:

```bash
# from the remote machine, no --host change needed on the server:
ssh -L 8420:localhost:8420 user@that-machine
# then browse http://localhost:8420 locally
```

## 5. Run at startup (optional)

A user-level systemd service keeps it running after login. Create
`~/.config/systemd/user/temp-monitor.service` — set `WorkingDirectory` to wherever
you cloned the repo:

```ini
[Unit]
Description=Temperature & System Monitor
After=default.target

[Service]
# adjust this path to your clone location:
WorkingDirectory=%h/popos-temperature-monitor
ExecStart=%h/popos-temperature-monitor/run.sh
Restart=on-failure

[Install]
WantedBy=default.target
```

```bash
systemctl --user daemon-reload
systemctl --user enable --now temp-monitor.service
# optional: keep it running when you're logged out
sudo loginctl enable-linger "$USER"
```

`%h` expands to your home directory, so the unit has no hard-coded username.

## Troubleshooting

- **"psutil is not installed"** — run `./setup.sh`, or `pip install --user psutil`.
- **No CPU/board temperatures** — install `lm-sensors` and run `sudo sensors-detect --auto`.
- **DIMM card shows fewer banks than installed** — see §3; use IPMI if you have a BMC.
- **GPU card missing** — confirm `nvidia-smi` works, or that an `amdgpu` entry
  appears in `ls /sys/class/hwmon/*/name`.
- **Port already in use** — pick another with `--port`.
