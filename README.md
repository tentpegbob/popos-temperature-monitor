# 🌡️ Temperature & System Monitor

A lightweight, **user-friendly web dashboard** for live monitoring of your
Linux machine's temperatures and load — CPU, every memory bank (DIMM), and your
NVIDIA and/or AMD GPUs — in any browser.

- **No build step, no cloud, no heavy dependencies.** Pure-stdlib Python backend
  + a single hard dependency (`psutil`). Gauges and charts are hand-drawn on
  `<canvas>`, so the UI works **fully offline**.
- **Adapts to your hardware.** Whatever sensors/tools are present (lm-sensors,
  `nvidia-smi`, `amdgpu` sysfs, a BMC via IPMI…) are shown; anything missing is
  simply omitted. Nothing is tied to a specific machine, user, or path.

## Quick start

```bash
git clone https://github.com/tentpegbob/popos-temperature-monitor.git
cd popos-temperature-monitor
./setup.sh          # one-time: creates a venv + installs psutil, checks sensors
./run.sh --open     # starts the server and opens http://localhost:8420
```

Press **Ctrl+C** to stop. That's it.

> Developed on Pop!_OS with an AMD Threadripper PRO + NVIDIA & AMD GPUs, but it
> runs on any modern Linux — Intel/AMD, one GPU, no GPU, etc.

## What it shows

| Card | Metrics |
|------|---------|
| **CPU** | Overall load %, package temperature, per-die (CCD) / per-core temps, a per-thread utilisation heatmap, frequency, load average |
| **Memory** | RAM used / total / %, swap, and **per-DIMM temperatures** for every populated bank, colour-coded by its warn/critical limits |
| **NVIDIA GPU** | Utilisation, VRAM, temperature, power, fan, clocks (via `nvidia-smi`) |
| **AMD GPU** | Utilisation, VRAM, edge/junction/memory temps, power, fan (via `amdgpu` sysfs) |
| **Storage** | NVMe / disk temperatures **and** per-filesystem capacity |
| **Top processes** | Live top consumers by CPU and by memory (count configurable) |

Everything is **colour-coded** green → amber → red against each sensor's
thresholds, with history sparklines showing the recent trend. Cards can be
**dragged to reorder**, and your layout + preferences are remembered in the
browser.

📖 **[USER.md](USER.md)** — using the dashboard (cards, colours, interactions)
🔧 **[SETUP.md](SETUP.md)** — optional sensors, BMC/IPMI, LAN access, autostart

## Options

```
./run.sh [--port N] [--interval SECONDS] [--host ADDR] [--no-ipmi] [--open]

  --port      Port to serve on             (default 8420)
  --interval  Sampling interval, seconds   (default 1.0)
  --host      Bind address                 (default 127.0.0.1, localhost-only)
  --no-ipmi   Don't read DIMM temps from the BMC via ipmitool (avoids sudo)
  --open      Open the dashboard in your browser
```

## Security

By default the server binds to **`127.0.0.1`** — reachable only from this
machine. It serves read-only telemetry and only files inside `static/`. Pass
`--host 0.0.0.0` **only** if you intentionally want it reachable from your LAN
(it has no authentication). See [SETUP.md](SETUP.md#exposing-on-your-network).

## How it works

A background thread samples all sensors and caches the latest snapshot; the HTTP
handler serves it instantly, so slow tools (`nvidia-smi`, `ipmitool`) run on
their own threads and never stall the UI. Each sub-collector is independently
guarded, so a missing or failing sensor never takes down the rest of the
dashboard. The frontend (`static/`) rebuilds its layout from whatever the
backend reports.

## Requirements

- Linux, Python 3.8+, and a modern browser. `psutil` is installed by `setup.sh`.
- Optional: `lm-sensors`, `nvidia-smi`, an `amdgpu` card, `ipmitool` + a BMC.
  Missing ones are just left out.

## License

MIT — see [LICENSE](LICENSE).
