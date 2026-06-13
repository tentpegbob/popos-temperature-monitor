#!/usr/bin/env python3
"""
Temperature & System Monitor — backend.

A dependency-light (stdlib + psutil) HTTP server that samples hardware sensors
in a background thread and serves the latest snapshot as JSON.

Endpoints:
    GET /                 -> dashboard (static/index.html)
    GET /static/*         -> static assets
    GET /api/meta         -> static machine info (model, cores, tools available)
    GET /api/metrics      -> latest metrics snapshot (JSON)

Everything binds to 127.0.0.1 by default — system telemetry is not exposed to
the network unless you explicitly pass --host 0.0.0.0.
"""

import argparse
import json
import math
import os
import glob
import platform
import re
import socket
import subprocess
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

try:
    import psutil
except ImportError:  # pragma: no cover
    raise SystemExit(
        "This dashboard needs the 'psutil' package.\n"
        "Install it with:  python3 -m pip install --user psutil"
    )

HERE = os.path.dirname(os.path.abspath(__file__))
STATIC_DIR = os.path.join(HERE, "static")

# Default warn/crit thresholds (°C) used only when the sensor itself does not
# report them. AMD Threadripper Tctl throttles around 95°C.
CPU_WARN, CPU_CRIT = 80.0, 95.0
NV_TEMP_WARN, NV_TEMP_CRIT = 80.0, 90.0
DIMM_WARN_FALLBACK, DIMM_CRIT_FALLBACK = 82.0, 95.0
PCT_WARN, PCT_CRIT = 85.0, 95.0
MEM_WARN, MEM_CRIT = 85.0, 95.0


# --------------------------------------------------------------------------- #
# Small sysfs helpers
# --------------------------------------------------------------------------- #
def _read(path):
    try:
        with open(path) as fh:
            return fh.read().strip()
    except OSError:
        return None


def _read_int(path):
    raw = _read(path)
    try:
        return int(raw)
    except (TypeError, ValueError):
        return None


def metric(value, warn=None, crit=None):
    """Build a value+thresholds bundle the frontend colours by severity."""
    if value is None or not math.isfinite(value):
        return None
    return {"value": round(value, 1), "warn": warn, "crit": crit}


def _json_sanitize(obj):
    """Recursively replace non-finite floats (NaN/Infinity) with None so the
    payload is always valid JSON, whatever a sensor reports."""
    if isinstance(obj, float):
        return obj if math.isfinite(obj) else None
    if isinstance(obj, dict):
        return {k: _json_sanitize(v) for k, v in obj.items()}
    if isinstance(obj, (list, tuple)):
        return [_json_sanitize(v) for v in obj]
    return obj


def _clean_high(value):
    """Some drivers report nonsense limits (e.g. 65261.85). Drop the absurd."""
    if value is None:
        return None
    try:
        v = float(value)
    except (TypeError, ValueError):
        return None
    if v <= 0 or v > 200:
        return None
    return v


