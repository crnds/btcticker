// ── EXCHANGE CONFIGS ──────────────────────────────────────
// fetch-with-timeout, storage keys, F&G ramp/staleness, fee tiers and CDC bar
// scaling live in shared.js (window.BTC) — the dashboard (db.html) shares all
// of it. See shared.js's header comment for why it's a classic script.
const EXCHANGES = {
  binance: {
    label: 'Binance',
    url: 'wss://stream.binance.com:9443/ws/btcusdt@ticker',
    subscribe: null,
    parse(raw) {
      const d = JSON.parse(raw);
      return { price: parseFloat(d.c), change: parseFloat(d.P) };
    }
  },
  bitstamp: {
    label: 'Bitstamp',
    url: 'wss://ws.bitstamp.net',
    // Bitstamp's ticker REST endpoint now sits behind bot-protection that
    // returns an HTML challenge page instead of JSON (blocks plain fetches,
    // not just cross-origin ones) — derive the 24h change from our own
    // rolling price history instead; see estimateChangeFromHistory().
    init() {
      return { change: estimateChangeFromHistory() };
    },
    subscribe(ws) {
      ws.send(JSON.stringify({ event: 'bts:subscribe', data: { channel: 'live_trades_btcusd' } }));
    },
    parse(raw) {
      const d = JSON.parse(raw);
      if (d.event !== 'trade') return null;
      return { price: parseFloat(d.data.price), change: null };
    }
  },
  coinbase: {
    label: 'Coinbase',
    url: 'wss://advanced-trade-ws.coinbase.com',
    subscribe(ws) {
      ws.send(JSON.stringify({ type: 'subscribe', product_ids: ['BTC-USD'], channel: 'ticker' }));
    },
    parse(raw) {
      const d = JSON.parse(raw);
      if (d.channel !== 'ticker') return null;
      const t = d.events?.[0]?.tickers?.[0];
      if (!t) return null;
      return { price: parseFloat(t.price), change: parseFloat(t.price_percent_chg_24_h) };
    }
  },
  kraken: {
    label: 'Kraken',
    url: 'wss://ws.kraken.com/v2',
    subscribe(ws) {
      ws.send(JSON.stringify({ method: 'subscribe', params: { channel: 'ticker', symbol: ['BTC/USD'] } }));
    },
    parse(raw) {
      const d = JSON.parse(raw);
      if (d.channel !== 'ticker' || !d.data?.[0]) return null;
      const t = d.data[0];
      return { price: parseFloat(t.last), change: parseFloat(t.change_pct) };
    }
  },
  okx: {
    label: 'OKX',
    url: 'wss://ws.okx.com:8443/ws/v5/public',
    subscribe(ws) {
      ws.send(JSON.stringify({ op: 'subscribe', args: [{ channel: 'tickers', instId: 'BTC-USDT' }] }));
    },
    parse(raw) {
      const d = JSON.parse(raw);
      if (d.arg?.channel !== 'tickers' || !d.data?.[0]) return null;
      const t = d.data[0];
      const open = t.open24h ? parseFloat(t.open24h) : 0;
      const change = open !== 0
        ? ((parseFloat(t.last) - open) / open) * 100
        : null;
      return { price: parseFloat(t.last), change };
    }
  }
};

// ── STATE ─────────────────────────────────────────────────
const CDC_STORAGE_KEY = BTC.keys.cdc;
const CDC_TTL_MS      = 60 * 60 * 1000;
// 5 min: cuts localStorage writes 5x versus a 1 min cadence — kinder to the
// flash storage on a 24/7 kiosk box, and 5 min resolution is still plenty
// dense for a 24h history window
const SNAPSHOT_MS     = 5 * 60_000;
// 1s: still reads as "live" on a glance at a wall-mounted display, but halves
// the paint work of a 2/s cadence — #price is close to the largest painted
// area on screen, which matters on low-power kiosk hardware
const PRICE_TICK_MS   = 1000;
const REST_CHANGE_TTL_MS = 5 * 60_000;

