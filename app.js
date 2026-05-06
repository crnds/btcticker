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
const el       = document.getElementById('price');
const pulse    = document.getElementById('ws-pulse');
const label    = document.getElementById('ws-label');
const time     = document.getElementById('ws-time');
const menuBtn  = document.getElementById('menu-btn');
const menuList = document.getElementById('menu-list');

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

// show last known price on load before WS connects
if (history.length) {
  const e = history[history.length - 1];
  latest = e.price; latestChange = e.change;
  el.innerHTML = fmt(latest, latestChange);
}

// --- WebSocket ---
function connect(key) {
  if (activeWs) { activeWs.onclose = null; activeWs.close(); activeWs = null; }
  retryMs = 1000;
  setStatus('connecting');

  const exchange = EXCHANGES[key];
  const ws = new WebSocket(exchange.url);
  activeWs = ws;

  ws.onopen = () => {
    retryMs = 1000;
    setStatus('live');
    if (exchange.subscribe) exchange.subscribe(ws);
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

menuBtn.addEventListener('click', (e) => {
  e.stopPropagation();
  menuList.classList.toggle('open');
  updateActive();
});

document.addEventListener('click', () => menuList.classList.remove('open'));

menuList.addEventListener('click', (e) => {
  const li = e.target.closest('li');
  if (!li) return;
  const key = li.dataset.exchange;
  menuList.classList.remove('open');
  if (key === currentExchange) return;
  currentExchange = key;
  localStorage.setItem(EXCHANGE_KEY, key);
  latest = 0; latestChange = null; last = 0; lastUpdated = null;
  el.innerHTML = '';
  updateActive();
  connect(key);
});

// --- Init ---
updateActive();
connect(currentExchange);
