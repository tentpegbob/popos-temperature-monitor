/* Temperature & System Monitor — frontend.
   Dependency-free: hand-rolled canvas gauges + history charts, live polling. */
"use strict";

// --------------------------------------------------------------------------- //
// small utilities
// --------------------------------------------------------------------------- //
const _vars = {};
function cssVar(name) {
  if (!(name in _vars)) {
    _vars[name] = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  }
  return _vars[name];
}
const SEV_RANK = { ok: 0, warn: 1, crit: 2 };
function sevColor(sev) {
  return { ok: cssVar("--ok"), warn: cssVar("--warn"), crit: cssVar("--crit") }[sev] || cssVar("--ok");
}
function severity(v, warn, crit) {
  if (v == null || isNaN(v)) return "ok";
  if (crit != null && v >= crit) return "crit";
  if (warn != null && v >= warn) return "warn";
  return "ok";
}
function sevOf(m) { return m ? severity(m.value, m.warn, m.crit) : "ok"; }
function worst(...sevs) { return sevs.reduce((a, b) => (SEV_RANK[b] > SEV_RANK[a] ? b : a), "ok"); }

function humanBytes(n) {
  if (n == null || isNaN(n)) return "—";
  const u = ["B", "KiB", "MiB", "GiB", "TiB", "PiB"];
  let i = 0; n = Number(n);
  while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
  return n.toFixed(n < 10 && i > 0 ? 1 : 0) + " " + u[i];
}
function fmtUptime(boot) {
  if (!boot) return "—";
  let s = Math.max(0, Date.now() / 1000 - boot);
  const d = Math.floor(s / 86400); s -= d * 86400;
  const h = Math.floor(s / 3600); s -= h * 3600;
  const m = Math.floor(s / 60);
  return (d ? d + "d " : "") + h + "h " + m + "m";
}
function el(tag, attrs, kids) {
  const e = document.createElement(tag);
  attrs = attrs || {};
  for (const k in attrs) {
    const val = attrs[k];
    if (k === "class") e.className = val;
    else if (k === "html") e.innerHTML = val;
    else if (k === "text") e.textContent = val;
    else if (k.slice(0, 2) === "on") e.addEventListener(k.slice(2), val);
    else if (val != null) e.setAttribute(k, val);
  }
  for (const c of [].concat(kids == null ? [] : kids)) {
    if (c == null) continue;
    e.appendChild(typeof c === "string" ? document.createTextNode(c) : c);
  }
  return e;
}

// --------------------------------------------------------------------------- //
// rolling history buffers
// --------------------------------------------------------------------------- //
const HIST = new Map();
const MAXLEN = 180;
let redrawOnly = false; // when true, pushHist is suppressed (redraw uses existing buffers)
function pushHist(id, v) {
  if (redrawOnly) return;
  let a = HIST.get(id);
  if (!a) { a = []; HIST.set(id, a); }
  a.push(v == null || isNaN(v) ? null : v);
  if (a.length > MAXLEN) a.shift();
}
function hist(id) { return HIST.get(id) || []; }

// --------------------------------------------------------------------------- //
// canvas drawing
// --------------------------------------------------------------------------- //
function drawGauge(canvas, value, max, sev, unit) {
  const W = 104, H = 84, dpr = window.devicePixelRatio || 1;
  if (canvas.width !== Math.round(W * dpr)) { canvas.width = W * dpr; canvas.height = H * dpr; }
  const ctx = canvas.getContext("2d");
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, W, H);
  const cx = W / 2, cy = H / 2 + 9, r = 33, lw = 9;
  const a0 = Math.PI * 0.75, a1 = Math.PI * 2.25;
  const frac = max > 0 ? Math.max(0, Math.min(1, (value || 0) / max)) : 0;

  ctx.lineWidth = lw; ctx.lineCap = "round";
  ctx.strokeStyle = cssVar("--track");
  ctx.beginPath(); ctx.arc(cx, cy, r, a0, a1); ctx.stroke();

  if (value != null && frac > 0) {
    ctx.strokeStyle = sevColor(sev);
    ctx.beginPath(); ctx.arc(cx, cy, r, a0, a0 + (a1 - a0) * frac); ctx.stroke();
  }

  ctx.textAlign = "center"; ctx.textBaseline = "middle";
  ctx.fillStyle = value == null ? cssVar("--text-faint") : cssVar("--text");
  ctx.font = "600 19px system-ui, sans-serif";
  const txt = value == null ? "—" : String(Math.round(value * 10) / 10);
  ctx.fillText(txt, cx, cy - 2);
  ctx.font = "500 10px system-ui, sans-serif";
  ctx.fillStyle = cssVar("--text-faint");
  ctx.fillText(unit || "", cx, cy + 15);
}