// one-time migration from the pre-v1 unversioned keys — the ticker owns this;
// the dashboard just falls back to reading the legacy key (see BTC.history.load)
try {
  for (const [oldKey, newKey] of [[BTC.keys.exchangeLegacy, BTC.keys.exchange],
                                  [BTC.keys.historyLegacy,  BTC.keys.history]]) {
    const v = localStorage.getItem(oldKey);
    if (v !== null && localStorage.getItem(newKey) === null) localStorage.setItem(newKey, v);
    localStorage.removeItem(oldKey);
  }
} catch {}

// per-metric show/hide, exposed via the settings menu; everything is visible
// by default, and a missing/malformed stored value falls back rather than erroring
const VISIBILITY_DEFAULTS = { fees: true, fng: true, change: true, cdc: true, nightSchedule: false, nightForce: false };

function loadVisibility() {
  try {
    return { ...VISIBILITY_DEFAULTS, ...JSON.parse(localStorage.getItem(BTC.keys.visibility)) };
  } catch { return { ...VISIBILITY_DEFAULTS }; }
}

function saveVisibility(v) {
  try { localStorage.setItem(BTC.keys.visibility, JSON.stringify(v)); } catch {}
}

const STATE = {
  exchange: localStorage.getItem(BTC.keys.exchange) || 'binance',
  visibility: loadVisibility(),
  latest: 0,
  latestChange: null,
  last: 0,
  lastUpdated: null,
  pending: false,
  retryMs: 1000,
  ws: null,
  reconnectTimer: null,
  history: [],
  fearGreed: null   // { value, classification } — same index the widget shows
};

// ── DOM ───────────────────────────────────────────────────
// price is split into persistent sub-elements (rather than one element
// rebuilt via innerHTML) so each render only touches the specific text/class
// that actually changed — matters on kiosk-class hardware where #price is
// close to the largest painted area on the whole screen every tick
const priceIntEl = document.getElementById('price-int');
const priceDecEl = document.getElementById('price-dec');
const priceChgEl = document.getElementById('price-chg');
const priceFngEl = document.getElementById('price-fng');
// el.style.color reads back serialised ("rgb(255, 23, 68)"), never as the hex
// we wrote — comparing against the readback always fails, so track what we
// last wrote instead (see renderPriceDOM below)
let lastFngColor = '';
const pulse     = document.getElementById('ws-pulse');
const label     = document.getElementById('ws-label');
const menuBtn   = document.getElementById('menu-btn');
const menuList  = document.getElementById('menu-list');
const loadingEl = document.getElementById('loading');

// ── LOCALSTORAGE HISTORY ──────────────────────────────────
// load/save + the corrupt-entry validation live in shared.js (BTC.history) —
// the boot render below calls renderPriceDOM() -> price.toFixed(2) at module
// top level, so a bad entry there would strand the kiosk before connect(),
// applyVisibility() and scheduleReload() ever ran
STATE.history = BTC.history.load();

// best-effort 24h % change from our own rolling snapshots — used by exchanges
// whose ticker doesn't include a change figure (currently just Bitstamp).
// Accuracy improves as the 24h window fills in; needs 2+ samples so a lone
// snapshot doesn't read as a false "0% change" instead of "no data yet".
function estimateChangeFromHistory() {
  if (STATE.history.length < 2) return null;
  const oldest = STATE.history[0].price;
  const newest = STATE.history[STATE.history.length - 1].price;
  if (!oldest || !newest || oldest === 0) return null;
  return ((newest - oldest) / oldest) * 100;
}

function snapshotHistory() {
  // only snapshot prices confirmed live within the last interval — a dead
  // socket must not keep stamping the old price with fresh timestamps
  if (!STATE.latest || !STATE.lastUpdated || Date.now() - STATE.lastUpdated >= SNAPSHOT_MS) return;
  const now = Date.now();
  STATE.history.push({ ts: now, price: STATE.latest, change: STATE.latestChange });
  STATE.history = STATE.history.filter(e => e.ts >= now - BTC.history.WINDOW_MS);
  BTC.history.save(STATE.history);
}
setInterval(snapshotHistory, SNAPSHOT_MS);

