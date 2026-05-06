# btcticker

Real-time BTC/USDT price ticker. Full-viewport number, 24hr change percentage, WebSocket status bar. No server, no build step, no dependencies.

---

## How It Works

```
Binance WebSocket ──► app.js (browser) ──► requestAnimationFrame ──► DOM
 btcusdt@ticker        parses price +        batches writes at
 ~100ms updates        24hr % change         2/s max
```

The browser connects directly to Binance's public WebSocket stream. The `btcusdt@ticker` event includes both the current price (`c`) and 24hr change percentage (`P`) — no backend or history file needed.

---

## File Structure

```
btcticker/
├── index.html               — markup: price div + status bar
├── style.css                — layout, Bebas Neue font, decimal/change styling
├── app.js                   — Binance WebSocket client, formatter, DOM updates
└── assets/
    └── bebas-neue-400.woff2 — self-hosted font (13.7 KB, no Google Fonts)
```

---

## Usage

Open `index.html` directly in a browser. No server required.

```bash
open index.html         # macOS
xdg-open index.html     # Linux
```

For kiosk / fullscreen display:

```bash
# Chromium
chromium-browser --kiosk --incognito index.html

# Firefox
firefox --kiosk index.html
```

---

## Display

```
┌─────────────────────────────┐
│                             │
│   97,000  +2%               │
│           .50               │
│                             │
│    WS-Status: ● live        │
└─────────────────────────────┘
```

- Price scales with viewport (`min(30vw, 80vh)`) — fills any screen size
- 24hr change stacked above the decimal, green `+` / red `−`
- Status bar: pulsing green dot when live, red when reconnecting, stale timestamp when data stops
- Exponential backoff reconnect: 1s → 2s → 4s … capped at 16s

---

## Font

**Bebas Neue** self-hosted from `assets/bebas-neue-400.woff2`. No external requests on load.
