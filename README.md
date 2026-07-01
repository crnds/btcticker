```
 ██████╗██████╗ ███╗   ██╗    ████████╗██╗ ██████╗██╗  ██╗███████╗██████╗
██╔════╝██╔══██╗████╗  ██║    ╚══██╔══╝██║██╔════╝██║ ██╔╝██╔════╝██╔══██╗
██║     ██████╔╝██╔██╗ ██║       ██║   ██║██║     █████╔╝ █████╗  ██████╔╝
██║     ██╔══██╗██║╚██╗██║       ██║   ██║██║     ██╔═██╗ ██╔══╝  ██╔══██╗
╚██████╗██║  ██║██║ ╚████║       ██║   ██║╚██████╗██║  ██╗███████╗██║  ██║
 ╚═════╝╚═╝  ╚═╝╚═╝  ╚═══╝       ╚═╝   ╚═╝ ╚═════╝╚═╝  ╚═╝╚══════╝╚═╝  ╚═╝
```

*Real-time BTC price ticker — static web app + Android APK, no server, no dependencies.*

<img src="docs/hero.jpg" width="480" alt="BTC Ticker running on a wall-mounted display">

*Works as a dedicated Bitcoin dashboard or always-on Bitcoin clock — mount any screen, open the browser, done.*

---

## Live