// ── DISPLAY ───────────────────────────────────────────────
// updates only the sub-elements whose value actually changed, instead of
// rebuilding the whole #price subtree from an HTML string every tick
function renderPriceDOM(n, change) {
  const [int, dec] = n.toFixed(2).split('.');
  const intFmt = int.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  if (priceIntEl.textContent !== intFmt) priceIntEl.textContent = intFmt;
  if (priceDecEl.textContent !== dec) priceDecEl.textContent = dec;

  const showChg = STATE.visibility.change && change !== null && change !== undefined && !isNaN(change);
  priceChgEl.hidden = !showChg;
  if (showChg) {
    const sign = change >= 0 ? '+' : '';
    const text = `${sign}${Math.round(change)}%`;
    if (priceChgEl.textContent !== text) priceChgEl.textContent = text;
    priceChgEl.classList.toggle('pos', change >= 0);
    priceChgEl.classList.toggle('neg', change < 0);
  }

  const showFng = STATE.visibility.fng && !!STATE.fearGreed;
  priceFngEl.hidden = !showFng;
  if (showFng) {
    const { value, classification, updateTime } = STATE.fearGreed;
    const stale = BTC.fng.isStale(updateTime);
    const title = stale
      ? `Fear & Greed: ${classification} — stale (last updated ${updateTime})`
      : `Fear & Greed: ${classification}`;
    const valueStr = String(value);
    if (priceFngEl.textContent !== valueStr) priceFngEl.textContent = valueStr;
    priceFngEl.classList.toggle('stale', stale);
    const color = BTC.fng.colorFor(value);
    if (color !== lastFngColor) { priceFngEl.style.color = color; lastFngColor = color; }
    if (priceFngEl.title !== title) priceFngEl.title = title;
  }
}

function clearPriceDOM() {
  priceIntEl.textContent = '';
  priceDecEl.textContent = '';
  priceChgEl.hidden = true;
  priceFngEl.hidden = true;
}

function setStatus(state) {
  pulse.className = state;
  label.textContent = state === 'live' ? 'live'
    : state === 'reconnecting' ? 'reconnecting…' : 'connecting…';
}

function tickPriceRender() {
  if (STATE.latest === STATE.last) return;
  STATE.last = STATE.latest;
  if (!STATE.pending) {
    STATE.pending = true;
    requestAnimationFrame(() => { renderPriceDOM(STATE.last, STATE.latestChange); STATE.pending = false; });
  }
}
setInterval(tickPriceRender, PRICE_TICK_MS);

// ── FEAR & GREED INDEX ────────────────────────────────────
// CoinMarketCap's Fear & Greed index, refreshed every 6h server-side and
// committed to data/fng.js (window.LOCAL_FNG) — the CMC API needs a key, so
// it's never fetched from the client. CMC's index moves intraday, hence the
// 6h cadence rather than daily. Shown above the 24h change, beside the price
// decimals. Mirrors the CDC strip's file + localStorage caching.
const FNG_STORAGE_KEY = BTC.keys.fng;
const FNG_TTL_MS      = 60 * 60 * 1000;               // re-read the data file hourly
// colour ramp + staleness threshold/check live in shared.js (BTC.fng) — the
// dashboard's gauge uses the identical ramp and the identical 48h threshold

function renderPrice() {
  if (STATE.latest) renderPriceDOM(STATE.last || STATE.latest, STATE.latestChange);
}

function loadFearGreed() {
  // Tier 1: localStorage (read from the data file within the last hour)
  try {
    const cached = JSON.parse(localStorage.getItem(FNG_STORAGE_KEY));
    if (cached && !isNaN(cached.value)) {
      STATE.fearGreed = { value: cached.value, classification: cached.classification, updateTime: cached.updateTime };
      if (Date.now() - cached.ts < FNG_TTL_MS) return;   // still fresh — skip re-read
    }
  } catch {}

  // Tier 2: local data file (data/fng.js sets window.LOCAL_FNG)
  const f = window.LOCAL_FNG;
  if (f && !isNaN(f.value)) {
    const updateTime = f.update_time || f.generated || '';
    STATE.fearGreed = { value: f.value, classification: f.classification, updateTime };
    try { localStorage.setItem(FNG_STORAGE_KEY, JSON.stringify({ value: f.value, classification: f.classification, updateTime, ts: Date.now() })); } catch {}
    renderPrice();
  }
}