# --------------------------------------------------------------------------- #
# Collector
# --------------------------------------------------------------------------- #
class Collector(threading.Thread):
    """Samples all metrics on a timer and exposes the latest snapshot."""

    def __init__(self, interval=1.0, use_ipmi=True):
        super().__init__(daemon=True)
        self.interval = max(0.25, interval)
        self._lock = threading.Lock()
        self._snapshot = {}
        self._stop = threading.Event()

        # Discover hardware/tooling once.
        self.amd_hwmons = self._discover_amd()
        self.nvidia = self._discover_nvidia()
        self.ipmi_cmd = self._discover_ipmi() if use_ipmi else None
        self.cpu_model = self._cpu_model()
        self.logical = psutil.cpu_count(logical=True) or 1
        self.physical = psutil.cpu_count(logical=False) or self.logical

        # State for rate-based metrics.
        self._procs = {}  # pid -> psutil.Process (kept across ticks for cpu%)
        self._lspci_cache = {}

        # nvidia-smi is slow (1-3s under load) so it runs on its own thread and
        # the main loop just reads this cache.
        self._nvidia_cache = []
        self._nvidia_lock = threading.Lock()
        self._nvidia_thread = None

        # ipmitool (BMC) is slow (~3s) too — same dedicated-thread treatment.
        # On boards like this one the BMC exposes every DIMM's temperature even
        # when the OS SMBus only sees a few.
        self._ipmi_cache = []
        self._ipmi_lock = threading.Lock()
        self._ipmi_thread = None

    # -- discovery ---------------------------------------------------------- #
    @staticmethod
    def _cpu_model():
        for line in (_read("/proc/cpuinfo") or "").splitlines():
            if line.lower().startswith("model name"):
                return line.split(":", 1)[1].strip()
        return platform.processor() or platform.machine()

    @staticmethod
    def _discover_nvidia():
        for path in ("/usr/bin/nvidia-smi", "/usr/local/bin/nvidia-smi"):
            if os.path.exists(path):
                return path
        # Fall back to PATH lookup.
        for d in os.environ.get("PATH", "").split(os.pathsep):
            cand = os.path.join(d, "nvidia-smi")
            if os.path.exists(cand):
                return cand
        return None

    @staticmethod
    def _discover_amd():
        """Find every amdgpu hwmon and its associated device directory."""
        found = []
        for hwmon in sorted(glob.glob("/sys/class/hwmon/hwmon*")):
            if _read(os.path.join(hwmon, "name")) != "amdgpu":
                continue
            device = os.path.realpath(os.path.join(hwmon, "device"))
            found.append({"hwmon": hwmon, "device": device})
        return found

    @staticmethod
    def _discover_ipmi():
        """Return the ipmitool command prefix to use, or None if unavailable.

        Needs both an ipmitool binary and a BMC device (/dev/ipmi*). The BMC
        device is usually root-only, so fall back to passwordless sudo."""
        tool = None
        for path in ("/usr/bin/ipmitool", "/usr/sbin/ipmitool", "/usr/local/bin/ipmitool"):
            if os.path.exists(path):
                tool = path
                break
        if not tool:
            for d in os.environ.get("PATH", "").split(os.pathsep):
                cand = os.path.join(d, "ipmitool")
                if os.path.exists(cand):
                    tool = cand
                    break
        if not tool:
            return None
        if not glob.glob("/dev/ipmi*"):
            return None
        dev = "/dev/ipmi0"
        if os.access(dev, os.R_OK | os.W_OK):
            return [tool]
        return ["sudo", "-n", tool]  # BMC device is root-only on this box

    @staticmethod
    def _cpu_freq():
        """Read scaling_cur_freq from sysfs (kHz). psutil mis-scales current
        frequency on some AMD platforms, so we read it directly and average."""
        cur = mx = None
        vals = []
        for f in glob.glob("/sys/devices/system/cpu/cpu[0-9]*/cpufreq/scaling_cur_freq"):
            v = _read_int(f)
            if v:
                vals.append(v)
        if vals:
            cur = sum(vals) / len(vals) / 1000.0  # kHz -> MHz
        mxk = _read_int("/sys/devices/system/cpu/cpu0/cpufreq/cpuinfo_max_freq")
        if mxk:
            mx = mxk / 1000.0
        if cur is None:  # fallback for non-cpufreq platforms
            try:
                f = psutil.cpu_freq()
                if f:
                    cur, mx = f.current, (mx or f.max)
                    if cur and cur < 50 and mx and mx > 50:  # GHz/MHz unit mismatch guard
                        cur *= 1000
            except Exception:
                pass
        return cur, mx

    # -- per-section collectors -------------------------------------------- #
    def _cpu(self, temps):
        per_core = psutil.cpu_percent(percpu=True)
        overall = round(sum(per_core) / len(per_core), 1) if per_core else 0.0

        freq_cur, freq_max = self._cpu_freq()

        try:
            load = list(os.getloadavg()) if hasattr(os, "getloadavg") else [0.0, 0.0, 0.0]
        except Exception:
            load = [0.0, 0.0, 0.0]

        # CPU temperature from k10temp: Tctl is the package control temp.
        main_temp = None
        cores_temp = []
        for entry in temps.get("k10temp", []):
            label = entry.label or "Tctl"
            warn = _clean_high(entry.high) or CPU_WARN
            crit = _clean_high(entry.critical) or CPU_CRIT
            m = metric(entry.current, warn, crit)
            if label.lower() == "tctl":
                main_temp = m
            else:
                cores_temp.append({"label": label, **(m or {})})
        # Some platforms expose CPU temp under coretemp instead.
        if main_temp is None:
            for chip in ("coretemp", "cpu_thermal", "zenpower"):
                items = temps.get(chip)
                if items:
                    # Prefer the package sensor over an arbitrary first core.
                    e = next((x for x in items if "package" in (x.label or "").lower()), items[0])
                    main_temp = metric(
                        e.current,
                        _clean_high(e.high) or CPU_WARN,
                        _clean_high(e.critical) or CPU_CRIT,
                    )
                    break

        return {
            "usage": overall,
            "per_core": [round(x, 1) for x in per_core],
            "freq_mhz": round(freq_cur) if freq_cur else None,
            "freq_max": round(freq_max) if freq_max else None,
            "load": [round(x, 2) for x in load],
            "temp": main_temp,
            "cores_temp": cores_temp,
            "physical_cores": self.physical,
            "logical_cores": self.logical,
        }

    def _memory(self, temps):
        vm = psutil.virtual_memory()
        sm = psutil.swap_memory()

        return {
            "total": vm.total,
            "used": vm.used,
            "available": vm.available,
            "percent": round(vm.percent, 1),
            "warn": MEM_WARN,
            "crit": MEM_CRIT,
            "swap_total": sm.total,
            "swap_used": sm.used,
            "swap_percent": round(sm.percent, 1),
            "dimms": self._dimms(),
        }

    def _dimms(self):
        """Per-DIMM temperatures. Prefer the BMC/IPMI source when available — it
        reports every populated bank with its slot name (DIMMA1…) — and fall
        back to the jc42 hwmon sensors the OS SMBus exposes directly."""
        with self._ipmi_lock:
            ipmi = list(self._ipmi_cache)
        if ipmi:
            return ipmi

        found = []
        for hw in glob.glob("/sys/class/hwmon/hwmon*"):
            if _read(os.path.join(hw, "name")) != "jc42":
                continue
            cur = _read_int(os.path.join(hw, "temp1_input"))
            if cur is None:
                continue
            warn = _clean_high((_read_int(os.path.join(hw, "temp1_max")) or 0) / 1000.0) or DIMM_WARN_FALLBACK
            crit = _clean_high((_read_int(os.path.join(hw, "temp1_crit")) or 0) / 1000.0) or DIMM_CRIT_FALLBACK
            dev = os.path.basename(os.path.realpath(os.path.join(hw, "device")))  # e.g. "1-001c"
            m = metric(cur / 1000.0, warn, crit)
            if m:
                found.append({"_id": dev, **m})
        found.sort(key=lambda d: d["_id"])
        dimms = []
        for i, d in enumerate(found, start=1):
            addr = d.pop("_id").split("-")[-1].lstrip("0") or "?"  # "001c" -> "1c"
            dimms.append({"label": f"DIMM {i} · 0x{addr}", **d})
        return dimms

    def _query_ipmi(self):
        """Run `ipmitool sensor` once and parse DIMM temperatures + thresholds.
        Returns a list (possibly empty) or None on failure."""
        if not self.ipmi_cmd:
            return None
        try:
            out = subprocess.run(self.ipmi_cmd + ["sensor"],
                                 capture_output=True, text=True, timeout=15)
        except (subprocess.TimeoutExpired, OSError):
            return None
        if out.returncode != 0:
            return None

        def num(s):
            try:
                v = float(s)
            except (TypeError, ValueError):
                return None
            return v if math.isfinite(v) and v != 0 else None

        dimms = []
        for line in out.stdout.splitlines():
            if "|" not in line:
                continue
            cols = [c.strip() for c in line.split("|")]
            if len(cols) < 9 or not cols[0].upper().startswith("DIMM"):
                continue
            value = num(cols[1])
            if value is None:          # 'na' -> empty slot / no reading
                continue
            warn = num(cols[7]) or DIMM_WARN_FALLBACK   # upper non-critical
            crit = num(cols[8]) or DIMM_CRIT_FALLBACK   # upper critical
            label = cols[0].replace("Temp.", "").replace("Temp", "").strip()
            m = metric(value, warn, crit)
            if m:
                dimms.append({"label": label, **m})
        return dimms

    def _ipmi_loop(self):
        while not self._stop.is_set():
            start = time.time()
            result = self._query_ipmi()
            if result is not None:
                with self._ipmi_lock:
                    self._ipmi_cache = result
            # BMC temps move slowly and the call is ~3s; refresh gently.
            self._stop.wait(max(5.0, self.interval - (time.time() - start)))

    def _gpus(self):
        gpus = []
        gpus.extend(self._nvidia_gpus())
        gpus.extend(self._amd_gpus())
        return gpus

    def _nvidia_gpus(self):
        """Return the most recent cached nvidia-smi result (populated on a
        dedicated thread so the slow subprocess never blocks fast sensors)."""
        with self._nvidia_lock:
            return list(self._nvidia_cache)

    def _query_nvidia(self):
        """Run nvidia-smi once. Returns a list of GPU dicts, or None on failure
        (so the caller can keep the last good reading)."""
        if not self.nvidia:
            return None
        fields = [
            "index", "name", "temperature.gpu", "temperature.memory",
            "utilization.gpu", "utilization.memory", "memory.total",
            "memory.used", "power.draw", "power.limit", "fan.speed",
            "clocks.sm", "clocks.mem",
        ]
        try:
            out = subprocess.run(
                [self.nvidia, "--query-gpu=" + ",".join(fields),
                 "--format=csv,noheader,nounits"],
                capture_output=True, text=True, timeout=10,
            )
        except (subprocess.TimeoutExpired, OSError):
            return None
        if out.returncode != 0:
            return None

        def num(s):
            s = s.strip()
            if not s or s.upper() in ("N/A", "[N/A]", "[NOT SUPPORTED]", "[NOT AVAILABLE]"):
                return None
            try:
                v = float(s)
            except ValueError:
                return None
            return v if math.isfinite(v) else None

        gpus = []
        for line in out.stdout.strip().splitlines():
            parts = [p.strip() for p in line.split(",")]
            if len(parts) < len(fields):
                continue
            (idx, name, t_gpu, t_mem, u_gpu, u_mem, m_tot, m_used,
             p_draw, p_lim, fan, c_sm, c_mem) = parts[:13]
            m_tot_b = (num(m_tot) or 0) * 1024 * 1024
            m_used_b = (num(m_used) or 0) * 1024 * 1024
            temps = [{"label": "GPU", **(metric(num(t_gpu), NV_TEMP_WARN, NV_TEMP_CRIT) or {})}]
            if num(t_mem) is not None:
                temps.append({"label": "Memory", **(metric(num(t_mem), 95, 105) or {})})
            gpus.append({
                "vendor": "nvidia",
                "index": int(num(idx) or 0),
                "name": name,
                "util": metric(num(u_gpu), PCT_WARN, PCT_CRIT),
                "mem_util": metric(num(u_mem), PCT_WARN, PCT_CRIT),
                "mem": {
                    "used": m_used_b,
                    "total": m_tot_b,
                    "percent": round(m_used_b / m_tot_b * 100, 1) if m_tot_b else None,
                },
                "temps": [t for t in temps if "value" in t],
                "extra": {
                    "power": num(p_draw),
                    "power_limit": num(p_lim),
                    "fan": num(fan),
                    "clock_sm": num(c_sm),
                    "clock_mem": num(c_mem),
                },
            })
        return gpus

    def _amd_gpus(self):
        gpus = []
        for i, dev in enumerate(self.amd_hwmons):
            hw, device = dev["hwmon"], dev["device"]
            temps = []
            for tpath in sorted(glob.glob(os.path.join(hw, "temp*_input"))):
                base = tpath[:-len("_input")]
                raw = _read_int(tpath)
                if raw is None:
                    continue
                label = _read(base + "_label") or "temp"
                warn = (_clean_high((_read_int(base + "_max") or 0) / 1000.0)
                        or _clean_high((_read_int(base + "_crit") or 0) / 1000.0))
                crit = _clean_high((_read_int(base + "_crit") or 0) / 1000.0)
                temps.append({"label": label, **(metric(raw / 1000.0, warn, crit) or {})})

            vram_used = _read_int(os.path.join(device, "mem_info_vram_used"))
            vram_total = _read_int(os.path.join(device, "mem_info_vram_total"))
            busy = _read_int(os.path.join(device, "gpu_busy_percent"))
            mem_busy = _read_int(os.path.join(device, "mem_busy_percent"))
            power_uw = _read_int(os.path.join(hw, "power1_average"))
            if power_uw is None:
                power_uw = _read_int(os.path.join(hw, "power1_input"))
            fan = _read_int(os.path.join(hw, "fan1_input"))
            sclk = self._amd_clock(os.path.join(device, "pp_dpm_sclk"))
            mclk = self._amd_clock(os.path.join(device, "pp_dpm_mclk"))

            name = self._amd_name(device, i)
            gpus.append({
                "vendor": "amd",
                "index": i,
                "name": name,
                "util": metric(float(busy), PCT_WARN, PCT_CRIT) if busy is not None else None,
                "mem_util": metric(float(mem_busy), PCT_WARN, PCT_CRIT) if mem_busy is not None else None,
                "mem": {
                    "used": vram_used,
                    "total": vram_total,
                    "percent": round(vram_used / vram_total * 100, 1)
                    if vram_used is not None and vram_total else None,
                },
                "temps": [t for t in temps if "value" in t],
                "extra": {
                    "power": round(power_uw / 1_000_000, 1) if power_uw else None,
                    "power_limit": None,
                    "fan": fan,
                    "clock_sm": sclk,
                    "clock_mem": mclk,
                },
            })
        return gpus

    @staticmethod
    def _amd_clock(path):
        """pp_dpm_sclk lines look like '0: 500Mhz' with a '*' on the active one."""
        data = _read(path)
        if not data:
            return None
        for line in data.splitlines():
            if "*" in line:
                tok = line.split(":", 1)[-1].strip().rstrip("*").strip()
                digits = "".join(c for c in tok if c.isdigit())
                return int(digits) if digits else None
        return None

    def _amd_name(self, device, index):
        # Prefer a human-readable product name if the kernel exposes one.
        name = _read(os.path.join(device, "product_name"))
        if name:
            return name
        # Otherwise ask lspci (cached). pci.ids may not know newer cards.
        addr = os.path.basename(device)            # 0000:63:00.0
        short = addr.split(":", 1)[1] if addr.count(":") >= 2 else addr
        if short not in self._lspci_cache:
            self._lspci_cache[short] = self._lspci_desc(short)
        desc = self._lspci_cache[short]
        if desc and "Device " not in desc:
            # Trim the verbose vendor prefix; keep a bracketed model if present.
            m = re.search(r"\[([^\]]+)\]\s*$", desc)
            return ("Radeon " + m.group(1)) if m else desc
        return "AMD Radeon GPU"

    @staticmethod
    def _lspci_desc(short):
        try:
            out = subprocess.run(["lspci", "-s", short], capture_output=True,
                                 text=True, timeout=2)
            line = out.stdout.strip().splitlines()[0]
            desc = line.split(": ", 1)[1]
            return re.sub(r"\s*\(rev .*\)$", "", desc).strip()
        except Exception:
            return None

    def _storage(self, temps):
        drives = []
        nvme = temps.get("nvme", [])
        # Each physical NVMe drive exposes a 'Composite' sensor (plus per-flash
        # sub-sensors). Report one entry per drive; fall back to the first
        # sensor only if no Composite is present at all.
        composites = [e for e in nvme if (e.label or "").lower().startswith("composite")]
        chosen = composites if composites else nvme[:1]
        multi = len(chosen) > 1
        for i, entry in enumerate(chosen, start=1):
            drives.append({
                "name": f"NVMe {i}" if multi else "NVMe",
                **(metric(entry.current,
                          _clean_high(entry.high) or 75,
                          _clean_high(entry.critical) or 90) or {}),
            })
        for entry in temps.get("drivetemp", []):
            drives.append({"name": entry.label or "Disk",
                           **(metric(entry.current, 55, 65) or {})})
        return {"temps": drives, "disks": self._disks()}

    # Pseudo / virtual filesystems and snap images we don't want to list.
    _SKIP_FS = {
        "squashfs", "tmpfs", "devtmpfs", "overlay", "overlayfs", "aufs",
        "proc", "sysfs", "cgroup", "cgroup2", "autofs", "mqueue", "debugfs",
        "tracefs", "fusectl", "configfs", "ramfs", "efivarfs", "securityfs",
        "pstore", "bpf", "hugetlbfs", "binfmt_misc", "nsfs", "devpts",
        "fuse.gvfsd-fuse", "fuse.portal", "fuse.snapfuse",
    }

    def _disks(self):
        """Capacity for each real, mounted filesystem (deduped by device)."""
        disks = []
        seen = set()
        try:
            parts = psutil.disk_partitions(all=False)
        except Exception:
            return disks
        for p in parts:
            if p.fstype.lower() in self._SKIP_FS:
                continue
            if p.device in seen:
                continue
            try:
                u = psutil.disk_usage(p.mountpoint)
            except (OSError, PermissionError):
                continue
            seen.add(p.device)
            disks.append({
                "mount": p.mountpoint,
                "device": p.device,
                "fstype": p.fstype,
                "total": u.total,
                "used": u.used,
                "free": u.free,
                "percent": round(u.percent, 1),
                "warn": 85,
                "crit": 95,
            })
        disks.sort(key=lambda d: d["total"], reverse=True)
        return disks[:10]

    def _top_procs(self, limit=150):
        # The frontend renders only as many rows as fit the window; we return a
        # generous list so it can fill even a tall display.
        seen = {}
        snapshot = []
        for proc in psutil.process_iter(["pid", "name"]):
            pid = proc.info["pid"]
            cached = self._procs.get(pid)
            is_new = cached is None
            if is_new:
                cached = proc
                try:
                    cached.cpu_percent(None)  # prime; first read is 0
                except (psutil.NoSuchProcess, psutil.AccessDenied):
                    continue
            seen[pid] = cached
            try:
                # For a freshly-primed process the elapsed interval is ~0, which
                # yields a meaningless huge %. Report 0 this tick; real value next.
                cpu = 0.0 if is_new else cached.cpu_percent(None)
                with cached.oneshot():
                    name = cached.name()
                    rss = cached.memory_info().rss
            except (psutil.NoSuchProcess, psutil.AccessDenied, psutil.ZombieProcess):
                continue
            snapshot.append({
                "pid": pid,
                "name": name,
                "cpu": round(cpu / self.logical, 1),  # % of whole machine
                "mem_mb": round(rss / (1024 * 1024), 1),
            })
        self._procs = seen
        by_cpu = sorted(snapshot, key=lambda p: p["cpu"], reverse=True)[:limit]
        by_mem = sorted(snapshot, key=lambda p: p["mem_mb"], reverse=True)[:limit]
        return {"by_cpu": by_cpu, "by_mem": by_mem}

    # -- main loop ---------------------------------------------------------- #
    def collect(self):
        try:
            temps = psutil.sensors_temperatures()
        except Exception:
            temps = {}

        snap = {"ts": time.time(), "interval": self.interval}
        for key, fn in (
            ("cpu", lambda: self._cpu(temps)),
            ("memory", lambda: self._memory(temps)),
            ("gpus", self._gpus),
            ("storage", lambda: self._storage(temps)),
            ("processes", self._top_procs),
        ):
            try:
                snap[key] = fn()
            except Exception as exc:  # never let one sensor kill the snapshot
                snap[key] = {"error": str(exc)}
        return snap

    def _nvidia_loop(self):
        """Continuously refresh the nvidia-smi cache without blocking the main
        loop. Keeps the previous reading on a transient failure."""
        while not self._stop.is_set():
            start = time.time()
            result = self._query_nvidia()
            if result is not None:
                with self._nvidia_lock:
                    self._nvidia_cache = result
            self._stop.wait(max(0.25, self.interval - (time.time() - start)))

    def run(self):
        psutil.cpu_percent(percpu=True)  # prime per-core sampling
        if self.nvidia:
            primed = self._query_nvidia()  # one blocking call so shape is stable
            if primed is not None:
                self._nvidia_cache = primed
            self._nvidia_thread = threading.Thread(target=self._nvidia_loop, daemon=True)
            self._nvidia_thread.start()
        if self.ipmi_cmd:
            primed = self._query_ipmi()  # prime so DIMM count is stable from the first snapshot
            if primed:
                with self._ipmi_lock:
                    self._ipmi_cache = primed
            self._ipmi_thread = threading.Thread(target=self._ipmi_loop, daemon=True)
            self._ipmi_thread.start()
        while not self._stop.is_set():
            start = time.time()
            try:
                snap = self.collect()
                with self._lock:
                    self._snapshot = snap
            except Exception as exc:
                with self._lock:
                    self._snapshot = {"ts": time.time(), "error": str(exc)}
            self._stop.wait(max(0.05, self.interval - (time.time() - start)))

    def stop(self):
        self._stop.set()

    def latest(self):
        with self._lock:
            return dict(self._snapshot)

    def meta(self):
        vm = psutil.virtual_memory()
        gpus = self.latest().get("gpus")
        gpu_names = [g.get("name") for g in gpus if isinstance(g, dict)] if isinstance(gpus, list) else []
        return {
            "hostname": socket.gethostname(),
            "cpu_model": self.cpu_model,
            "physical_cores": self.physical,
            "logical_cores": self.logical,
            "mem_total": vm.total,
            "os": " ".join(filter(None, [platform.system(), platform.release()])),
            "boot_time": psutil.boot_time(),
            "interval": self.interval,
            "tools": {
                "nvidia_smi": bool(self.nvidia),
                "amd_sysfs": len(self.amd_hwmons),
                "ipmi": bool(self.ipmi_cmd),
            },
            "gpus": gpu_names,
            "python": platform.python_version(),
            "psutil": psutil.__version__,
        }