function drawHistory(canvas, data, opt) {
  opt = opt || {};
  const dpr = window.devicePixelRatio || 1;
  const w = canvas.clientWidth || 300, h = canvas.clientHeight || 64;
  if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
    canvas.width = Math.round(w * dpr); canvas.height = Math.round(h * dpr);
  }
  const ctx = canvas.getContext("2d");
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);

  const min = opt.min != null ? opt.min : 0;
  const max = opt.max || 100;
  const color = opt.color || cssVar("--accent");
  const pad = 3, plotH = h - pad * 2;
  const X = (i, n) => (n <= 1 ? w : (i / (n - 1)) * w);
  const Y = (v) => pad + plotH - ((Math.max(min, Math.min(max, v)) - min) / (max - min)) * plotH;

  // threshold guide lines
  for (const pair of [[opt.warn, cssVar("--warn")], [opt.crit, cssVar("--crit")]]) {
    const t = pair[0];
    if (t != null && t > min && t < max) {
      ctx.strokeStyle = pair[1]; ctx.globalAlpha = 0.22; ctx.setLineDash([4, 4]); ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(0, Y(t)); ctx.lineTo(w, Y(t)); ctx.stroke();
      ctx.setLineDash([]); ctx.globalAlpha = 1;
    }
  }

  const n = data.length;
  if (!n) return;
  const hasNull = data.indexOf(null) !== -1;

  if (!hasNull && n > 1) { // area fill
    const grad = ctx.createLinearGradient(0, 0, 0, h);
    grad.addColorStop(0, color + "55"); grad.addColorStop(1, color + "00");
    ctx.beginPath(); ctx.moveTo(0, h - pad);
    for (let i = 0; i < n; i++) ctx.lineTo(X(i, n), Y(data[i]));
    ctx.lineTo(X(n - 1, n), h - pad); ctx.closePath();
    ctx.fillStyle = grad; ctx.fill();
  }

  ctx.lineWidth = 1.6; ctx.strokeStyle = color; ctx.lineJoin = "round";
  ctx.beginPath(); let started = false;
  for (let i = 0; i < n; i++) {
    const v = data[i];
    if (v == null) { started = false; continue; }
    const px = X(i, n), py = Y(v);
    if (!started) { ctx.moveTo(px, py); started = true; } else ctx.lineTo(px, py);
  }
  ctx.stroke();
}

// --------------------------------------------------------------------------- //
// reusable components
// --------------------------------------------------------------------------- //
function gaugeBlock(label) {
  const canvas = el("canvas");
  const block = el("div", { class: "gauge" }, [canvas, el("div", { class: "g-label", text: label })]);
  return { el: block, canvas };
}

function chartBlock(title) {
  const canvas = el("canvas", { class: "chart" });
  const cur = el("span");
  const wrap = el("div", { class: "chart-wrap" }, [
    el("div", { class: "chart-title" }, [el("span", { text: title }), cur]),
    canvas,
  ]);
  return { el: wrap, canvas, cur };
}

function tempBarRow() {
  const name = el("span", { class: "name" });
  const val = el("span", { class: "val" });
  const fill = el("span");
  const bar = el("div", { class: "bar" }, [fill]);
  const row = el("div", { class: "barline" }, [
    el("div", { class: "lab" }, [name, val]), bar,
  ]);
  function update(label, m, scaleMax) {
    name.textContent = label;
    if (!m || m.value == null) { val.textContent = "—"; val.className = "val"; fill.style.width = "0%"; return; }
    const sev = sevOf(m);
    val.textContent = m.value.toFixed(1) + " °C";
    val.className = "val v " + sev;
    const max = scaleMax || (m.crit ? m.crit + 5 : 100);
    fill.style.width = Math.max(2, Math.min(100, (m.value / max) * 100)) + "%";
    fill.style.background = sevColor(sev);
  }
  return { el: row, update };
}

function statBlock(key) {
  const v = el("span", { class: "v ok" });
  const block = el("div", { class: "stat" }, [el("span", { class: "k", text: key }), v]);
  function set(text, sev) { v.textContent = text; v.className = "v " + (sev || "ok"); }
  return { el: block, set };
}