loadFearGreed();

// show last known price on load, or loading animation if no history.
// guarded: BTC.history.load() already validates price/ts, but nothing about
// painting a cached price is worth losing the live connection over — a throw
// here at module top level would skip every init step below it (connect(),
// applyVisibility(), scheduleReload()), stranding the kiosk
try {
  if (STATE.history.length) {
    const e = STATE.history[STATE.history.length - 1];
    STATE.latest = e.price;
    STATE.latestChange = e.change;
    STATE.lastUpdated = e.ts; // show the real age of the cached price, not "current"
    renderPriceDOM(STATE.latest, STATE.latestChange);
  } else {
    loadingEl.classList.add('active');
  }
} catch {
  loadingEl.classList.add('active');
}

// ── WEBSOCKET ─────────────────────────────────────────────
function connect(key) {
  // null every handler, not just onclose/onmessage: the guards below assume a
  // socket we've walked away from is fully detached. (close() during CONNECTING
  // fails the connection per spec, so onopen can't fire on it — but don't rely
  // on that alone.)
  if (STATE.ws) {
    STATE.ws.onopen = STATE.ws.onerror = STATE.ws.onclose = STATE.ws.onmessage = null;
    STATE.ws.close();
    STATE.ws = null;
  }
  clearTimeout(STATE.reconnectTimer);
  setStatus('connecting');

  const exchange = EXCHANGES[key];
  const ws = new WebSocket(exchange.url);
  STATE.ws = ws;

  ws.onopen = async () => {
    if (STATE.ws !== ws) return; // same stale-socket guard onclose has, below
    STATE.retryMs = 1000;
    setStatus('live');
    if (exchange.subscribe) exchange.subscribe(ws);
    if (exchange.init) {
      // await means the exchange can be switched out from under us mid-flight;
      // re-check before writing, and swallow a failed lookup — a broken 24h
      // change fetch must not become an unhandled rejection *and* skip initCDC()
      try {
        const { change } = await exchange.init();
        if (STATE.ws !== ws) return;
        if (change !== null && !isNaN(change)) STATE.latestChange = change;
      } catch {}
    }
    initCDC();
  };

  ws.onerror = () => ws.close();

  ws.onclose = () => {
    if (STATE.ws !== ws) return; // stale socket from a previous exchange
    setStatus('reconnecting');
    STATE.reconnectTimer = setTimeout(() => connect(STATE.exchange), STATE.retryMs);
    STATE.retryMs = Math.min(STATE.retryMs * 2, 16_000);
  };

  ws.onmessage = (e) => {
    // every parse() does a bare JSON.parse — a non-JSON frame (an OKX "pong",
    // a proxy's HTML error body, a truncated payload) must fail soft here
    // rather than throwing out of the event handler
    let result;
    try { result = exchange.parse(e.data); } catch { return; }
    if (!result || !result.price) return;
    STATE.latest = result.price;
    if (result.change !== null && !isNaN(result.change)) STATE.latestChange = result.change;
    STATE.lastUpdated = Date.now();
    loadingEl.classList.remove('active');

    if (!STATE.history.length) {
      STATE.history.push({ ts: Date.now(), price: STATE.latest, change: STATE.latestChange });
      BTC.history.save(STATE.history);
    }
  };
}

