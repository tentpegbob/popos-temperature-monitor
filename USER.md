# Using the dashboard

Once it's running (`./run.sh --open`), open **http://localhost:8420** in any
modern browser. Everything updates live; nothing needs to be clicked to start.

## The top bar

| Control | What it does |
|---------|--------------|
| **● live / disconnected** | Connection status. "live" means data is flowing; it shows "disconnected" and keeps retrying if the server stops. |
| **Refresh** | How often the page pulls new data (1–5 s). |
| **⏸ Pause / ▶ Resume** | Freeze the dashboard (charts and values stop updating). |
| **⤺ Layout** | Reset the cards back to their default order. |

## Cards

Each card has a coloured dot next to its title showing the **worst severity**
inside it (green = ok, amber = warning, red = critical), so you can spot trouble
at a glance even when a card is scrolled off-screen.

- **CPU** — a gauge for overall load and one for package temperature, history
  sparklines, frequency, load average, per-die (CCD) temperatures, and a
  **per-thread heatmap** (one cell per logical CPU, blue = idle → red = busy;
  hover a cell for the exact %).
- **Memory** — RAM gauge + usage history, used / total and swap bars, and a
  **temperature bar for every populated DIMM**, each coloured against its own
  limits. (See "DIMM temperatures" below if you see fewer banks than you have.)
- **NVIDIA / AMD GPU** — one card per GPU: utilisation, VRAM used/total,
  temperatures (GPU/edge/junction/memory), power, fan, and clocks.
- **Storage** — drive temperatures plus a capacity bar (used / total / %) for
  each mounted filesystem.
- **Top processes** — the busiest processes, with a **By CPU / By memory**
  toggle and a **Show N** selector (5–100). Your choice is remembered.

## Colours & thresholds

Every temperature and percentage is coloured by severity:

- 🟢 **green** — normal
- 🟡 **amber** — at or above the *warning* threshold
- 🔴 **red** — at or above the *critical* threshold

Thresholds come from the sensors themselves wherever possible (e.g. a DIMM's
JEDEC limits, or the BMC's configured limits), with sensible fallbacks
otherwise. History charts draw dashed guide lines at the warn/critical levels.

## Reordering cards

Grab the **grip handle** (the dotted ⠿ icon on the left of any card's title)
and drag the card anywhere in the grid. The order is saved in your browser and
restored next time. **⤺ Layout** in the top bar resets it.

## What you'll see depends on your hardware

The dashboard only shows what your machine exposes:

- No discrete GPU → no GPU card. Only NVIDIA or only AMD → just that one.
- No `lm-sensors` installed → CPU/board temperatures may be missing (see
  [SETUP.md](SETUP.md)).
- **Fewer DIMM banks than you have?** Some boards (especially AMD HEDT /
  workstation) only expose a subset of DIMM temperature sensors to the OS. If
  your board has a BMC, the dashboard can read **all** of them via IPMI — see
  [SETUP.md → DIMM temperatures](SETUP.md#dimm-temperatures).

## Tips

- It's just a web page — open it on your phone/another machine by running with
  `--host 0.0.0.0` (read the security note in [SETUP.md](SETUP.md) first).
- Leave it open on a spare monitor as an always-on system gauge.
- Use **Pause** before taking a screenshot so the numbers hold still.
