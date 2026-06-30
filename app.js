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
    async init() {
      const ctrl = new AbortController();
      const tid  = setTimeout(() => ctrl.abort(), 8000);
      try {
        const r = await fetch('https://www.bitstamp.net/api/v2/ticker/btcusd/', { signal: ctrl.signal });
        const d = await r.json();
        const change = d.open
          ? ((parseFloat(d.last) - parseFloat(d.open)) / parseFloat(d.open)) * 100
          : null;
        return { change };
      } catch { return { change: null }; }
      finally { clearTimeout(tid); }
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
      const change = t.open24h
        ? ((parseFloat(t.last) - parseFloat(t.open24h)) / parseFloat(t.open24h)) * 100
        : null;
      return { price: parseFloat(t.last), change };
    }
  }
};

// ── STATE ─────────────────────────────────────────────────
const EXCHANGE_KEY    = 'btcticker_v1_exchange';
const STORAGE_KEY     = 'btcticker_v1_history';
const CDC_STORAGE_KEY = 'btcticker_v1_cdc';
const CDC_TTL_MS      = 60 * 60 * 1000;
const SNAPSHOT_MS     = 60_000;
const WINDOW_MS       = 24 * 60 * 60_000;

// one-time migration from the pre-v1 unversioned keys
try {
  for (const [oldKey, newKey] of [['btcticker_exchange', EXCHANGE_KEY],
                                  ['btcticker_history',  STORAGE_KEY]]) {
    const v = localStorage.getItem(oldKey);
    if (v !== null && localStorage.getItem(newKey) === null) localStorage.setItem(newKey, v);
    localStorage.removeItem(oldKey);
  }
} catch {}