// Bitstamp's % change comes from a one-off REST call, not the trade stream —
// refresh it periodically so it doesn't go stale on a long-running kiosk
async function refreshRestChange() {
  const key = STATE.exchange;
  const exchange = EXCHANGES[key];
  if (!exchange.init || !STATE.ws || STATE.ws.readyState !== WebSocket.OPEN) return;
  try {
    const { change } = await exchange.init();
    if (STATE.exchange !== key) return; // exchange switched while awaiting
    if (change !== null && !isNaN(change)) STATE.latestChange = change;
  } catch {}
}
// setInterval discards the returned promise, so anything that escaped the
// internal try above would otherwise surface as an unhandled rejection
setInterval(() => { refreshRestChange().catch(() => {}); }, REST_CHANGE_TTL_MS);

// ── MENU ──────────────────────────────────────────────────
function updateActive() {
  menuList.querySelectorAll('button[data-exchange]').forEach(btn =>
    btn.classList.toggle('active', btn.dataset.exchange === STATE.exchange)
  );
}

function closeMenu() {
  menuList.classList.remove('open');
  menuBtn.setAttribute('aria-expanded', 'false');
}

// #fees and #cdc-strip fold away under the container queries in style.css
// when the viewport gets short (@container ticker max-height:120px/200px).
// Their checkboxes can't override that — the CQ rule wins over .hidden once
// .hidden is removed — so unchecking one back off in the menu silently does
// nothing there; reflect reality instead of offering a control with no
// effect. Reading computed style keeps style.css the single source of the
// thresholds, so they can't drift out of sync with a duplicated number here.
function refreshToggleAvailability() {
  for (const [key, el] of [['fees', feesSection], ['cdc', cdcStrip]]) {
    const input = menuList.querySelector(`input[data-toggle="${key}"]`);
    const folded = STATE.visibility[key] && getComputedStyle(el).display === 'none';
    input.disabled = folded;
    input.closest('.menu-toggle').title = folded ? 'Hidden automatically — not enough vertical space' : '';
  }
}

function openMenu() {
  updateActive();
  refreshToggleAvailability();
  menuList.classList.add('open');
  menuBtn.setAttribute('aria-expanded', 'true');
}

menuBtn.addEventListener('click', () => {
  menuList.classList.contains('open') ? closeMenu() : openMenu();
});

document.addEventListener('click', (e) => {
  if (!menuBtn.contains(e.target) && !menuList.contains(e.target)) closeMenu();
});

menuList.addEventListener('click', (e) => {
  const btn = e.target.closest('button[data-exchange]');
  if (!btn) return;
  const key = btn.dataset.exchange;
  closeMenu();
  if (key === STATE.exchange) return;
  STATE.exchange = key;
  try { localStorage.setItem(BTC.keys.exchange, key); } catch {}
  STATE.latest = 0; STATE.latestChange = null; STATE.last = 0; STATE.lastUpdated = null;
  clearPriceDOM();
  loadingEl.classList.add('active');
  updateActive();
  connect(key);
});

// ── DISPLAY TOGGLES ───────────────────────────────────────
// per-metric show/hide, exposed via the settings menu. #fees/#cdc-strip are
// hidden via a CSS class; the F&G/% change spans are handled inside
// renderPriceDOM() (see the DISPLAY section above), so a re-render is enough.
const feesSection  = document.getElementById('fees');
const toggleInputs = menuList.querySelectorAll('input[data-toggle]');

function applyVisibility() {
  feesSection.classList.toggle('hidden', !STATE.visibility.fees);
  cdcStrip.classList.toggle('hidden', !STATE.visibility.cdc);
  toggleInputs.forEach(input => { input.checked = STATE.visibility[input.dataset.toggle]; });
  renderPrice();
  updateNightMode();
  // un-hiding #cdc-strip is itself a height change (0 -> its real height),
  // which the ResizeObserver set up below already repaints on its own — no
  // need to force one here, and doing so would mean a synchronous layout read
  // (clientHeight) right after the class toggles above
}

menuList.addEventListener('change', (e) => {
  const input = e.target.closest('input[data-toggle]');
  if (!input) return;
  const key = input.dataset.toggle;
  STATE.visibility[key] = input.checked;
  saveVisibility(STATE.visibility);
  applyVisibility();
});