const GRIP_SVG =
  '<svg viewBox="0 0 10 16" width="10" height="16" fill="currentColor" aria-hidden="true">' +
  '<circle cx="2" cy="2" r="1.4"/><circle cx="8" cy="2" r="1.4"/>' +
  '<circle cx="2" cy="8" r="1.4"/><circle cx="8" cy="8" r="1.4"/>' +
  '<circle cx="2" cy="14" r="1.4"/><circle cx="8" cy="14" r="1.4"/></svg>';

function cardShell(title, sub) {
  const dot = el("span", { class: "sev-dot" });
  const tag = el("span", { class: "card-tag" });
  const h2kids = [dot, document.createTextNode(title)];
  if (sub) h2kids.push(el("span", { class: "card-sub", text: sub }));

  const grip = el("span", { class: "grip", title: "Drag to reorder", html: GRIP_SVG });
  const headLeft = el("div", { class: "head-left" }, [grip, el("h2", {}, h2kids)]);
  const head = el("div", { class: "card-head" }, [headLeft, tag]);
  const body = el("div", { class: "card" });
  body.appendChild(head);

  // Card is only draggable while you actually grab the grip handle.
  grip.addEventListener("mousedown", () => { body.draggable = true; });
  body.addEventListener("dragstart", (e) => {
    body.classList.add("dragging");
    e.dataTransfer.effectAllowed = "move";
    try { e.dataTransfer.setData("text/plain", body.dataset.cardKey || ""); } catch (_) {}
  });
  body.addEventListener("dragend", () => {
    body.classList.remove("dragging");
    body.draggable = false;
    saveOrder();
  });

  function setSev(sev) { dot.style.background = sevColor(sev); }
  function setTag(t) { tag.textContent = t || ""; }
  return { el: body, head, setSev, setTag };
}

// --------------------------------------------------------------------------- //
// card builders — each returns { el, update(data) }
// --------------------------------------------------------------------------- //
function buildCpuCard(meta) {
  const shell = cardShell("CPU");
  shell.el.classList.add("card--wide");
  shell.setTag(`${meta.physical_cores}C / ${meta.logical_cores}T`);

  const gUsage = gaugeBlock("Load");
  const gTemp = gaugeBlock("Temp");
  const gauges = el("div", { class: "gauges" }, [gUsage.el, gTemp.el]);

  const cLoad = chartBlock("Load %");
  const cTemp = chartBlock("Temp °C");
  const charts = el("div", { style: "display:grid;grid-template-columns:1fr 1fr;gap:10px" }, [cLoad.el, cTemp.el]);

  const sFreq = statBlock("Frequency");
  const sLoad = statBlock("Load avg");
  const sPeak = statBlock("Hottest core");
  const stats = el("div", { class: "stats" }, [sFreq.el, sLoad.el, sPeak.el]);

  const ccd = el("div", { class: "stats" });

  // per-core heatmap
  const n = meta.logical_cores;
  const cols = n > 64 ? 32 : Math.min(16, n);
  const coreGrid = el("div", { class: "cores", style: `grid-template-columns:repeat(${cols},1fr)` });
  const cells = [];
  for (let i = 0; i < n; i++) { const c = el("div", { class: "core" }); cells.push(c); coreGrid.appendChild(c); }
  const coresLabel = el("div", { class: "note", text: `Per-core utilisation (${n} threads)` });

  shell.el.append(gauges, charts, stats, ccd, coresLabel, coreGrid);

  function update(d) {
    const cpu = d.cpu || {};
    if (cpu.error) { return; }
    const tm = cpu.temp;
    drawGauge(gUsage.canvas, cpu.usage, 100, severity(cpu.usage, 85, 95), "%");
    drawGauge(gTemp.canvas, tm ? tm.value : null, tm && tm.crit ? tm.crit + 5 : 100, sevOf(tm), "°C");

    pushHist("cpu.load", cpu.usage);
    pushHist("cpu.temp", tm ? tm.value : null);
    cLoad.cur.textContent = (cpu.usage != null ? cpu.usage.toFixed(0) : "—") + " %";
    cTemp.cur.textContent = tm && tm.value != null ? tm.value.toFixed(0) + " °C" : "—";
    drawHistory(cLoad.canvas, hist("cpu.load"), { max: 100, warn: 85, crit: 95, color: cssVar("--accent") });
    drawHistory(cTemp.canvas, hist("cpu.temp"), {
      max: tm && tm.crit ? tm.crit + 5 : 100, warn: tm ? tm.warn : null, crit: tm ? tm.crit : null,
      color: sevColor(sevOf(tm)),
    });

    if (cpu.freq_mhz) {
      sFreq.set((cpu.freq_mhz / 1000).toFixed(2) + " GHz" + (cpu.freq_max ? ` / ${(cpu.freq_max / 1000).toFixed(1)}` : ""));
    } else sFreq.set("—");
    sLoad.set((cpu.load || []).map((x) => x.toFixed(2)).join("  ") || "—");

    const cores = cpu.per_core || [];
    let peak = 0;
    for (let i = 0; i < cells.length; i++) {
      const u = cores[i] != null ? cores[i] : 0;
      if (u > peak) peak = u;
      cells[i].style.background = `hsl(${210 - 2.1 * u} 72% ${22 + u * 0.30}%)`;
      cells[i].title = `Core ${i}: ${u.toFixed(0)}%`;
    }
    sPeak.set(peak.toFixed(0) + " %", severity(peak, 90, 99));

    // per-die CCD temps
    const dies = cpu.cores_temp || [];
    if (ccd.childElementCount !== dies.length) {
      ccd.textContent = "";
      ccd._blocks = dies.map(() => { const b = statBlock(""); ccd.appendChild(b.el); return b; });
    }
    if (ccd._blocks) dies.forEach((die, i) => {
      const b = ccd._blocks[i];
      b.el.querySelector(".k").textContent = die.label;
      b.set(die.value != null ? die.value.toFixed(1) + " °C" : "—", severity(die.value, die.warn, die.crit));
    });

    shell.setSev(worst(sevOf(tm), severity(peak, 95, 100)));
  }
  return { el: shell.el, update };
}

