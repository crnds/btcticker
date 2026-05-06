# bitcointicker — Architecture & Implementation
*Built: 2026-05-05. Last updated: 2026-05-05.*

---

## Project Overview

A real-time BTC/USDT price ticker built for 24/7 display on a low-power machine (Intel Atom CPU, 2 GB RAM). Goals: fastest possible data delivery, minimum CPU load, and total RAM usage under 80 MB.

The display is a single full-viewport number — current BTC price with a 24hr change percentage and decimal — no charts, no history, no decorations. A small status bar at the bottom centre shows WebSocket health and the last time data was received.

---

## How It Works

```
Binance WebSocket ──► server.js (Node.js) ──► Socket.IO ──► index.html (browser)
 aggTrade stream       serves static files     emits every     requestAnimationFrame
 ~100ms updates        snapshots history       500ms only      batches DOM write
                       calculates 24hr %
```

The server does three jobs: holds a persistent WebSocket to Binance, serves all static files (HTML/CSS/font) over HTTP, and fans out `{ price, change }` to browser clients at a throttled 2/s rate.

---

## File Structure

```
bitcointicker/
├── server.js                  — Node.js: static file server + Binance WS + 24hr history + Socket.IO
├── index.html                 — Browser client: price + 24hr % + WS status bar
├── style.css                  — Bebas Neue font, layout, decimal/change styling
├── install.sh                 — One-command Linux installer (Mint, Ubuntu, Debian)
├── package.json               — Dependencies: socket.io, ws
├── assets/
│   └── bebas-neue-400.woff2   — self-hosted font (13.7 KB, no Google Fonts)
├── data/
│   └── history.json           — persisted price snapshots (auto-created, survives restarts)
└── bitcointicker.md
```

---

## Getting Started

### macOS / Windows
```bash
npm install        # first time only
node server.js     # start the server
```
Open `http://localhost:3000` in a browser. No build step required.

> You can also open `index.html` directly as a file — it loads socket.io from `http://localhost:3000` explicitly so the server must be running either way.

---

### Linux — One-line install (Mint · Ubuntu · Debian)

```bash
sudo bash install.sh
```

The script handles everything automatically:

| Step | What it does |
|------|-------------|
| 1 | Checks Node.js version, installs v22 via NodeSource if missing or outdated |
| 2 | Runs `npm install` |
| 3 | Creates `data/` directory |
| 4 | Writes and enables a systemd service (auto-starts on boot, restarts on crash) |
| 5 | Detects browser — Firefox ESR → Firefox → Chromium → Chrome (priority order) |
| 6 | Suppresses Firefox ESR first-run prompts via `user.js` |
| 7 | Creates XDG `.desktop` autostart entry to open browser in kiosk mode on login |

After install, open `http://localhost:3000` or reboot for full kiosk autostart.

**Useful commands after install:**
```bash
sudo systemctl status bitcointicker      # check server status
sudo journalctl -u bitcointicker -f      # live logs
sudo systemctl stop bitcointicker        # stop server
sudo systemctl disable --now bitcointicker && sudo rm /etc/systemd/system/bitcointicker.service  # uninstall
```

---

### Linux — Manual setup

**1. Install Node.js**
```bash
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt install -y nodejs
```

**2. Install dependencies**
```bash
cd ~/bitcointicker
npm install
node server.js
```

**3. Open in browser**
```bash
# Firefox ESR (Linux Mint default)
firefox-esr --kiosk http://localhost:3000

# Chromium
chromium-browser --kiosk --incognito http://localhost:3000
```

---

## Backend — `server.js`

### Static File Server

The HTTP server doubles as a static file host — no Express or extra dependencies needed:

```js
const http = createServer((req, res) => {
  const urlPath  = req.url === "/" ? "/index.html" : req.url;
  const filePath = path.join(__dirname, urlPath);

  // prevent directory traversal
  if (!filePath.startsWith(__dirname)) {
    res.writeHead(403); res.end(); return;
  }

  fs.readFile(filePath, (err, data) => {
    if (err) { res.writeHead(404); res.end(); return; }
    res.writeHead(200, { "Content-Type": MIME[path.extname(filePath)] });
    res.end(data);
  });
});
```

- Serves `index.html`, `style.css`, `assets/`, and the socket.io client bundle from the same origin.
- Eliminates the browser mixed-content block that occurs when opening `index.html` as `file://` and loading scripts from `http://` — both Firefox ESR and Chromium enforce this.
- Directory traversal protection: rejects any path that resolves outside `__dirname`.

### Binance WebSocket Stream

```
wss://stream.binance.com:9443/ws/btcusdt@aggTrade
```

- `aggTrade` — aggregate trade stream, fires on every settled trade (~100–200ms).
- Field `p` = price as a string. Public, no API key required.

### 24hr Change Calculation

The server stores a rolling price history and calculates the change locally — no reliance on Binance's own 24hr stats.

```js
const SNAPSHOT_INTERVAL = 60_000;           // snapshot every 1 minute
const WINDOW_MS         = 24 * 60 * 60_000; // keep 24 hrs of snapshots

setInterval(() => {
  history.push({ ts: Date.now(), price: latestPrice });
  history = history.filter(e => e.ts >= Date.now() - WINDOW_MS);
  saveHistory();
}, SNAPSHOT_INTERVAL);

function calc24hChange() {
  if (history.length < 1 || !latestPrice) return null;
  return ((latestPrice - history[0].price) / history[0].price) * 100;
}
```

- On first Binance message, an immediate seed snapshot is stored so the change is available instantly — no 60s wait.
- History is pruned to the last 24hrs on every snapshot.
- Saved to `data/history.json` — survives server restarts.

### Throttled Fanout