# --------------------------------------------------------------------------- #
# HTTP handler
# --------------------------------------------------------------------------- #
class Handler(BaseHTTPRequestHandler):
    server_version = "TempDash/1.0"
    collector = None  # injected on the server

    def log_message(self, *args):
        pass  # keep the console quiet

    def _send(self, code, body, content_type="application/json"):
        if isinstance(body, (dict, list)):
            try:
                body = json.dumps(body, allow_nan=False).encode("utf-8")
            except ValueError:  # a non-finite value slipped through somewhere
                body = json.dumps(_json_sanitize(body), allow_nan=False).encode("utf-8")
        elif isinstance(body, str):
            body = body.encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(body)

    def _send_file(self, relpath, content_type):
        # Resolve and confine inside STATIC_DIR (defends against traversal).
        full = os.path.realpath(os.path.join(STATIC_DIR, relpath))
        if not full.startswith(STATIC_DIR + os.sep) and full != STATIC_DIR:
            return self._send(403, {"error": "forbidden"})
        try:
            with open(full, "rb") as fh:
                data = fh.read()
        except OSError:
            return self._send(404, {"error": "not found"})
        self.send_response(200)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(data)

    def do_HEAD(self):
        self.do_GET()

    def do_GET(self):
        try:
            self._dispatch()
        except Exception as exc:  # never let an exception break the connection
            try:
                self._send(500, {"error": str(exc)})
            except Exception:
                pass

    def _dispatch(self):
        path = self.path.split("?", 1)[0]
        if path == "/" or path == "/index.html":
            return self._send_file("index.html", "text/html; charset=utf-8")
        if path == "/api/metrics":
            return self._send(200, self.collector.latest())
        if path == "/api/meta":
            return self._send(200, self.collector.meta())
        if path.startswith("/static/"):
            rel = path[len("/static/"):]
            ext = os.path.splitext(rel)[1]
            ctype = {
                ".js": "application/javascript; charset=utf-8",
                ".css": "text/css; charset=utf-8",
                ".html": "text/html; charset=utf-8",
                ".svg": "image/svg+xml",
                ".ico": "image/x-icon",
            }.get(ext, "application/octet-stream")
            return self._send_file(rel, ctype)
        # Allow bare asset names too (app.js / styles.css) for convenience.
        if path.lstrip("/") in ("app.js", "styles.css"):
            rel = path.lstrip("/")
            ctype = ("application/javascript; charset=utf-8"
                     if rel.endswith(".js") else "text/css; charset=utf-8")
            return self._send_file(rel, ctype)
        return self._send(404, {"error": "not found"})


