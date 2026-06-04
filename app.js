// --- Exchange configs ---
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
      try {
        const r = await fetch('https://www.bitstamp.net/api/v2/ticker/btcusd/');
        const d = await r.json();
        const change = d.open
          ? ((parseFloat(d.last) - parseFloat(d.open)) / parseFloat(d.open)) * 100
          : null;
        return { change };
      } catch { return { change: null }; }
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

const EXCHANGE_KEY = 'btcticker_exchange';
let currentExchange = localStorage.getItem(EXCHANGE_KEY) || 'binance';

// --- State ---
let latest = 0, latestChange = null, last = 0, lastUpdated = null, pending = false;
let retryMs = 1000;
let activeWs = null;

// --- DOM ---
const el        = document.getElementById('price');
const pulse     = document.getElementById('ws-pulse');
const label     = document.getElementById('ws-label');
const time      = document.getElementById('ws-time');
const menuBtn   = document.getElementById('menu-btn');
const menuList  = document.getElementById('menu-list');
const loadingEl = document.getElementById('loading');

// --- localStorage history ---
const STORAGE_KEY = 'btcticker_history';
const SNAPSHOT_MS = 60_000;
const WINDOW_MS   = 24 * 60 * 60_000;

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

let history = loadHistory();

setInterval(() => {
  if (!latest) return;
  const now = Date.now();
  history.push({ ts: now, price: latest, change: latestChange });
  history = history.filter(e => e.ts >= now - WINDOW_MS);
  saveHistory(history);
}, SNAPSHOT_MS);

// --- Display ---
function fmt(n, change) {
  const [int, dec] = n.toFixed(2).split('.');
  const intFmt = int.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  let chgHtml = '';
  if (change !== null && change !== undefined && !isNaN(change)) {
    const sign = change >= 0 ? '+' : '';
    const cls  = change >= 0 ? 'pos' : 'neg';
    chgHtml = `<span class="chg ${cls}">${sign}${Math.round(change)}%</span>`;
  }
  return intFmt + `<span class="dec-wrap">${chgHtml}<span class="dec">.${dec}</span></span>`;
}

function setStatus(state) {
  pulse.className = state;
  label.textContent = state === 'live' ? 'live'
    : state === 'reconnecting' ? 'reconnecting…' : 'connecting…';
}

setInterval(() => {
  if (!lastUpdated) return;
  const secs = Math.floor((Date.now() - lastUpdated) / 1000);
  time.textContent = secs < 5 ? 'just now' : secs + 's ago';
}, 1000);

setInterval(() => {
  if (latest === last) return;
  last = latest;
  if (!pending) {
    pending = true;
    requestAnimationFrame(() => { el.innerHTML = fmt(last, latestChange); pending = false; });
  }
}, 500);

// show last known price on load, or loading animation if no history
if (history.length) {
  const e = history[history.length - 1];
  latest = e.price; latestChange = e.change;
  el.innerHTML = fmt(latest, latestChange);
} else {
  loadingEl.classList.add('active');
}

// --- WebSocket ---
function connect(key) {
  if (activeWs) { activeWs.onclose = null; activeWs.onmessage = null; activeWs.close(); activeWs = null; }
  retryMs = 1000;
  setStatus('connecting');

  const exchange = EXCHANGES[key];
  const ws = new WebSocket(exchange.url);
  activeWs = ws;

  ws.onopen = async () => {
    retryMs = 1000;
    setStatus('live');
    if (exchange.subscribe) exchange.subscribe(ws);
    if (exchange.init) {
      const { change } = await exchange.init();
      if (change !== null && !isNaN(change)) latestChange = change;
    }
    initCDC();
  };

  ws.onerror = () => ws.close();

  ws.onclose = () => {
    if (activeWs !== ws) return; // stale socket from a previous exchange
    setStatus('reconnecting');
    setTimeout(() => connect(currentExchange), retryMs);
    retryMs = Math.min(retryMs * 2, 16_000);
  };

  ws.onmessage = (e) => {
    const result = exchange.parse(e.data);
    if (!result || !result.price) return;
    latest = result.price;
    if (result.change !== null && !isNaN(result.change)) latestChange = result.change;
    lastUpdated = Date.now();
    loadingEl.classList.remove('active');

    if (!history.length) {
      history.push({ ts: Date.now(), price: latest, change: latestChange });
      saveHistory(history);
    }
  };
}

// --- Menu ---
function updateActive() {
  menuList.querySelectorAll('li').forEach(li =>
    li.classList.toggle('active', li.dataset.exchange === currentExchange)
  );
}

function closeMenu() { menuList.classList.remove('open'); }
function openMenu()  { updateActive(); menuList.classList.add('open'); }

menuBtn.addEventListener('click', () => {
  menuList.classList.contains('open') ? closeMenu() : openMenu();
});

document.addEventListener('click', (e) => {
  if (!menuBtn.contains(e.target) && !menuList.contains(e.target)) closeMenu();
});

menuList.addEventListener('click', (e) => {
  const li = e.target.closest('li');
  if (!li) return;
  const key = li.dataset.exchange;
  closeMenu();
  if (key === currentExchange) return;
  currentExchange = key;
  localStorage.setItem(EXCHANGE_KEY, key);
  latest = 0; latestChange = null; last = 0; lastUpdated = null;
  el.innerHTML = '';
  loadingEl.classList.add('active');
  updateActive();
  connect(key);
});

// --- Fullscreen ---
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
});

document.addEventListener('fullscreenchange',       onFullscreenChange);
document.addEventListener('webkitfullscreenchange', onFullscreenChange);
document.addEventListener('visibilitychange', () => { if (!document.hidden) initCDC(); });

// ── CDC ACTION ZONE ───────────────────────────────────────
const CDC_STORAGE_KEY = 'btcticker_v1_cdc';
const CDC_TTL_MS      = 60 * 60 * 1000;

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
    localStorage.setItem(CDC_STORAGE_KEY, JSON.stringify({ ts: Date.now(), blocks: window.LOCAL_CDC.blocks }));
    return window.LOCAL_CDC.blocks;
  }

  // Tier 3: Binance API
  const ctrl = new AbortController();
  const tid  = setTimeout(() => ctrl.abort(), 8000);
  try {
    const r = await fetch(
      'https://api.binance.com/api/v3/klines?symbol=BTCUSDT&interval=1d&limit=100',
      { signal: ctrl.signal }
    );
    clearTimeout(tid);
    const raw    = await r.json();
    const closes = raw.map(k => parseFloat(k[4]));
    const ema12  = calcEMA(closes, 12);
    const ema26  = calcEMA(closes, 26);

    const blocks = [];
    for (let i = closes.length - 30; i < closes.length; i++) {
      blocks.push({ bull: ema12[i] > ema26[i], today: i === closes.length - 1, diff: Math.abs(ema12[i] - ema26[i]) });
    }
    localStorage.setItem(CDC_STORAGE_KEY, JSON.stringify({ ts: Date.now(), blocks }));
    return blocks;
  } catch {
    clearTimeout(tid);
    return null;
  }
}

function renderCDC(blocks) {
  const strip = document.getElementById('cdc-strip');
  if (!blocks) return;
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
}

async function initCDC() {
  renderCDC(await fetchCDCBlocks());
}

setInterval(initCDC, CDC_TTL_MS);

// --- Init ---
updateActive();
connect(currentExchange);