```js
setInterval(() => {
  if (latestPrice === lastEmitted || io.engine.clientsCount === 0) return;
  lastEmitted = latestPrice;
  io.volatile.emit("tick", { price: latestPrice, change: calc24hChange() });
}, 500);
```

- Absorbs ~10 Binance messages/s, pushes 2/s to clients.
- Skips emit when no clients are connected.
- `io.volatile.emit` — drops if client buffer is full, prevents stale burst.

### Immediate Tick on Connect

New clients receive the current price and change immediately on connect — no blank screen.

### Reconnect to Binance

Exponential backoff: starts at 1s, doubles on each failure, caps at 16s. Resets to 1s on successful reconnect.

### Socket.IO Config

WebSocket transport only — no HTTP long-polling fallback, no upgrade negotiation.

---

## Frontend — `index.html`

### Why `http://localhost:3000` not `file://`

`index.html` must be loaded via the server (`http://localhost:3000`), not opened directly as a file. When opened as `file://`, browsers block loading scripts from `http://` origins (mixed-content policy). Both Firefox ESR and Chromium enforce this — the socket.io client would fail to load.

The socket.io script tag and connection use explicit `localhost:3000` URLs so the page works whether opened via `http://` or `file://`:

```html
<script src="http://localhost:3000/socket.io/socket.io.js"></script>
```
```js
const socket = io("http://localhost:3000", { transports: ["websocket"], upgrade: false });
```

### Tick Handler

```js
socket.on("tick", ({ price, change }) => {
  latest      = price;
  latestChange = change;
  lastUpdated  = Date.now();
});
```

Stores latest values in memory — DOM is only written by the throttled `setInterval` + `requestAnimationFrame`.

### DOM Update — Throttled + Batched

```js
setInterval(() => {
  if (latest === last) return;
  last = latest;
  if (!pending) {
    pending = true;
    requestAnimationFrame(() => { el.innerHTML = fmt(last, latestChange); pending = false; });
  }
}, 500);
```

- `setInterval` at 500ms — at most 2 DOM writes/s.
- `requestAnimationFrame` — syncs write to paint frame, no mid-frame layout.
- `pending` flag collapses multiple ticks into one write per frame.

### Price Formatter

```js
function fmt(n, change) {
  const [int, dec] = n.toFixed(2).split(".");
  const intFmt  = int.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  const sign    = change >= 0 ? "+" : "";
  const cls     = change >= 0 ? "pos" : "neg";
  const chgHtml = `<span class="chg ${cls}">${sign}${Math.round(change)}%</span>`;
  return intFmt + `<span class="dec-wrap">${chgHtml}<span class="dec">.${dec}</span></span>`;
}
```

- Fast regex — avoids the Intl API (`toLocaleString`) on every call.
- 24hr change: whole number, `+`/`-` prefix, green/red, Bebas Neue font.
- `.dec-wrap` stacks `%` change above `.xx` decimal, right-aligned.

### WS Status Bar

Fixed bottom-centre bar:
- `● live  just now` — pulsing green dot when connected.
- `● reconnecting…  42s ago` — solid red dot + stale timestamp when disconnected.
- Timestamp ticks every second — immediately obvious when data stops.

---

## Styles — `style.css`

### Font

**Bebas Neue** (weight 400) — self-hosted from `assets/bebas-neue-400.woff2` (13.7 KB). No Google Fonts request. `font-display: block` prevents flash of fallback font. Used for both the price and the 24hr change percentage.

### Price Layout

```
┌─────────────────────────────┐
│                             │
│   97,000  +2%               │
│           .50               │
│                             │
│      WS-Status: ● live      │
└─────────────────────────────┘
```

- `font-size: min(30vw, 80vh)` — scales with viewport, no fixed px values.
- `white-space: nowrap` — prevents wrapping at any screen size.
- `.dec-wrap` — inline flex column, `%` change stacked above `.xx` decimal, right-aligned.
- `.dec` at `0.5em`, `.chg` at `0.18em` relative to main price font size.

---

## install.sh — Linux Installer

Supports: Linux Mint (Firefox ESR), Ubuntu, Debian. Run with `sudo bash install.sh`.

### Firefox ESR specifics

Firefox ESR is the default browser on Linux Mint. Two things differ from Chromium:
- Kiosk flag: `--kiosk` (not `--kiosk --incognito --disable-infobars`)
- First-run UI: suppressed by writing `user.js` prefs into the Firefox profile before autostart

### Browser detection order

`firefox-esr` → `firefox` → `chromium-browser` → `chromium` → `google-chrome`

---

## Dependencies

| Package | Version | Purpose |
|---------|---------|---------|
| `ws` | ^8.18.0 | WebSocket client — server to Binance |
| `socket.io` | ^4.8.1 | WebSocket server + static file bundle |

No frontend framework. No build step. No bundler.

---

## Memory Footprint

| Component | RAM |
|-----------|-----|
| Node.js server process | ~58 MB |
| Browser tab | ~25–35 MB |
| **Total** | **~85 MB** |

---

## Performance Optimisations

| Optimisation | Where | Effect |
|---|---|---|
| 500ms throttled emit | `server.js` | Cuts browser message rate from ~10/s to 2/s |
| Skip emit when no clients | `server.js` | Zero fanout CPU when nobody is watching |
| `volatile.emit` | `server.js` | Drops stale prices instead of queuing |
| Static file serving built-in | `server.js` | No extra process or dependency for HTTP |
| `requestAnimationFrame` + `pending` flag | `index.html` | One DOM write per paint frame max |
| Regex formatter | `index.html` | Avoids Intl API on every update |
| Self-hosted font | `assets/` | Zero external network request on load |
| No CSS transitions or animations | `style.css` | No GPU/compositor work (except WS pulse dot) |
| Viewport units only | `style.css` | No reflow from fixed-unit constraints |