// ── FULLSCREEN ────────────────────────────────────────────
const fsBtn  = document.getElementById('fullscreen-btn');
const fsIcon = document.getElementById('fs-icon');
const EXPAND_D   = 'M1 6V1H6M15 6V1H10M1 10V15H6M15 10V15H10';
const COMPRESS_D = 'M6 1V6H1M10 1V6H15M6 15V10H1M10 15V10H15';

function isFullscreen() {
  return !!(document.fullscreenElement || document.webkitFullscreenElement);
}

function enterFullscreen() {
  const el = document.documentElement;
  if      (el.requestFullscreen)       el.requestFullscreen();
  else if (el.webkitRequestFullscreen) el.webkitRequestFullscreen();
}

function exitFullscreen() {
  if      (document.exitFullscreen)          document.exitFullscreen();
  else if (document.webkitExitFullscreen)    document.webkitExitFullscreen();
  else if (document.webkitCancelFullScreen)  document.webkitCancelFullScreen();
}

function toggleFullscreen() {
  isFullscreen() ? exitFullscreen() : enterFullscreen();
}

function onFullscreenChange() {
  fsIcon.querySelector('path').setAttribute('d', isFullscreen() ? COMPRESS_D : EXPAND_D);
}

fsBtn.addEventListener('click', toggleFullscreen);

document.addEventListener('keydown', (e) => {
  if (e.key === 'f' || e.key === 'F') toggleFullscreen();
  if (e.key === 'Escape') closeMenu();
});

document.addEventListener('fullscreenchange',       onFullscreenChange);
document.addEventListener('webkitfullscreenchange', onFullscreenChange);
document.addEventListener('visibilitychange', () => {
  if (document.hidden) return;
  initCDC();
  tickClock(); // the minute-aligned timer may have been throttled while hidden
  // repaint from the shared cache first (the dashboard writes the same key),
  // and only hit the network if that reading has aged out — same rule as boot
  if (Date.now() - loadCachedFees() >= BTC.fees.TTL_MS) fetchFees();
});

// ── CDC ACTION ZONE ───────────────────────────────────────
const cdcStrip = document.getElementById('cdc-strip');

async function fetchCDCBlocks() {
  // Tier 1: localStorage (fresh within 1 hour)
  try {
    const cached = JSON.parse(localStorage.getItem(CDC_STORAGE_KEY));
    if (cached && Date.now() - cached.ts < CDC_TTL_MS && cached.blocks.length === 30 && cached.blocks[0]?.diff != null) return cached.blocks;
  } catch {}

  // Tier 2: local data file (data/cdc.js sets window.LOCAL_CDC). This is the
  // only tier that ever actually runs — data/cdc.js is always bundled and
  // loaded, so it always satisfies the check below. There used to be a
  // Kraken REST fallback here, computing its own EMA; it never ran (this
  // tier always returns first) and has been removed along with its calcEMA().
  // A missing/malformed data file falls through to renderCDC()'s "CDC
  // unavailable" state (or keeps whatever was last rendered).
  if (window.LOCAL_CDC?.blocks?.length === 30 && window.LOCAL_CDC.blocks[0]?.diff != null) {
    try { localStorage.setItem(CDC_STORAGE_KEY, JSON.stringify({ ts: Date.now(), blocks: window.LOCAL_CDC.blocks })); } catch {}
    return window.LOCAL_CDC.blocks;
  }

  return null;
}

// bars grow from a shared midline (bull up, bear down) sized off the strip's
// *actual* rendered height rather than a fixed pixel baseline, so they stay
// proportional whatever height the container-query layout gives the strip
let lastCDCBlocks = null;
let lastCDCSignature = '';
// kept in sync by the ResizeObserver below; renderCDC() reads this instead of
// cdcStrip.clientHeight so it never forces a synchronous layout itself, and
// so it repaints on ANY height change (a container-query fold triggered by
// the fee bar growing a digit, a topbar reflow, un-hiding the strip) rather
// than only on a window resize, which a debounced 'resize' listener missed
let cdcHeight = 0;