function buildMemoryCard(meta) {
  const shell = cardShell("Memory");
  shell.setTag(humanBytes(meta.mem_total));

  const gUsage = gaugeBlock("RAM");
  const gauges = el("div", { class: "gauges" }, [gUsage.el]);
  const chart = chartBlock("RAM usage %");

  // used/total + swap bars
  const usedRow = tempBarRowGeneric();
  const swapRow = tempBarRowGeneric();
  const bars = el("div", { style: "display:flex;flex-direction:column;gap:10px" }, [usedRow.el, swapRow.el]);

  const dimmLabel = el("div", { class: "note", text: "Memory bank (DIMM) temperatures" });
  const dimmList = el("div", { class: "templist" });
  let dimmRows = [];

  shell.el.append(gauges, chart.el, bars, dimmLabel, dimmList);

  function update(d) {
    const m = d.memory || {};
    if (m.error) { dimmLabel.textContent = "memory error: " + m.error; return; }
    const sev = severity(m.percent, m.warn, m.crit);
    drawGauge(gUsage.canvas, m.percent, 100, sev, "%");
    pushHist("mem.pct", m.percent);
    chart.cur.textContent = (m.percent != null ? m.percent.toFixed(0) : "—") + " %";
    drawHistory(chart.canvas, hist("mem.pct"), { max: 100, warn: m.warn, crit: m.crit, color: cssVar("--accent") });

    usedRow.update("RAM", `${humanBytes(m.used)} / ${humanBytes(m.total)}`, m.percent, m.warn, m.crit);
    swapRow.update("Swap", m.swap_total ? `${humanBytes(m.swap_used)} / ${humanBytes(m.swap_total)}` : "none",
      m.swap_percent || 0, 50, 80);

    const dimms = m.dimms || [];
    if (dimms.length !== dimmRows.length) {
      dimmList.textContent = "";
      dimmRows = dimms.map(() => { const r = tempBarRow(); dimmList.appendChild(r.el); return r; });
      if (!dimms.length) dimmLabel.textContent = "No per-DIMM temperature sensors detected";
    }
    let dsev = "ok";
    dimms.forEach((dm, i) => { dimmRows[i].update(dm.label, dm); dsev = worst(dsev, sevOf(dm)); });

    shell.setSev(worst(sev, dsev));
  }
  return { el: shell.el, update };
}

