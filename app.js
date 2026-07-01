// ── NETWORK ───────────────────────────────────────────────
// shared fetch-with-timeout for the exchange/CDC/fees REST calls; callers
// still wrap it in try/catch since a timed-out or malformed response should
// fail soft, not throw uncaught
async function fetchJSON(url, timeoutMs = 8000) {
  const ctrl = new AbortController();
  const tid  = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const r = await fetch(url, { signal: ctrl.signal });
    return await r.json();
  } finally {
    clearTimeout(tid);
  }
}

// ── EXCHANGE CONFIGS ──────────────────────────────────────
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
const EXCHANGE_KEY    = 'btcticker_v1_exchange';
const STORAGE_KEY     = 'btcticker_v1_history';
const CDC_STORAGE_KEY = 'btcticker_v1_cdc';
const VISIBILITY_KEY  = 'btcticker_v1_visibility';
const CDC_TTL_MS      = 60 * 60 * 1000;
// 5 min: cuts localStorage writes 5x versus a 1 min cadence — kinder to the
// flash storage on a 24/7 kiosk box, and 5 min resolution is still plenty
// dense for a 24h history window
const SNAPSHOT_MS     = 5 * 60_000;
const WINDOW_MS       = 24 * 60 * 60_000;
const AGE_TICK_MS     = 1000;
// 1s: still reads as "live" on a glance at a wall-mounted display, but halves
// the paint work of a 2/s cadence — #price is close to the largest painted
// area on screen, which matters on low-power kiosk hardware
const PRICE_TICK_MS   = 1000;
const REST_CHANGE_TTL_MS = 5 * 60_000;

// one-time migration from the pre-v1 unversioned keys
try {
  for (const [oldKey, newKey] of [['btcticker_exchange', EXCHANGE_KEY],
                                  ['btcticker_history',  STORAGE_KEY]]) {
    const v = localStorage.getItem(oldKey);
    if (v !== null && localStorage.getItem(newKey) === null) localStorage.setItem(newKey, v);
    localStorage.removeItem(oldKey);
  }
} catch {}

// per-metric show/hide, exposed via the settings menu; everything is visible
// by default, and a missing/malformed stored value falls back rather than erroring
const VISIBILITY_DEFAULTS = { fees: true, fng: true, change: true, cdc: true };

function loadVisibility() {
  try {
    return { ...VISIBILITY_DEFAULTS, ...JSON.parse(localStorage.getItem(VISIBILITY_KEY)) };
  } catch { return { ...VISIBILITY_DEFAULTS }; }
}

function saveVisibility(v) {
  try { localStorage.setItem(VISIBILITY_KEY, JSON.stringify(v)); } catch {}
}

const STATE = {
  exchange: localStorage.getItem(EXCHANGE_KEY) || 'binance',
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
const pulse     = document.getElementById('ws-pulse');
const label     = document.getElementById('ws-label');
const time      = document.getElementById('ws-time');
const menuBtn   = document.getElementById('menu-btn');
const menuList  = document.getElementById('menu-list');
const loadingEl = document.getElementById('loading');

// ── LOCALSTORAGE HISTORY ──────────────────────────────────
function loadHistory() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const cutoff = Date.now() - WINDOW_MS;
    return JSON.parse(raw).filter(e => e.ts >= cutoff);
  } catch { return []; }
}

function saveHistory(h) {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(h)); } catch {}
}

STATE.history = loadHistory();

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
  STATE.history = STATE.history.filter(e => e.ts >= now - WINDOW_MS);
  saveHistory(STATE.history);
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
    const stale = fngStale(updateTime);
    const title = stale
      ? `Fear & Greed: ${classification} — stale (last updated ${updateTime})`
      : `Fear & Greed: ${classification}`;
    const valueStr = String(value);
    if (priceFngEl.textContent !== valueStr) priceFngEl.textContent = valueStr;
    priceFngEl.classList.toggle('stale', stale);
    const color = fngColor(value);
    if (priceFngEl.style.color !== color) priceFngEl.style.color = color;
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

function fmtAgo(ms) {
  const secs = Math.floor(ms / 1000);
  if (secs < 5)     return 'just now';
  if (secs < 60)    return secs + 's ago';
  if (secs < 3600)  return Math.floor(secs / 60) + 'm ago';
  return Math.floor(secs / 3600) + 'h ago';
}

function tickAge() {
  if (!STATE.lastUpdated) return;
  time.textContent = fmtAgo(Date.now() - STATE.lastUpdated);
}
setInterval(tickAge, AGE_TICK_MS);

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
const FNG_STORAGE_KEY = 'btcticker_v1_fng';
const FNG_TTL_MS      = 60 * 60 * 1000;               // re-read the data file hourly
// CMC refreshes every 6h; a reading older than this means the refresh pipeline
// is broken (e.g. the CMC_API_KEY secret expired) and we're serving a stale number.
const FNG_STALE_MS    = 2 * 24 * 60 * 60 * 1000;      // 48h
// quintile bands matching the widget's arc: fear → greed
const FNG_COLORS = ['#ff1744', '#ff6d00', '#ffeb3b', '#69f0ae', '#00e676'];
function fngColor(v) { return FNG_COLORS[Math.min(Math.floor(v / 20), 4)]; }
// true once the reading is older than FNG_STALE_MS (unparseable time → not stale)
function fngStale(updateTime) {
  const t = Date.parse(updateTime);
  return !isNaN(t) && (Date.now() - t) > FNG_STALE_MS;
}

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