function renderCDC(blocks) {
  if (blocks) lastCDCBlocks = blocks;
  if (!blocks && !lastCDCBlocks) {
    // keep previously rendered blocks; only show the error when there's nothing
    if (!cdcStrip.childElementCount) cdcStrip.innerHTML = '<span class="cdc-error">CDC unavailable</span>';
    return;
  }
  const useBlocks = blocks || lastCDCBlocks;
  // MAX_H is half the strip's height (the midline sits dead centre).
  // clientHeight is only the first-call fallback, before the observer below
  // has delivered its first measurement.
  const MAX_H = Math.max(2, (cdcHeight || cdcStrip.clientHeight) / 2);

  // The hourly initCDC() re-render (below) can never produce different output
  // while data/cdc.js is bundled — fetchCDCBlocks() tier 2 always returns the
  // same frozen window.LOCAL_CDC — and neither can a resize that lands on an
  // unchanged height. Skip the 30-slot (60-element) innerHTML rebuild when
  // nothing that affects the render actually changed; MAX_H must be part of
  // the signature or resizes would stop repainting.
  const signature = MAX_H + '|' + useBlocks.map(b => `${b.bull ? 1 : 0}${b.today ? 1 : 0}${b.diff}`).join(',');
  if (signature === lastCDCSignature) return;
  lastCDCSignature = signature;

  // BTC.cdc.scale (shared.js) normalises |EMA12-EMA26| into a 0.08-1 fraction
  // of the half-height — the same formula the dashboard's CSS-percent strip
  // uses, so the two can no longer disagree about what a bar height means
  cdcStrip.innerHTML = BTC.cdc.scale(useBlocks).map(b => {
    const h  = Math.round(b.frac * MAX_H);
    const mt = b.bull ? (MAX_H - h) : MAX_H;
    return `<div class="cdc-slot"><div class="cdc-block ${b.bull ? 'bull' : 'bear'}${b.today ? ' today' : ''}" style="height:${h}px;margin-top:${mt}px"></div></div>`;
  }).join('');
  const bullCount = useBlocks.filter(b => b.bull).length;
  cdcStrip.setAttribute('aria-label',
    `CDC Action Zone: ${bullCount} of ${useBlocks.length} days bullish`);
}

async function initCDC() {
  renderCDC(await fetchCDCBlocks());
}

// kept even though the bundled data/cdc.js never changes within a page's
// lifetime — it's the only path by which a data-file refresh or a future
// Kraken fallback could ever land, and the signature check above makes a
// same-data tick nearly free (one localStorage read + JSON.parse, hourly)
setInterval(initCDC, CDC_TTL_MS);

// #cdc-strip has no block padding, so contentRect.height === clientHeight.
// Fires once on observe() with the initial measurement, and again on any
// later height change — including ones a 'resize' listener can't see, like
// crossing a container-query boundary or un-hiding the strip from the menu.
// No feedback loop: the strip has an explicit clamp()'d height and its
// children can't exceed it, so writing the bars can't change the observed
// box, and the signature check above makes any spurious re-entry a no-op.
new ResizeObserver(entries => {
  const h = entries[0].contentRect.height;
  if (h === cdcHeight) return;
  cdcHeight = h;
  if (h > 0 && lastCDCBlocks) renderCDC(lastCDCBlocks);
}).observe(cdcStrip);

// ── MEMPOOL FEES ──────────────────────────────────────────
// Fee tiers, derivation and fetch/cache live in shared.js (BTC.fees) — the
// cache is a genuine cross-page contract with the dashboard (same key), so
// the two must never drift. This section just renders into the ticker's DOM.
// Fee tiers only really shift on a new block (~10min avg) or a mempool
// reshuffle, but a 60s cadence keeps the bar in step with the live price
// ticker next to it at negligible request cost.
const feeEls = {
  no:   document.getElementById('fee-no'),
  low:  document.getElementById('fee-low'),
  med:  document.getElementById('fee-med'),
  high: document.getElementById('fee-high'),
};

function renderFees(t) {
  if (!t) return;
  for (const [key, el] of Object.entries(feeEls)) {
    const v = t[key];
    if (v != null && !isNaN(v)) el.textContent = BTC.fees.fmtFeeRate(Number(v));
  }
}