// percentage bar (not a temperature) — reuses .barline markup
function tempBarRowGeneric() {
  const name = el("span", { class: "name" });
  const val = el("span", { class: "val" });
  const fill = el("span");
  const bar = el("div", { class: "bar" }, [fill]);
  const row = el("div", { class: "barline" }, [el("div", { class: "lab" }, [name, val]), bar]);
  function update(label, text, pct, warn, crit) {
    name.textContent = label; val.textContent = text;
    const sev = severity(pct, warn, crit);
    val.className = "val v " + sev;
    fill.style.width = Math.max(0, Math.min(100, pct || 0)) + "%";
    fill.style.background = sevColor(sev);
  }
  return { el: row, update };
}

function buildGpuCard(gpu) {
  const vendorBadge = gpu.vendor === "nvidia" ? "NVIDIA" : (gpu.vendor === "amd" ? "AMD" : gpu.vendor);
  const shell = cardShell(gpu.name || vendorBadge, vendorBadge + " · GPU " + gpu.index);
  const idp = `gpu.${gpu.vendor}.${gpu.index}`;

  const gUtil = gaugeBlock("Util");
  const gMem = gaugeBlock("VRAM");
  const gTemp = gaugeBlock("Temp");
  const gauges = el("div", { class: "gauges" }, [gUtil.el, gMem.el, gTemp.el]);

  const cUtil = chartBlock("Utilisation %");
  const cTemp = chartBlock("Temp °C");
  const charts = el("div", { style: "display:grid;grid-template-columns:1fr 1fr;gap:10px" }, [cUtil.el, cTemp.el]);

  const tempLabel = el("div", { class: "note", text: "Temperatures" });
  const tempList = el("div", { class: "templist" });
  let tempRows = [];

  const sVram = statBlock("VRAM");
  const sPower = statBlock("Power");
  const sFan = statBlock("Fan");
  const sClk = statBlock("Clocks");
  const stats = el("div", { class: "stats" }, [sVram.el, sPower.el, sFan.el, sClk.el]);

  shell.el.append(gauges, charts, tempLabel, tempList, stats);

  function primaryTemp(temps) {
    if (!temps || !temps.length) return null;
    const pref = temps.find((t) => /gpu|edge/i.test(t.label));
    return pref || temps[0];
  }

  function update(g) {
    const util = g.util, mem = g.mem || {};
    const temps = g.temps || [];
    const pt = primaryTemp(temps);

    drawGauge(gUtil.canvas, util ? util.value : null, 100, sevOf(util), "%");
    drawGauge(gMem.canvas, mem.percent, 100, severity(mem.percent, 90, 98), "%");
    drawGauge(gTemp.canvas, pt ? pt.value : null, pt && pt.crit ? pt.crit + 5 : 100, sevOf(pt), "°C");

    pushHist(idp + ".util", util ? util.value : null);
    pushHist(idp + ".temp", pt ? pt.value : null);
    cUtil.cur.textContent = util && util.value != null ? util.value.toFixed(0) + " %" : "—";
    cTemp.cur.textContent = pt && pt.value != null ? pt.value.toFixed(0) + " °C" : "—";
    drawHistory(cUtil.canvas, hist(idp + ".util"), { max: 100, warn: 90, color: cssVar("--accent") });
    drawHistory(cTemp.canvas, hist(idp + ".temp"), {
      max: pt && pt.crit ? pt.crit + 5 : 100, warn: pt ? pt.warn : null, crit: pt ? pt.crit : null,
      color: sevColor(sevOf(pt)),
    });

    if (temps.length !== tempRows.length) {
      tempList.textContent = "";
      tempRows = temps.map(() => { const r = tempBarRow(); tempList.appendChild(r.el); return r; });
    }
    let tsev = "ok";
    temps.forEach((t, i) => { tempRows[i].update(t.label, t); tsev = worst(tsev, sevOf(t)); });

    sVram.set(`${humanBytes(mem.used)} / ${humanBytes(mem.total)}`, severity(mem.percent, 90, 98));
    const ex = g.extra || {};
    sPower.set(ex.power != null ? ex.power.toFixed(0) + " W" + (ex.power_limit ? ` / ${ex.power_limit.toFixed(0)}` : "") : "—");
    sFan.set(ex.fan != null ? (g.vendor === "amd" ? ex.fan + " RPM" : ex.fan + " %") : "—");
    sClk.set([ex.clock_sm ? ex.clock_sm + " MHz" : null, ex.clock_mem ? ex.clock_mem + " mem" : null].filter(Boolean).join(" · ") || "—");

    shell.setSev(worst(sevOf(util), tsev, severity(mem.percent, 92, 99)));
  }
  return { el: shell.el, update, idp };
}