const STATE = {
  exchange: localStorage.getItem(EXCHANGE_KEY) || 'binance',
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
const el        = document.getElementById('price');
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

setInterval(() => {
  // only snapshot prices confirmed live within the last interval — a dead
  // socket must not keep stamping the old price with fresh timestamps
  if (!STATE.latest || !STATE.lastUpdated || Date.now() - STATE.lastUpdated >= SNAPSHOT_MS) return;
  const now = Date.now();
  STATE.history.push({ ts: now, price: STATE.latest, change: STATE.latestChange });
  STATE.history = STATE.history.filter(e => e.ts >= now - WINDOW_MS);
  saveHistory(STATE.history);
}, SNAPSHOT_MS);

// ── DISPLAY ───────────────────────────────────────────────
function fmt(n, change) {
  const [int, dec] = n.toFixed(2).split('.');
  const intFmt = int.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  let chgHtml = '';
  if (change !== null && change !== undefined && !isNaN(change)) {
    const sign = change >= 0 ? '+' : '';
    const cls  = change >= 0 ? 'pos' : 'neg';
    chgHtml = `<span class="chg ${cls}">${sign}${Math.round(change)}%</span>`;
  }
  let fngHtml = '';
  if (STATE.fearGreed) {
    const { value, classification, updateTime } = STATE.fearGreed;
    const stale = fngStale(updateTime);
    const title = stale
      ? `Fear &amp; Greed: ${classification} — stale (last updated ${updateTime})`
      : `Fear &amp; Greed: ${classification}`;
    fngHtml = `<span class="fng${stale ? ' stale' : ''}" style="color:${fngColor(value)}" title="${title}">${value}</span>`;
  }
  return intFmt + `<span class="dec-wrap"><span class="ind">${fngHtml}${chgHtml}</span><span class="dec">.${dec}</span></span>`;
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

setInterval(() => {
  if (!STATE.lastUpdated) return;
  time.textContent = fmtAgo(Date.now() - STATE.lastUpdated);
}, 1000);

setInterval(() => {
  if (STATE.latest === STATE.last) return;
  STATE.last = STATE.latest;
  if (!STATE.pending) {
    STATE.pending = true;
    requestAnimationFrame(() => { el.innerHTML = fmt(STATE.last, STATE.latestChange); STATE.pending = false; });
  }
}, 500);

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
  if (STATE.latest) el.innerHTML = fmt(STATE.last || STATE.latest, STATE.latestChange);
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
  el.innerHTML = fmt(STATE.latest, STATE.latestChange);
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
setInterval(async () => {
  const exchange = EXCHANGES[STATE.exchange];
  if (!exchange.init || !STATE.ws || STATE.ws.readyState !== WebSocket.OPEN) return;
  const { change } = await exchange.init();
  if (change !== null && !isNaN(change)) STATE.latestChange = change;
}, 5 * 60_000);

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
  el.innerHTML = '';
  time.textContent = '';
  loadingEl.classList.add('active');
  updateActive();
  connect(key);
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
  const ctrl = new AbortController();
  const tid  = setTimeout(() => ctrl.abort(), 8000);
  try {
    const r = await fetch(
      'https://api.kraken.com/0/public/OHLC?pair=XBTUSD&interval=1440',
      { signal: ctrl.signal }
    );
    clearTimeout(tid);
    const json    = await r.json();
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
    clearTimeout(tid);
    return null;
  }
}

function renderCDC(blocks) {
  const strip = document.getElementById('cdc-strip');
  if (!blocks) {
    // keep previously rendered blocks; only show the error when there's nothing
    if (!strip.childElementCount) strip.innerHTML = '<span class="cdc-error">CDC unavailable</span>';
    return;
  }
  const diffs = blocks.map(b => b.diff);
  const minD  = Math.min(...diffs);
  const maxD  = Math.max(...diffs);
  const range = maxD - minD || 1;
  const MIN_H = 4, MAX_H = 52;
  strip.innerHTML = blocks.map(b => {
    const h  = Math.round(MIN_H + ((b.diff - minD) / range) * (MAX_H - MIN_H));
    const mt = b.bull ? (MAX_H - h) : MAX_H;
    return `<div class="cdc-slot"><div class="cdc-block ${b.bull ? 'bull' : 'bear'}${b.today ? ' today' : ''}" style="height:${h}px;margin-top:${mt}px"></div></div>`;
  }).join('');
  const bullCount = blocks.filter(b => b.bull).length;
  strip.setAttribute('aria-label',
    `CDC Action Zone: ${bullCount} of ${blocks.length} days bullish`);
}

async function initCDC() {
  renderCDC(await fetchCDCBlocks());
}

setInterval(initCDC, CDC_TTL_MS);

// ── MEMPOOL FEES ──────────────────────────────────────────
// mempool.space's recommended fee rates (sat/vB), mapped to the same four
// priority tiers their website shows. One request returns all four; fees move
// slowly so a 5-minute cadence is plenty. Cached in localStorage so the bar
// repaints instantly on load and survives a brief API hiccup.
//   No   → economyFee     Low  → hourFee
//   Med  → halfHourFee     High → fastestFee
const FEES_STORAGE_KEY = 'btcticker_v1_fees';
const FEES_TTL_MS      = 5 * 60_000;
const FEES_URL         = 'https://mempool.space/api/v1/fees/recommended';

function renderFees(f) {
  if (!f) return;
  const cells = {
    'fee-no':   f.economyFee,
    'fee-low':  f.hourFee,
    'fee-med':  f.halfHourFee,
    'fee-high': f.fastestFee
  };
  for (const [id, v] of Object.entries(cells)) {
    const e = document.getElementById(id);
    if (e && v != null && !isNaN(v)) e.innerHTML = `${Math.round(v)}<span class="unit">sat/vB</span>`;
  }
}

// paint last-known fees from the shared cache (the dashboard writes the same
// key), returning the cache timestamp so the caller can decide whether it's
// stale enough to warrant a network hit
function loadCachedFees() {
  try {
    const cached = JSON.parse(localStorage.getItem(FEES_STORAGE_KEY));
    if (cached && cached.fees) { renderFees(cached.fees); return cached.ts || 0; }
  } catch {}
  return 0;
}

async function fetchFees() {
  const ctrl = new AbortController();
  const tid  = setTimeout(() => ctrl.abort(), 8000);
  try {
    const r = await fetch(FEES_URL, { signal: ctrl.signal });
    const f = await r.json();
    if (f && !isNaN(f.fastestFee)) {
      renderFees(f);
      try { localStorage.setItem(FEES_STORAGE_KEY, JSON.stringify({ ts: Date.now(), fees: f })); } catch {}
    }
  } catch {} finally { clearTimeout(tid); }
}

// the interval always hits the network — the cache is only for the instant
// paint on load and for sharing the reading with the dashboard
setInterval(fetchFees, FEES_TTL_MS);

// ── INIT ──────────────────────────────────────────────────
updateActive();
connect(STATE.exchange);
initCDC();
// paint cached fees instantly; only fetch on load if the cache is stale/absent
if (Date.now() - loadCachedFees() >= FEES_TTL_MS) fetchFees();