def main():
    parser = argparse.ArgumentParser(description="Temperature & system monitor dashboard")
    parser.add_argument("--host", default="127.0.0.1",
                        help="bind address (default 127.0.0.1; use 0.0.0.0 to expose)")
    parser.add_argument("--port", type=int, default=8420, help="port (default 8420)")
    parser.add_argument("--interval", type=float, default=1.0,
                        help="sampling interval in seconds (default 1.0)")
    parser.add_argument("--no-ipmi", action="store_true",
                        help="don't read DIMM temps from the BMC via ipmitool (which may use sudo)")
    args = parser.parse_args()

    collector = Collector(interval=args.interval, use_ipmi=not args.no_ipmi)
    collector.start()
    # Wait for the first full snapshot (nvidia-smi / ipmitool priming can take a
    # few seconds) so the first page load already has data.
    deadline = time.time() + 15
    while time.time() < deadline and "cpu" not in collector.latest():
        time.sleep(0.1)

    Handler.collector = collector
    httpd = ThreadingHTTPServer((args.host, args.port), Handler)
    url = f"http://{'localhost' if args.host in ('127.0.0.1', '0.0.0.0') else args.host}:{args.port}"
    print("=" * 60)
    print("  Temperature & System Monitor")
    print("=" * 60)
    print(f"  Dashboard:  {url}")
    print(f"  Sampling:   every {args.interval:g}s")
    print(f"  Bind:       {args.host}:{args.port}")
    if args.host not in ("127.0.0.1", "localhost", "::1"):
        print("-" * 60)
        print("  ⚠  WARNING: bound to a non-loopback address.")
        print("     This exposes your system telemetry and process list to")
        print("     anyone who can reach this host. There is no authentication.")
        print("     Use 127.0.0.1 unless you specifically intend this.")
    print("=" * 60)
    print("  Press Ctrl+C to stop.")
    print("=" * 60)
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print("\nShutting down…")
    finally:
        collector.stop()
        httpd.server_close()


if __name__ == "__main__":
    main()