function buildStorageCard(storage) {
  const shell = cardShell("Storage", "temperature & capacity");

  const tempLabel = el("div", { class: "note", text: "Drive temperatures" });
  const tempList = el("div", { class: "templist" });
  const capLabel = el("div", { class: "note", text: "Disk capacity" });
  const capList = el("div", { class: "templist" });
  shell.el.append(tempLabel, tempList, capLabel, capList);

  let tRows = [], cRows = [];

  function update(s) {
    s = s || {};
    const temps = s.temps || [];
    const disks = s.disks || [];
    let sev = "ok";

    tempLabel.style.display = temps.length ? "" : "none";
    if (temps.length !== tRows.length) {
      tempList.textContent = "";
      tRows = temps.map(() => { const r = tempBarRow(); tempList.appendChild(r.el); return r; });
    }
    temps.forEach((t, i) => { tRows[i].update(t.name, t); sev = worst(sev, sevOf(t)); });

    capLabel.style.display = disks.length ? "" : "none";
    if (disks.length !== cRows.length) {
      capList.textContent = "";
      cRows = disks.map(() => { const r = tempBarRowGeneric(); capList.appendChild(r.el); return r; });
    }
    disks.forEach((dsk, i) => {
      const text = `${humanBytes(dsk.used)} / ${humanBytes(dsk.total)} · ${dsk.percent.toFixed(0)}%`;
      cRows[i].update(dsk.mount, text, dsk.percent, dsk.warn, dsk.crit);
      sev = worst(sev, severity(dsk.percent, dsk.warn, dsk.crit));
    });

    shell.setSev(sev);
  }
  return { el: shell.el, update };
}

function buildProcCard() {
  const shell = cardShell("Top processes");
  shell.el.classList.add("card--wide");
  let mode = "by_cpu";
  const tabCpu = el("span", { class: "proc-tab active", text: "By CPU" });
  const tabMem = el("span", { class: "proc-tab", text: "By memory" });
  const tabs = el("div", { class: "proc-tabs" }, [tabCpu, tabMem]);

  const PROC_PRESETS = [5, 10, 15, 20, 30, 50, 100];
  let procN = loadProcN();
  const showSel = el("select", { class: "proc-show", title: "How many processes to list" },
    PROC_PRESETS.map((v) => el("option", { value: String(v) }, [String(v)])));
  showSel.value = String(procN);
  const controls = el("div", { class: "proc-controls" }, [
    tabs, el("label", { class: "ctl" }, ["Show ", showSel]),
  ]);
  shell.head.appendChild(controls);
  const tbody = el("tbody");
  const table = el("table", { class: "proc" }, [
    el("thead", {}, [el("tr", {}, [
      el("th", { text: "PID" }), el("th", { text: "Process" }),
      el("th", { text: "CPU %", style: "text-align:right" }),
      el("th", { text: "Memory", style: "text-align:right" }),
    ])]), tbody,
  ]);
  shell.el.append(table);
  let last = null;

  function render() {
    const arr = (last && last[mode]) || [];
    const n = Math.min(arr.length, procN);
    tbody.textContent = "";
    for (let i = 0; i < n; i++) {
      const p = arr[i];
      tbody.appendChild(el("tr", {}, [
        el("td", { class: "num", text: String(p.pid) }),
        el("td", { class: "name", title: p.name, text: p.name }),
        el("td", { class: "num", text: (p.cpu != null ? p.cpu.toFixed(1) : "—") }),
        el("td", { class: "num", text: humanBytes(p.mem_mb * 1024 * 1024) }),
      ]));
    }
    shell.setTag(arr.length ? `top ${n}` : "");
  }
  tabCpu.addEventListener("click", () => { mode = "by_cpu"; tabCpu.classList.add("active"); tabMem.classList.remove("active"); render(); });
  tabMem.addEventListener("click", () => { mode = "by_mem"; tabMem.classList.add("active"); tabCpu.classList.remove("active"); render(); });
  showSel.addEventListener("change", () => { procN = parseInt(showSel.value, 10) || 10; saveProcN(procN); render(); });
  function update(procs) { if (procs && !procs.error) { last = procs; render(); } }
  return { el: shell.el, update };
}

// --------------------------------------------------------------------------- //
// app wiring
// --------------------------------------------------------------------------- //
const grid = document.getElementById("grid");
const statusEl = document.getElementById("status");
const subtitleEl = document.getElementById("subtitle");
const footerEl = document.getElementById("footer");
const intervalSel = document.getElementById("interval");
const pauseBtn = document.getElementById("pause");
const resetBtn = document.getElementById("reset-layout");