// show last known price on load, or loading animation if no history
if (STATE.history.length) {
  const e = STATE.history[STATE.history.length - 1];
  STATE.latest = e.price;
  STATE.latestChange = e.change;
  STATE.lastUpdated = e.ts; // show the real age of the cached price, not "current"
  renderPriceDOM(STATE.latest, STATE.latestChange);
  time.textContent = fmtAgo(Date.now() - STATE.lastUpdated);
} else {
  loadingEl.classList.add('active');
}

// ── WEBSOCKET ─────────────────────────────────────────────
function connect(key) {
  if (STATE.ws) { STATE.ws.onclose = null; STATE.ws.onmessage = null; STATE.ws.close(); STATE.ws = null; }
  clearTimeout(STATE.reconnectTimer);
  setStatus('connecting');

  const exchange = EXCHANGES[key];
  const ws = new WebSocket(exchange.url);
  STATE.ws = ws;

  ws.onopen = async () => {
    STATE.retryMs = 1000;
    setStatus('live');
    if (exchange.subscribe) exchange.subscribe(ws);
    if (exchange.init) {
      const { change } = await exchange.init();
      if (change !== null && !isNaN(change)) STATE.latestChange = change;
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
    const result = exchange.parse(e.data);
    if (!result || !result.price) return;
    STATE.latest = result.price;
    if (result.change !== null && !isNaN(result.change)) STATE.latestChange = result.change;
    STATE.lastUpdated = Date.now();
    loadingEl.classList.remove('active');

    if (!STATE.history.length) {
      STATE.history.push({ ts: Date.now(), price: STATE.latest, change: STATE.latestChange });
      saveHistory(STATE.history);
    }
  };
}

// Bitstamp's % change comes from a one-off REST call, not the trade stream —
// refresh it periodically so it doesn't go stale on a long-running kiosk
async function refreshRestChange() {
  const exchange = EXCHANGES[STATE.exchange];
  if (!exchange.init || !STATE.ws || STATE.ws.readyState !== WebSocket.OPEN) return;
  const { change } = await exchange.init();
  if (change !== null && !isNaN(change)) STATE.latestChange = change;
}
setInterval(refreshRestChange, REST_CHANGE_TTL_MS);

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

function openMenu() {
  updateActive();
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
  try { localStorage.setItem(EXCHANGE_KEY, key); } catch {}
  STATE.latest = 0; STATE.latestChange = null; STATE.last = 0; STATE.lastUpdated = null;
  clearPriceDOM();
  time.textContent = '';
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
document.addEventListener('visibilitychange', () => { if (!document.hidden) initCDC(); });

// ── CDC ACTION ZONE ───────────────────────────────────────
const cdcStrip = document.getElementById('cdc-strip');

function calcEMA(closes, period) {
  const k   = 2 / (period + 1);
  const out = new Array(closes.length).fill(null);
  let seed  = 0;
  for (let i = 0; i < period; i++) seed += closes[i];
  out[period - 1] = seed / period;
  for (let i = period; i < closes.length; i++) {
    out[i] = closes[i] * k + out[i - 1] * (1 - k);
  }
  return out;
}

async function fetchCDCBlocks() {
  // Tier 1: localStorage (fresh within 1 hour)
  try {
    const cached = JSON.parse(localStorage.getItem(CDC_STORAGE_KEY));
    if (cached && Date.now() - cached.ts < CDC_TTL_MS && cached.blocks.length === 30 && cached.blocks[0]?.diff != null) return cached.blocks;
  } catch {}

  // Tier 2: local data file (data/cdc.js sets window.LOCAL_CDC)
  if (window.LOCAL_CDC?.blocks?.length === 30 && window.LOCAL_CDC.blocks[0]?.diff != null) {
    try { localStorage.setItem(CDC_STORAGE_KEY, JSON.stringify({ ts: Date.now(), blocks: window.LOCAL_CDC.blocks })); } catch {}
    return window.LOCAL_CDC.blocks;
  }

  // Tier 3: Kraken REST API (interval=1440 = 1 day)
  try {
    const json    = await fetchJSON('https://api.kraken.com/0/public/OHLC?pair=XBTUSD&interval=1440');
    const result  = json.result;
    const pairKey = Object.keys(result).find(k => k !== 'last');
    const closes  = result[pairKey].slice(-100).map(c => parseFloat(c[4]));
    if (closes.length < 30 + 26) return null; // need 30 blocks + EMA26 warmup
    const ema12   = calcEMA(closes, 12);
    const ema26   = calcEMA(closes, 26);

    const blocks = [];
    for (let i = closes.length - 30; i < closes.length; i++) {
      blocks.push({ bull: ema12[i] > ema26[i], today: i === closes.length - 1, diff: Math.abs(ema12[i] - ema26[i]) });
    }
    try { localStorage.setItem(CDC_STORAGE_KEY, JSON.stringify({ ts: Date.now(), blocks })); } catch {}
    return blocks;
  } catch {
    return null;
  }
}

function renderCDC(blocks) {
  if (!blocks) {
    // keep previously rendered blocks; only show the error when there's nothing
    if (!cdcStrip.childElementCount) cdcStrip.innerHTML = '<span class="cdc-error">CDC unavailable</span>';
    return;
  }
  const diffs = blocks.map(b => b.diff);
  const minD  = Math.min(...diffs);
  const maxD  = Math.max(...diffs);
  const range = maxD - minD || 1;
  const MIN_H = 4, MAX_H = 52;
  cdcStrip.innerHTML = blocks.map(b => {
    const h  = Math.round(MIN_H + ((b.diff - minD) / range) * (MAX_H - MIN_H));
    const mt = b.bull ? (MAX_H - h) : MAX_H;
    return `<div class="cdc-slot"><div class="cdc-block ${b.bull ? 'bull' : 'bear'}${b.today ? ' today' : ''}" style="height:${h}px;margin-top:${mt}px"></div></div>`;
  }).join('');
  const bullCount = blocks.filter(b => b.bull).length;
  cdcStrip.setAttribute('aria-label',
    `CDC Action Zone: ${bullCount} of ${blocks.length} days bullish`);
}

async function initCDC() {
  renderCDC(await fetchCDCBlocks());
}

setInterval(initCDC, CDC_TTL_MS);

// ── MEMPOOL FEES ──────────────────────────────────────────
// Fee rates (sat/vB) for four priority tiers, derived from mempool.space's
// projected blocks (/fees/mempool-blocks). Each projected block holds ~10 min
// of pending transactions; we take the median fee at the depth matching each
// tier, so the numbers are genuinely fractional rather than the whole-sat/vB
// values the /fees/recommended endpoint rounds to.
//   High → next block (~10m)        Med → ~30m (3rd projected block)
//   Low  → ~1h (6th projected block) No  → cheapest projected block (economy)
// Fee tiers only really shift on a new block (~10min avg) or a mempool
// reshuffle, but a 60s cadence keeps the bar in step with the live price
// ticker next to it at negligible request cost. Cached in localStorage so
// the bar repaints instantly on load; the cache is shared with the dashboard.
const FEES_STORAGE_KEY = 'btcticker_v2_fees';
const FEES_TTL_MS      = 60_000;
const FEES_URL         = 'https://mempool.space/api/v1/fees/mempool-blocks';

const feeEls = {
  no:   document.getElementById('fee-no'),
  low:  document.getElementById('fee-low'),
  med:  document.getElementById('fee-med'),
  high: document.getElementById('fee-high'),
};

// projected blocks → { no, low, med, high } median fee rates; indices are
// clamped so a near-empty mempool (one projected block) collapses gracefully
function deriveTiers(blocks) {
  if (!Array.isArray(blocks) || !blocks.length) return null;
  const n   = blocks.length;
  const med = i => blocks[Math.min(i, n - 1)].medianFee;
  return { high: med(0), med: med(2), low: med(5), no: med(n - 1) };
}

// display-only rounding: values >= 1 sat/vB round to a whole number, values
// below 1 round to 1 decimal. The stored/fetched values themselves always
// stay fractional-precise (see deriveTiers).
function fmtFeeRate(v) {
  return v >= 1 ? String(Math.round(v)) : v.toFixed(1);
}

function renderFees(t) {
  if (!t) return;
  for (const [key, el] of Object.entries(feeEls)) {
    const v = t[key];
    if (v != null && !isNaN(v)) el.textContent = fmtFeeRate(Number(v));
  }
}

// paint last-known tiers from the shared cache (the dashboard writes the same
// key), returning the cache timestamp so the caller can decide whether it's
// stale enough to warrant a network hit
function loadCachedFees() {
  try {
    const cached = JSON.parse(localStorage.getItem(FEES_STORAGE_KEY));
    if (cached && cached.tiers) { renderFees(cached.tiers); return cached.ts || 0; }
  } catch {}
  return 0;
}

async function fetchFees() {
  try {
    const tiers = deriveTiers(await fetchJSON(FEES_URL));
    if (tiers) {
      renderFees(tiers);
      try { localStorage.setItem(FEES_STORAGE_KEY, JSON.stringify({ ts: Date.now(), tiers })); } catch {}
    }
  } catch {}
}

// the interval always hits the network — the cache is only for the instant
// paint on load and for sharing the reading with the dashboard
setInterval(fetchFees, FEES_TTL_MS);

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
if (Date.now() - loadCachedFees() >= FEES_TTL_MS) fetchFees();