[**crnds.github.io/btcticker**](https://crnds.github.io/btcticker) — open in any browser, no install required.

---

## Android

[**Download APK (v1.10.0)**](https://github.com/crnds/btcticker/releases/tag/v1.10.0) — sideload on any Android device (API 24+).

Enable **Install unknown apps** in Android Settings, then open the APK to install.

> Upgrading from v1.9.0 or earlier? Those builds were debug-signed; v1.10.0 is the first release-signed build, so Android requires a one-time **uninstall → reinstall** (widgets need re-adding). Future updates install in place.

<img src="docs/widgets.jpg" width="480" alt="Android home screen showing four BTC widgets">

*Four widgets on a single home screen: the wide BTC Large (top-left) shows the full price with last-fetch time and % change; the compact BTC Small (top-right) gives a square glanceable price; the Combined Small (bottom-left) combines price and a mini CDC strip in one cell; and the CDC Large (bottom-right) shows the full 30-day EMA crossover chart. All update independently and share a background cache.*

---

## How It Works

```
Exchange WebSocket ──► app.js (browser) ──► requestAnimationFrame ──► DOM
 live trade stream       parses price +        batches writes at
 ~100ms updates          24hr % change         1/s max
```

The browser connects directly to the selected exchange's public WebSocket stream. Price snapshots are saved to `localStorage` every 5 minutes and pruned to a rolling 24 hr window — the last known price renders instantly on load before the socket connects.

The CDC Action Zone strip reads 30 days of daily OHLC data and renders a colour-coded EMA(12)/EMA(26) crossover bar chart at the bottom of the screen.

**Kiosk hygiene, tuned for weak hardware.** This app is built to run unattended for weeks on low-power kiosk boxes, so a few things are deliberately conservative: `#price` updates in place (persistent DOM nodes, only the sub-value that changed is touched) rather than being rebuilt from an HTML string on every tick, since it's close to the largest painted area on the whole screen; the render/localStorage cadences above favor fewer writes and repaints over sub-second precision; and the page reloads itself once a day at 4am local time to reset the JS heap and any browser-level memory fragmentation, regardless of how leak-free the app itself is.

---

## Exchanges

Switch via the `···` menu. Selection is persisted to `localStorage`.

| Exchange | Feed | Pair |
|---|---|---|
| Binance | WebSocket | BTC/USDT |
| Bitstamp | WebSocket | BTC/USD |
| Coinbase | WebSocket | BTC/USD |
| Kraken | WebSocket v2 | BTC/USD |
| OKX | WebSocket | BTC/USDT |

Bitstamp's trade stream doesn't include a 24h change figure, and their REST ticker endpoint now sits behind bot-protection that blocks plain fetches — so its % change is instead derived from the app's own rolling price history rather than fetched live.

The same `···` menu has a **Display** section below the exchange list, letting you show/hide each metric independently — TX Fees, F&G Index, 24H % Change, CDC Strip. All four are visible by default; toggling doesn't close the menu, so you can flip several at once. The choice is persisted to `localStorage` and restored on the next visit.

---

## Display

```
┌─────────────────────────────────┐
│ ···   NO  LOW  MED  HIGH     ⛶  │
│       0.4  0.6  0.8   1         │
│                                 │
│                             17  │
│      104,888              +6%   │
│                     .50         │
│  ▄▄ ▂▂ ██ ▃▃ ▅▅ ██ ▄▄ ▂▂ ▇▇   │  ← CDC strip (30 days, green/red)
│  WS-Status: ● live  2s ago      │
└─────────────────────────────────┘
```

- Price scales with viewport (`min(30vw, 80vh)`) — fills any screen size
- Fee bar (top): four sat/vB tiers from mempool.space, also `min(vw, vh)`-scaled so it stays legible on short kiosk screens, not just narrow ones
- Fear & Greed index stacked above the 24 hr % change, coloured by quintile band
- 24 hr % change stacked above the decimal, green `+` / red `−`
- CDC Action Zone: 30-day EMA(12)/EMA(26) crossover bars — green = bull, red = bear
- Status bar: pulsing green dot when live, red when reconnecting
- Exponential backoff reconnect: 1s → 2s → 4s … capped at 16s
- `F` key or button toggles fullscreen

---

## Android Widgets

Seven home screen widgets across three sizes. All show a live preview thumbnail in the widget picker, have an orange refresh button, and automatically reschedule their alarms after device reboot.

| Widget | Size | Refresh | Data source |
|---|---|---|---|
| BTC Large | 2×1 | 10 min | Binance REST |
| CDC Large | 2×1 | Daily | Kraken OHLC |
| BTC Small | 1×1 | 10 min | Binance REST |
| CDC Small | 1×1 | Daily | Kraken OHLC |
| Combined Large | 2×1 | 10 min (CDC lazy) | Binance + Kraken |
| Combined Small | 1×1 | 10 min (CDC lazy) | Binance + Kraken |
| Fear & Greed | 2×1 | Daily | CoinMarketCap |

### BTC Large (2×1)

```
┌──────────────────────────────────┐
│ 104,888                        ↻ │
│  at 23:24 (5m ago)          +6% │
└──────────────────────────────────┘
```

Price autoscales to fill the full widget height. % change and last-fetch time (absolute 24hr clock + relative age) overlaid at bottom-right.

### CDC Large (2×1)

```
┌──────────────────────────────────┐
│ CDC · at 23:24 (3h ago)        ↻ │
│ ▄▄▂▂██▃▃▅▅██▄▄▂▂▇▇▄▄▂▂██       │
└──────────────────────────────────┘
```

30-day EMA(12)/EMA(26) crossover strip. Green bars = bull, red bars = bear, today's bar at 40% opacity. Refreshes once daily; falls back to cached data when offline.

### BTC Small (1×1)

```
┌──────────────┐
│           ↻  │
│  104,888     │
│         +6%  │
└──────────────┘
```

Compact single-cell price widget. Same autoscaled price, % change overlaid bottom-right.

### CDC Small (1×1)

```
┌──────────────┐
│ CDC       ↻  │
│ ▄▂█▃▅█▄▂▇▄  │
│ ▅█▄▂▄█▅▂██  │
└──────────────┘
```

CDC strip squeezed into a single cell — 30 bars with no gaps to fit the full history.

### Combined Large (2×1)

```
┌─────────────────┬───────────────────────┐
│                 │ CDC · at 23:24 (3h ago)│
│    104,888      │ ▄▂█▃▅█▄▂▇▄          ↻ │
│           +6%   │ ▅█▄▂▄█▅▂██            │
└─────────────────┴───────────────────────┘
```

Combined widget — price on the left half, CDC strip on the right half, 50/50 split. Price refreshes every 10 minutes; CDC re-fetches only when the cache is older than 12 hours.

### Combined Small (1×1)

```
┌──────────────┐
│  104,888  ↻  │
│         +6%  │
├──────────────┤
│ ▄▂█▃▅█▄▂▇▄  │
└──────────────┘
```

Compact single-cell combined widget — price with % change in the top half, CDC strip in the bottom half, 50/50 vertical split. Price refreshes every 10 minutes; CDC re-fetches only when the cache is older than 12 hours.

### Fear & Greed (2×1)

```
┌──────────────────────────────────┐
│ Fear & Greed                   ↻ │
│      ●                           │
│   ██ ██ ██ ██ ██                 │
│        15                        │
│    Extreme fear                  │
└──────────────────────────────────┘
```

Semicircular gauge with 5 colour-coded arc segments (red → orange → yellow → light green → green). A white dot marks the current value position on the arc. Fetches the [alternative.me Fear & Greed Index](https://alternative.me/crypto/fear-and-greed-index/) (keyless API) once daily; falls back to cached value when offline.

The value number is coloured by the same quintile bands as the arc:

| Range | Colour |
|---|---|
| 0–19 | `#ff1744` red |
| 20–39 | `#ff6d00` orange |
| 40–59 | `#ffeb3b` yellow |
| 60–79 | `#69f0ae` light green |
| 80–100 | `#00e676` bright green |

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

## Transaction Fees

Four priority tiers (No / Low / Med / High) shown above the price, sourced from mempool.space's [`/api/v1/fees/mempool-blocks`](https://mempool.space/docs/api/rest#get-mempool-blocks-fees) — each projected block holds ~10 min of pending transactions, and the median fee at a given block depth becomes that tier:

| Tier | Depth | ETA |
|---|---|---|
| High | 1st projected block | ~10 min |
| Med | 3rd projected block | ~30 min |
| Low | 6th projected block | ~1 hr |
| No | cheapest projected block | economy |

This gives genuinely fractional sat/vB values, unlike the whole-number `/fees/recommended` endpoint. Polled every 60s and cached in `localStorage` (shared with the dashboard) so the bar repaints instantly on load.

**Display rounding** happens client-side only — values ≥1 sat/vB round to a whole number, values below 1 round to 1 decimal (e.g. `0.27` → `0.3`). The fetched and cached values themselves always stay fractional-precise; only the on-screen text is rounded.

---

## Fear & Greed Index (Ticker)

Shown stacked above the 24 hr % change, coloured by quintile band (red → orange → yellow → light green → green). Unlike the Android widget (which uses the keyless alternative.me API), the ticker's reading comes from **CoinMarketCap**, which requires a private API key — so it's never fetched from the browser. Instead, a GitHub Actions workflow (`update-fng.yml`) fetches it server-side every 6 hours and commits the result to `data/fng.js`:

1. **`localStorage`** — cached for 1 hour after last read
2. **`data/fng.js`** — bundled snapshot committed by CI
3. A reading older than 48 hours is flagged **stale** in the UI (dimmed, dotted underline) — a signal the refresh pipeline (e.g. the `CMC_API_KEY` secret) needs attention

To refresh the bundled snapshot manually (requires `CMC_API_KEY`):

```bash
CMC_API_KEY=xxxxxxxx python3 fetch_fng.py
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

### Release build

Release builds are signed and minified (R8). Signing material lives in
`android/keystore.properties` + `android/btcticker-release.keystore` — both
gitignored, **back them up**; losing the keystore means users must uninstall
and reinstall to upgrade.

```bash
cd android && ./gradlew assembleRelease
# → app/build/outputs/apk/release/app-release.apk
```

If `keystore.properties` is absent the release build falls back to unsigned.
To regenerate signing material:

```bash
keytool -genkeypair -keystore android/btcticker-release.keystore \
  -alias btcticker -keyalg RSA -keysize 2048 -validity 10000
# then write android/keystore.properties:
#   storeFile=btcticker-release.keystore
#   storePassword=…
#   keyAlias=btcticker
#   keyPassword=…
```

---

## File Structure

```
btcticker/
├── index.html              — ticker: price display + exchange menu + fee bar + CDC strip
├── style.css               — layout, Bebas Neue font, dark theme
├── app.js                  — WebSocket client, localStorage history, CDC/fees/F&G logic
├── db.html                 — dashboard: CDC stats + fee tiers + price history
├── fetch_cdc.py            — fetches daily OHLC from Kraken, writes data/cdc.js
├── fetch_fng.py            — fetches CoinMarketCap Fear & Greed index, writes data/fng.js
├── data/
│   ├── cdc.js              — bundled CDC data (fallback when API is unavailable)
│   └── fng.js              — bundled Fear & Greed snapshot (fallback when API is unavailable)
├── assets/
│   └── bebas-neue-400.woff2 — self-hosted display font (13.7 KB)
├── install.sh              — Linux kiosk installer (browser launcher + autostart)
├── .github/workflows/
│   ├── update-cdc.yml      — daily GitHub Actions refresh of data/cdc.js
│   └── update-fng.yml      — 6-hourly GitHub Actions refresh of data/fng.js
├── docs/                   — README screenshots
├── android/                — Capacitor Android project (build APK in Android Studio)
│   └── app/src/main/java/com/btcticker/app/
│       ├── BaseWidgetProvider.java        — shared alarm/refresh/fetch plumbing
│       ├── BinanceApi.java                — BTCUSDT ticker fetch + prefs cache
│       ├── KrakenCdc.java                 — CDC blocks fetch/cache + strip renderer
│       ├── Http.java                      — small HTTP response reader
│       ├── PriceWidgetProvider.java       — BTC Large widget (2×1)
│       ├── CdcWidgetProvider.java         — CDC Large widget (2×1)
│       ├── PriceWidgetSmallProvider.java  — BTC Small widget (1×1)
│       ├── CdcWidgetSmallProvider.java    — CDC Small widget (1×1)
│       ├── CombinedWidgetProvider.java    — Combined Large widget (2×1)
│       ├── MiniCombinedWidgetProvider.java — Combined Small widget (1×1)
│       ├── FearGreedWidgetProvider.java   — Fear & Greed widget (2×1)
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

## Local Storage Keys

| Key | Contents |
|---|---|
| `btcticker_v1_history` | Price snapshots (rolling 24 hr) |
| `btcticker_v1_exchange` | Last selected exchange |
| `btcticker_v1_cdc` | CDC blocks cache (1 hr TTL) |
| `btcticker_v1_fng` | Fear & Greed index cache (1 hr TTL) |
| `btcticker_v2_fees` | Mempool fee tiers cache (60s TTL) — shared with the dashboard |
| `btcticker_v1_visibility` | Per-metric show/hide preference (TX Fees, F&G, % change, CDC strip) |

Pre-v1 unversioned keys (`btcticker_history`, `btcticker_exchange`) are migrated automatically on first load.

---

## Font

**Bebas Neue** self-hosted from `assets/bebas-neue-400.woff2`. No external font requests on load.

---

## Data Sources & Credits

BTC Ticker has no backend of its own — every number on screen is fetched straight from a public API. Thanks to these providers for making free market data available:

| Provider | Used for |
|---|---|
| [Binance](https://www.binance.com) | Live price stream (default exchange) and the Android widgets' REST ticker |
| [Bitstamp](https://www.bitstamp.net) | Live price stream (24h change is derived locally, not fetched) |
| [Coinbase](https://www.coinbase.com) | Live price stream (Advanced Trade WebSocket) |
| [Kraken](https://www.kraken.com) | Live price stream + daily OHLC candles powering the CDC Action Zone |
| [OKX](https://www.okx.com) | Live price stream |
| [mempool.space](https://mempool.space) | Transaction fee tiers, via their [mempool-blocks endpoint](https://mempool.space/docs/api/rest#get-mempool-blocks-fees) |
| [CoinMarketCap](https://coinmarketcap.com) | Fear & Greed Index for the ticker (fetched server-side only, via a private API key) |
| [Alternative.me](https://alternative.me/crypto/fear-and-greed-index/) | Fear & Greed Index for the Android widget (keyless, public endpoint) |

None of these providers endorse or are affiliated with this project — they're credited here simply because this app couldn't exist without their free, public data. In return, BTC Ticker tries to be a good citizen of each API: requests are read-only, cached in `localStorage` before ever hitting the network again, polled on the slowest cadence that still feels live (60s–24h depending on the source), and WebSocket reconnects back off exponentially instead of hammering a dead connection.

---

## Changelog

### v1.10.0
- **Security**: removed the hardcoded CoinMarketCap API key — Fear & Greed widget now uses the keyless [alternative.me](https://alternative.me/crypto/fear-and-greed-index/) API; widget receivers are no longer exported (third-party apps can't trigger refresh fetches); release builds are now signed and R8-minified (`android/keystore.properties`, gitignored); `allowBackup` disabled.
- **Android refactor**: extracted `BaseWidgetProvider` + `BinanceApi`/`KrakenCdc`/`Http` helpers — 1,933 → ~950 lines across the widget code. Refresh broadcasts now use `goAsync()` so updates aren't killed mid-fetch; all network failures are logged (`btcticker.widget` tag); connections closed via try-with-resources.
- **Fetch dedupe**: widget families sharing a data source reuse a fetch made within the last 60 s — multiple widgets (or a boot restart) trigger one Binance/Kraken call instead of four; manual tap always forces a fresh fetch.
- Failed CDC fetch with no cache now shows "CDC · failed" instead of being stuck on "fetching…"; manual refresh no longer wipes the displayed price; small widgets expose data age via accessibility content description; Fear & Greed value colour now uses the same quintile bands as the arc (Neutral 50 is yellow, not green).
- **Ticker fixes**: WebSocket backoff actually backs off now (was resetting to 1 s on every retry); pending reconnect timers cleared on exchange switch; price history is no longer fabricated while the socket is down; cached prices show their real age on load; CDC strip shows an error state when all data tiers fail.
- **Conventions**: single `STATE` object, CSS custom-property tokens in `style.css`, `prefers-reduced-motion` support, visible focus rings, keyboard-accessible exchange menu (real buttons + ARIA), localStorage keys versioned to `btcticker_v1_*` with automatic migration.
- **Pipeline**: `fetch_cdc.py` validates the Kraken response (error field, ≥56 candles) and writes atomically; GitHub Actions pinned to commit SHAs; `install.sh` is idempotent and runs `apt-get update` first.

### v1.9.0
- **Widget picker previews**: All 7 widgets now show high-quality, representative preview thumbnails in the Android widget selection screen (long-press home → Widgets).
- Removed the generic app launcher icon as `previewImage` fallback across all widget providers — was displaying the wrong icon on many devices and launchers.
- Significantly improved the Fear & Greed preview layout to include the 5 colour-coded arc segments, position indicator dot, value, classification label, and timestamp — now visually matches the actual rendered gauge.
- Widgets no longer appear blank or empty on first placement from the picker: added immediate skeleton states (`—` for prices, `CDC · –` for strips, etc.) in `onUpdate` before network fetches complete.
- Added missing default `—` placeholder to the Combined Large (2×1) price pane.
- Fixed incorrect "1×1" comment for the Fear & Greed widget in `AndroidManifest.xml`.
- Added `android/.idea/` to `.gitignore` (prevented IDE files from leaking into the repo).
- Minor preview layout polish (refresh button sizes, padding, and positioning for better visual parity with runtime widgets).

### v1.8.0
- Added Fear & Greed widget (2×1) — semicircular gauge with 5 colour-coded segments, white dot indicator, and value/label rendered as a Canvas bitmap; fetches CoinMarketCap Fear & Greed Index once daily

### v1.7.0
- Renamed all six widget picker labels: BTC Large, BTC Small, CDC Large, CDC Small, Combined Large, Combined Small
- Fixed 2×1 widget grid size: `minWidth` corrected from 180dp to 110dp — was occupying 3 columns instead of 2 on POCO and Samsung launchers
- Last-fetch time now shows absolute 24hr clock + relative age: `at 23:24 (5m ago)`
- Last-fetch time colour changed to white (#ffffff) across all widgets
- Fixed missing initial label text on CDC Small widget (showed blank until first alarm)
- Added missing `minResizeWidth`/`minResizeHeight` to Combined Small widget info

### v1.6.0
- Added 1×1 BTC Mini widget — price in the top half, CDC strip in the bottom half, 50/50 vertical split

### v1.5.0
- Refresh button restored to original orange (#F4620E) and original sizes (24dp / 28dp / 20dp / 24dp) across all widgets

### v1.4.0
- Audit fixes: added `textSize` fallback on price widgets for API 24–25 compatibility; added `—` placeholder on 1×1 price widget initial state
- BootReceiver refactored — each of the 5 providers restarts independently with isolated error handling
- Combined widget (BTC + CDC) crash fix: replaced unsupported `<View>` divider with `<TextView>` for RemoteViews compatibility

### v1.3.0
- Added 1×1 BTC Price widget
- Added 1×1 CDC widget
- Added 2×1 BTC + CDC combined widget
- All 5 widgets have live preview thumbnails in the widget picker

### v1.2.0
- Widget picker thumbnails (previewLayout) for BTC Ticker and CDC Strip
- Renamed widget picker labels to "BTC Ticker" and "CDC Strip"

### v1.1.0
- BTC Ticker home screen widget (2×1) — Binance price, 10-min auto-refresh
- CDC Strip home screen widget (2×1) — Kraken OHLC, daily auto-refresh
- BootReceiver to reschedule alarms after device reboot