let META = {};
let intervalMs = 1000;
let paused = false;
let timer = null;
let cards = null;       // { cpu, memory, gpus:[], storage, procs }
let shapeSig = "";
let lastData = null;    // most recent snapshot, for redraw-on-resize

function setStatus(state) {
  statusEl.className = "status status--" + state;
  statusEl.querySelector(".status-text").textContent =
    { live: "live", connecting: "connecting", down: "disconnected" }[state] || state;
}

function shapeOf(d) {
  const g = (d.gpus || []).map((x) => x.vendor + x.index).join(",");
  const cores = (d.cpu && d.cpu.logical_cores) || META.logical_cores || 0;
  const dimms = (d.memory && d.memory.dimms ? d.memory.dimms.length : 0);
  const st = d.storage || {};
  const storage = `${(st.temps || []).length}-${(st.disks || []).length}`;
  return `${cores}|${dimms}|${g}|${storage}`;
}

function buildLayout(d) {
  grid.textContent = "";
  cards = { gpus: [] };

  // Prefer live snapshot values so the layout is correct even if /api/meta failed.
  const liveMeta = Object.assign({}, META, {
    logical_cores: (d.cpu && d.cpu.logical_cores) || META.logical_cores || 0,
    physical_cores: (d.cpu && d.cpu.physical_cores) || META.physical_cores || 0,
    mem_total: META.mem_total || (d.memory && d.memory.total) || 0,
  });

  cards.cpu = buildCpuCard(liveMeta);
  cards.cpu.el.dataset.cardKey = "cpu";
  grid.appendChild(cards.cpu.el);

  cards.memory = buildMemoryCard(liveMeta);
  cards.memory.el.dataset.cardKey = "memory";
  grid.appendChild(cards.memory.el);

  for (const g of d.gpus || []) {
    const c = buildGpuCard(g);
    c.el.dataset.cardKey = c.idp;
    cards.gpus.push(c);
    grid.appendChild(c.el);
  }
  const st = d.storage || {};
  if ((st.temps || []).length || (st.disks || []).length) {
    cards.storage = buildStorageCard(st);
    cards.storage.el.dataset.cardKey = "storage";
    grid.appendChild(cards.storage.el);
  }
  cards.procs = buildProcCard();
  cards.procs.el.dataset.cardKey = "procs";
  grid.appendChild(cards.procs.el);

  applyOrder(); // restore the user's saved drag order

  // Evict history buffers for ids no longer present (e.g. a removed GPU).
  const live = new Set(["cpu.load", "cpu.temp", "mem.pct"]);
  cards.gpus.forEach((c) => { live.add(c.idp + ".util"); live.add(c.idp + ".temp"); });
  for (const k of Array.from(HIST.keys())) if (!live.has(k)) HIST.delete(k);
}

// ---- "show N processes" preference --------------------------------------- //
const PROCN_KEY = "tempdash.procN";
function loadProcN() {
  const v = parseInt(localStorage.getItem(PROCN_KEY), 10);
  return [5, 10, 15, 20, 30, 50, 100].includes(v) ? v : 10;
}
function saveProcN(n) { try { localStorage.setItem(PROCN_KEY, String(n)); } catch (_) {} }

