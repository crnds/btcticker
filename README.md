```
 ██████╗██████╗ ███╗   ██╗    ████████╗██╗ ██████╗██╗  ██╗███████╗██████╗
██╔════╝██╔══██╗████╗  ██║    ╚══██╔══╝██║██╔════╝██║ ██╔╝██╔════╝██╔══██╗
██║     ██████╔╝██╔██╗ ██║       ██║   ██║██║     █████╔╝ █████╗  ██████╔╝
██║     ██╔══██╗██║╚██╗██║       ██║   ██║██║     ██╔═██╗ ██╔══╝  ██╔══██╗
╚██████╗██║  ██║██║ ╚████║       ██║   ██║╚██████╗██║  ██╗███████╗██║  ██║
 ╚═════╝╚═╝  ╚═╝╚═╝  ╚═══╝       ╚═╝   ╚═╝ ╚═════╝╚═╝  ╚═╝╚══════╝╚═╝  ╚═╝
```

*Real-time BTC price ticker — static web app + Android APK, no server, no dependencies.*

---

## Live

[**crnds.github.io/btcticker**](https://crnds.github.io/btcticker) — open in any browser, no install required.

---

## Android

[**Download APK (v1.3.0)**](https://github.com/crnds/btcticker/releases/tag/v1.3.0) — sideload on any Android device (API 24+).

Enable **Install unknown apps** in Android Settings, then open the APK to install.

---

## How It Works

```
Exchange WebSocket ──► app.js (browser) ──► requestAnimationFrame ──► DOM
 live trade stream       parses price +        batches writes at
 ~100ms updates          24hr % change         2/s max
```

The browser connects directly to the selected exchange's public WebSocket stream. Price snapshots are saved to `localStorage` every minute and pruned to a rolling 24hr window — the last known price renders instantly on load before the socket connects.

The CDC Action Zone strip reads 30 days of daily OHLC data and renders a colour-coded EMA(12)/EMA(26) crossover bar chart at the bottom of the screen.

---

## Exchanges

Switch via the `···` menu. Selection is persisted to `localStorage`.

| Exchange | Feed | Pair |
|---|---|---|
| Binance | WebSocket | BTC/USDT |
| Bitstamp | WebSocket + REST | BTC/USD |
| Coinbase | WebSocket | BTC/USD |
| Kraken | WebSocket v2 | BTC/USD |
| OKX | WebSocket | BTC/USDT |

---

## Android Widgets

Five home screen widgets across three sizes. All show a live preview in the widget picker, have a manual ↻ refresh button, and reschedule their alarms after device reboot.

| Widget | Size | Refresh |
|---|---|---|
| BTC Ticker | 2×1 | 10 min |
| CDC Strip | 2×1 | Daily |
| BTC Price | 1×1 | 10 min |
| CDC | 1×1 | Daily |
| BTC + CDC | 2×1 | 10 min (CDC lazy) |

### BTC Ticker (2×1)

```
┌──────────────────────────────┐
│ 104,888                   ↻  │
│                   3m ago +6% │
└──────────────────────────────┘
```

Live BTC/USDT price autoscaled to fill the full widget height. % change and last-fetch time overlaid at bottom-right.

### CDC Strip (2×1)

```
┌──────────────────────────────┐
│ CDC · 3m ago              ↻  │
│ ▄▄▂▂██▃▃▅▅██▄▄▂▂▇▇▄▄▂▂██   │
└──────────────────────────────┘
```

30-day EMA(12)/EMA(26) crossover strip — green bars = bull, red bars = bear, today's bar at 40% opacity. Fetches from Kraken OHLC once daily.

### BTC Price (1×1)

```
┌──────────────┐
│          ↻   │
│  104,888     │
│         +6%  │
└──────────────┘
```

Compact single-cell price widget. Same Binance feed, 10-minute refresh.

### CDC (1×1)

```
┌──────────────┐
│ CDC      ↻   │
│ ▄▂█▃▅█▄▂▇▄  │
│ ▅█▄▂▄█▅▂██  │
└──────────────┘
```

CDC strip squeezed into a single cell — bars rendered with no gaps to fit all 30 days.

### BTC + CDC (2×1)

```
┌─────────────────┬───────────────┐
│                 │ CDC · 3h ago ↻│
│    104,888      │ ▄▂█▃▅█▄▂▇▄   │
│           +6%   │ ▅█▄▂▄█▅▂██   │
└─────────────────┴───────────────┘
```

Combined widget — price on the left half, CDC strip on the right half, equal 50/50 split. Price refreshes every 10 minutes; CDC re-fetches only when the cache is older than 12 hours.

---

## File Structure

```
btcticker/
├── index.html              — ticker: price display + exchange menu + CDC strip
├── style.css               — layout, Bebas Neue font, dark theme
├── app.js                  — WebSocket client, localStorage history, CDC logic
├── db.html                 — dashboard: CDC stats + price history
├── fetch_cdc.py            — fetches daily OHLC from Kraken, writes data/cdc.js
├── data/
│   └── cdc.js              — bundled CDC data (fallback when API is unavailable)
├── assets/
│   └── bebas-neue-400.woff2 — self-hosted display font (13.7 KB)
├── android/                — Capacitor Android project (build APK in Android Studio)
│   └── app/src/main/java/com/btcticker/app/
│       ├── PriceWidgetProvider.java       — BTC Ticker widget (2×1)
│       ├── CdcWidgetProvider.java         — CDC Strip widget (2×1)
│       ├── PriceWidgetSmallProvider.java  — BTC Price widget (1×1)
│       ├── CdcWidgetSmallProvider.java    — CDC widget (1×1)
│       ├── CombinedWidgetProvider.java    — BTC + CDC widget (2×1)
│       └── BootReceiver.java              — reschedules alarms after reboot
├── capacitor.config.json   — Capacitor config (webDir: www)
└── package.json            — Capacitor dependencies only
```

---

## Usage

Open `index.html` directly in a browser. No build step or server required.

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
┌─────────────────────────────────┐
│ ···                          ⛶  │
│                                 │
│      104,888  +6%               │
│              .50                │
│                                 │
│  ▄▄ ▂▂ ██ ▃▃ ▅▅ ██ ▄▄ ▂▂ ▇▇   │  ← CDC strip (30 days, green/red)
│  WS-Status: ● live  2s ago      │
└─────────────────────────────────┘
```

- Price scales with viewport (`min(30vw, 80vh)`) — fills any screen size
- 24hr % change stacked above the decimal, green `+` / red `−`
- CDC Action Zone: 30-day EMA(12)/EMA(26) crossover bars — green = bull, red = bear
- Status bar: pulsing green dot when live, red when reconnecting
- Exponential backoff reconnect: 1s → 2s → 4s … capped at 16s
- `F` key or button toggles fullscreen

---

## CDC Data

Three-tier fallback so the strip always renders:

1. **`localStorage`** — cached for 1 hour after last fetch
2. **`data/cdc.js`** — bundled snapshot committed to the repo
3. **Kraken REST API** — live fetch (`/public/OHLC?pair=XBTUSD&interval=1440`)

To refresh the bundled snapshot manually:

```bash
python3 fetch_cdc.py
```

---

## Building the Android APK

Requires [Android Studio](https://developer.android.com/studio).

```bash
# 1. Sync web assets into the Android project
cp index.html style.css app.js db.html www/
cp -r assets data www/
npx cap sync android

# 2. Open in Android Studio
npx cap open android

# 3. Build → Build APK(s) → app-debug.apk
```

---

## Local Storage Keys

| Key | Contents |
|---|---|
| `btcticker_history` | Price snapshots (rolling 24hr) |
| `btcticker_exchange` | Last selected exchange |
| `btcticker_v1_cdc` | CDC blocks cache (1hr TTL) |

---

## Font

**Bebas Neue** self-hosted from `assets/bebas-neue-400.woff2`. No external font requests on load.