// paint last-known tiers from the shared cache (the dashboard writes the same
// key), returning the cache timestamp so the caller can decide whether it's
// stale enough to warrant a network hit
function loadCachedFees() {
  const cached = BTC.fees.readCache();
  if (cached) renderFees(cached.tiers);
  return cached ? cached.ts : 0;
}

async function fetchFees() {
  try {
    const result = await BTC.fees.refresh();
    if (result) renderFees(result.tiers);
  } catch {}
}

// the interval always hits the network — the cache is only for the instant
// paint on load and for sharing the reading with the dashboard. Skipped while
// the tab/WebView is hidden; visibilitychange (below) catches up on resume.
setInterval(() => { if (!document.hidden) fetchFees(); }, BTC.fees.TTL_MS);

// ── CLOCK ─────────────────────────────────────────────────
// bottom-left wall clock, fixed to Bangkok time regardless of the kiosk's
// local timezone/locale settings; also drives the Night Mode schedule below
// since both need the same "what hour is it in Bangkok right now" answer
const clockEl = document.getElementById('clock');
const clockFmt = new Intl.DateTimeFormat('en-GB', {
  timeZone: 'Asia/Bangkok', hour: '2-digit', minute: '2-digit', hour12: false
});

function bangkokTimeParts() {
  const parts = clockFmt.formatToParts(new Date());
  const get = t => parts.find(p => p.type === t).value;
  return { hh: get('hour'), mm: get('minute') };
}

// 23:00–08:00 Bangkok time, wrapping past midnight
function isNightHour(h) {
  return h >= 23 || h < 8;
}

// hh optional so applyVisibility()'s parameterless call (Force Night Mode
// toggling) still works standalone without a second formatToParts call
function updateNightMode(hh = bangkokTimeParts().hh) {
  const active = STATE.visibility.nightForce ||
    (STATE.visibility.nightSchedule && isNightHour(parseInt(hh, 10)));
  document.body.classList.toggle('night-mode', active);
}

let lastClockText = '';
function tickClock() {
  const { hh, mm } = bangkokTimeParts();
  const text = `${hh}:${mm}`;
  if (text !== lastClockText) { lastClockText = text; clockEl.textContent = text; }
  updateNightMode(hh);
}

// The displayed value changes once a minute, so tick on the minute boundary
// instead of at 1Hz — the old setInterval(tickClock, 1000) meant tickClock
// and updateNightMode each called bangkokTimeParts() every second, ~172,800
// Intl.formatToParts calls/day for a value that changes 1,440x/day. Re-derived
// from Date.now() each time (not accumulated), so it self-corrects after any
// timer drift or a suspend rather than compounding it. Bangkok is UTC+7, a
// whole-hour offset, so its minute boundaries land on the same instants as
// UTC's — %60_000 against wall-clock ms is safe here.
function scheduleClock() {
  tickClock();
  setTimeout(scheduleClock, 60_000 - (Date.now() % 60_000) + 50);
}
scheduleClock();

// ── SCHEDULED RELOAD ──────────────────────────────────────
// this app is built to run unattended for weeks on kiosk hardware; a
// once-daily reload at a quiet local hour resets the JS heap and any
// browser-level fragmentation for free, regardless of how leak-free the app
// itself is. location.reload() naturally reschedules this on the next load.
const DAILY_RELOAD_HOUR = 4; // 4am local time

function scheduleReload() {
  const next = new Date();
  next.setHours(DAILY_RELOAD_HOUR, 0, 0, 0);
  if (next <= Date.now()) next.setDate(next.getDate() + 1);
  setTimeout(() => location.reload(), next - Date.now());
}

// ── INIT ──────────────────────────────────────────────────
updateActive();
applyVisibility();
connect(STATE.exchange);
initCDC();
scheduleReload();
// paint cached fees instantly; only fetch on load if the cache is stale/absent
if (Date.now() - loadCachedFees() >= BTC.fees.TTL_MS) fetchFees();