// ---- card drag-to-reorder + persistence ---------------------------------- //
const ORDER_KEY = "tempdash.cardOrder";
function cardOrder() {
  return Array.from(grid.querySelectorAll(".card")).map((c) => c.dataset.cardKey).filter(Boolean);
}
function saveOrder() {
  try { localStorage.setItem(ORDER_KEY, JSON.stringify(cardOrder())); } catch (_) {}
}
function loadOrder() {
  try { return JSON.parse(localStorage.getItem(ORDER_KEY)) || []; } catch (_) { return []; }
}
function applyOrder() {
  const saved = loadOrder();
  if (!saved.length) return;
  const els = Array.from(grid.querySelectorAll(".card"));
  const map = new Map(els.map((c) => [c.dataset.cardKey, c]));
  const seen = new Set(), ordered = [];
  saved.forEach((k) => { if (map.has(k)) { ordered.push(map.get(k)); seen.add(k); } });
  els.forEach((c) => { if (!seen.has(c.dataset.cardKey)) ordered.push(c); });
  ordered.forEach((elm) => grid.appendChild(elm)); // re-append in resolved order
}
function setupDragAndDrop() {
  grid.addEventListener("dragover", (e) => {
    const dragging = grid.querySelector(".card.dragging");
    if (!dragging) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
    let best = null, bestDist = Infinity;
    for (const elm of grid.querySelectorAll(".card:not(.dragging)")) {
      const b = elm.getBoundingClientRect();
      const cx = b.left + b.width / 2, cy = b.top + b.height / 2;
      const dist = (e.clientX - cx) ** 2 + (e.clientY - cy) ** 2;
      if (dist < bestDist) {
        bestDist = dist;
        const after = e.clientY > cy + b.height * 0.15 ||
          (Math.abs(e.clientY - cy) <= b.height / 2 && e.clientX > cx);
        best = { el: elm, after };
      }
    }
    if (!best) return;
    if (best.after) { if (best.el.nextSibling !== dragging) best.el.after(dragging); }
    else { if (best.el.previousSibling !== dragging) best.el.before(dragging); }
  });
  grid.addEventListener("drop", (e) => e.preventDefault());
  // Clear stray draggable=true after a click on the grip that wasn't a drag.
  document.addEventListener("mouseup", () => {
    grid.querySelectorAll('.card[draggable="true"]').forEach((c) => {
      if (!c.classList.contains("dragging")) c.draggable = false;
    });
  });
}

function onData(d) {
  if (!d || d.error) { return; }
  lastData = d;
  const sig = shapeOf(d);
  if (!cards || sig !== shapeSig) { shapeSig = sig; buildLayout(d); }

  if (cards.cpu) cards.cpu.update(d);
  if (cards.memory) cards.memory.update(d);
  (d.gpus || []).forEach((g, i) => { if (cards.gpus[i]) cards.gpus[i].update(g); });
  if (cards.storage) cards.storage.update(d.storage);
  if (cards.procs) cards.procs.update(d.processes);

  footerEl.innerHTML =
    `Uptime <code>${fmtUptime(META.boot_time)}</code> · ${META.os || ""} · ` +
    `Python <code>${META.python || "?"}</code> · psutil <code>${META.psutil || "?"}</code> · ` +
    `${META.tools && META.tools.nvidia_smi ? "nvidia-smi ✓ " : ""}` +
    `${META.tools && META.tools.amd_sysfs ? "amdgpu ✓ " : ""}` +
    `· updated ${new Date(d.ts * 1000).toLocaleTimeString()}`;
}

async function poll() {
  try {
    const r = await fetch("/api/metrics", { cache: "no-store" });
    if (!r.ok) throw new Error("HTTP " + r.status);
    onData(await r.json());
    setStatus("live");
  } catch (e) {
    setStatus("down");
  }
}

function schedule() {
  clearTimeout(timer);
  if (paused) return;
  timer = setTimeout(async () => { await poll(); schedule(); }, intervalMs);
}

async function loadMeta() {
  try {
    const r = await fetch("/api/meta", { cache: "no-store" });
    META = await r.json();
    subtitleEl.textContent =
      `${META.cpu_model} · ${META.logical_cores} threads · ${humanBytes(META.mem_total)} RAM · ${META.hostname}`;
  } catch (e) {
    subtitleEl.textContent = "could not load machine info";
  }
}

intervalSel.addEventListener("change", () => { intervalMs = parseInt(intervalSel.value, 10) || 1000; schedule(); });
pauseBtn.addEventListener("click", () => {
  paused = !paused;
  pauseBtn.textContent = paused ? "▶ Resume" : "⏸ Pause";
  if (paused) { clearTimeout(timer); setStatus("connecting"); statusEl.querySelector(".status-text").textContent = "paused"; }
  else { poll().then(schedule); }
});
// redraw on resize so charts stay crisp (even while paused) — reuse the last
// snapshot and suppress history pushes so we don't double-count samples.
let resizeTimer = null;
window.addEventListener("resize", () => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => {
    if (!cards || !lastData) return;
    redrawOnly = true;
    try { onData(lastData); } finally { redrawOnly = false; }
  }, 150);
});

if (resetBtn) resetBtn.addEventListener("click", () => {
  try { localStorage.removeItem(ORDER_KEY); } catch (_) {}
  shapeSig = "";              // force a rebuild in the default order
  if (lastData) onData(lastData);
});

(async function init() {
  setStatus("connecting");
  setupDragAndDrop();
  await loadMeta();
  await poll();
  schedule();
})();
