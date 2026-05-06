const el    = document.getElementById("price");
const pulse = document.getElementById("ws-pulse");
const label = document.getElementById("ws-label");
const time  = document.getElementById("ws-time");

let latest = 0, latestChange = null, last = 0, lastUpdated = null, pending = false;
let retryMs = 1000;

// --- localStorage persistence ---
const STORAGE_KEY    = "btcticker_history";
const SNAPSHOT_MS    = 60_000;
const WINDOW_MS      = 24 * 60 * 60_000;

function loadHistory() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const cutoff = Date.now() - WINDOW_MS;
    return JSON.parse(raw).filter(e => e.ts >= cutoff);
  } catch { return []; }
}

function saveHistory(history) {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(history)); } catch {}
}

let history = loadHistory();

// snapshot price every minute, prune to 24hrs
setInterval(() => {
  if (!latest) return;
  const now    = Date.now();
  const cutoff = now - WINDOW_MS;
  history.push({ ts: now, price: latest, change: latestChange });
  history = history.filter(e => e.ts >= cutoff);
  saveHistory(history);
}, SNAPSHOT_MS);

// show last known price immediately on load
if (history.length) {
  const last_entry = history[history.length - 1];
  latest      = last_entry.price;
  latestChange = last_entry.change;
  el.innerHTML = fmt(latest, latestChange);
}

// --- display ---
function setStatus(state) {
  pulse.className = state;
  label.textContent = state === "live" ? "live"
    : state === "reconnecting" ? "reconnecting…" : "connecting…";
}

setInterval(() => {
  if (!lastUpdated) return;
  const secs = Math.floor((Date.now() - lastUpdated) / 1000);
  time.textContent = secs < 5 ? "just now" : secs + "s ago";
}, 1000);

function fmt(n, change) {
  const [int, dec] = n.toFixed(2).split(".");
  const intFmt = int.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  let chgHtml = "";
  if (change !== null && change !== undefined) {
    const sign = change >= 0 ? "+" : "";
    const cls  = change >= 0 ? "pos" : "neg";
    chgHtml = `<span class="chg ${cls}">${sign}${Math.round(change)}%</span>`;
  }
  return intFmt + `<span class="dec-wrap">${chgHtml}<span class="dec">.${dec}</span></span>`;
}

setInterval(() => {
  if (latest === last) return;
  last = latest;
  if (!pending) {
    pending = true;
    requestAnimationFrame(() => { el.innerHTML = fmt(last, latestChange); pending = false; });
  }
}, 500);

// --- Binance WebSocket ---
function connect() {
  const ws = new WebSocket("wss://stream.binance.com:9443/ws/btcusdt@ticker");

  ws.onopen  = () => { retryMs = 1000; setStatus("live"); };
  ws.onerror = () => ws.close();
  ws.onclose = () => {
    setStatus("reconnecting");
    setTimeout(connect, retryMs);
    retryMs = Math.min(retryMs * 2, 16_000);
  };

  ws.onmessage = (e) => {
    const d      = JSON.parse(e.data);
    latest       = parseFloat(d.c); // current price
    latestChange = parseFloat(d.P); // 24hr % change
    lastUpdated  = Date.now();

    // seed history on first message if empty
    if (!history.length) {
      history.push({ ts: Date.now(), price: latest, change: latestChange });
      saveHistory(history);
    }
  };
}

connect();
