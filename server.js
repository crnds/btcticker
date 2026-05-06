const { createServer } = require("http");
const { Server }       = require("socket.io");
const WebSocket        = require("ws");
const fs               = require("fs");
const path             = require("path");

const PORT              = 3000;
const BINANCE           = "wss://stream.binance.com:9443/ws/btcusdt@aggTrade";
const EMIT_INTERVAL     = 500;
const SNAPSHOT_INTERVAL = 60_000;          // snapshot price every 1 min
const WINDOW_MS         = 24 * 60 * 60_000; // keep 24 hrs of snapshots
const HISTORY_FILE      = path.join(__dirname, "data", "history.json");

const MIME = {
  ".html":  "text/html",
  ".css":   "text/css",
  ".js":    "application/javascript",
  ".woff2": "font/woff2",
  ".json":  "application/json",
};

const http = createServer((req, res) => {
  // serve static files from project root
  const urlPath  = req.url === "/" ? "/index.html" : req.url;
  const filePath = path.join(__dirname, urlPath);

  // prevent directory traversal outside project root
  if (!filePath.startsWith(__dirname)) {
    res.writeHead(403); res.end(); return;
  }

  fs.readFile(filePath, (err, data) => {
    if (err) { res.writeHead(404); res.end(); return; }
    const ext = path.extname(filePath);
    res.writeHead(200, { "Content-Type": MIME[ext] || "application/octet-stream" });
    res.end(data);
  });
});
const io   = new Server(http, { transports: ["websocket"], cors: { origin: "*" } });

let latestPrice = 0;
let lastEmitted = 0;
let retryMs     = 1000;
let history     = []; // [{ ts: Number, price: Number }]

// --- persistence ---
function loadHistory() {
  try {
    if (fs.existsSync(HISTORY_FILE)) {
      const raw    = JSON.parse(fs.readFileSync(HISTORY_FILE, "utf8"));
      const cutoff = Date.now() - WINDOW_MS;
      history      = raw.filter(e => e.ts >= cutoff);
      console.log(`history loaded: ${history.length} entries`);
    }
  } catch (e) { console.log("history load failed:", e.message); }
}

function saveHistory() {
  try {
    fs.mkdirSync(path.dirname(HISTORY_FILE), { recursive: true });
    fs.writeFileSync(HISTORY_FILE, JSON.stringify(history));
  } catch (e) { console.log("history save failed:", e.message); }
}

// --- 24hr change ---
function calc24hChange() {
  if (history.length < 1 || !latestPrice) return null;
  const base = history[0].price;
  return ((latestPrice - base) / base) * 100;
}

// snapshot every minute + prune old entries
setInterval(() => {
  if (!latestPrice) return;
  const now    = Date.now();
  const cutoff = now - WINDOW_MS;
  history.push({ ts: now, price: latestPrice });
  history = history.filter(e => e.ts >= cutoff);
  saveHistory();
}, SNAPSHOT_INTERVAL);

// throttled fanout to clients
setInterval(() => {
  if (latestPrice === lastEmitted || io.engine.clientsCount === 0) return;
  lastEmitted = latestPrice;
  io.volatile.emit("tick", { price: latestPrice, change: calc24hChange() });
}, EMIT_INTERVAL);

// --- Binance ---
function connectBinance() {
  const ws = new WebSocket(BINANCE);
  ws.on("message", (raw) => {
    latestPrice = parseFloat(JSON.parse(raw).p);
    // seed history with the first price so change is available immediately
    if (history.length === 0) {
      history.push({ ts: Date.now(), price: latestPrice });
      saveHistory();
    }
  });
  ws.on("open",    () => { retryMs = 1000; console.log("binance connected"); });
  ws.on("error",   () => ws.close());
  ws.on("close",   () => {
    console.log(`binance disconnected — retry in ${retryMs}ms`);
    setTimeout(connectBinance, retryMs);
    retryMs = Math.min(retryMs * 2, 16000);
  });
}

io.on("connection", (socket) => {
  console.log(`client + ${socket.id}  (total: ${io.engine.clientsCount})`);
  if (latestPrice) socket.emit("tick", { price: latestPrice, change: calc24hChange() });
  socket.on("disconnect", () =>
    console.log(`client - ${socket.id}  (total: ${io.engine.clientsCount})`)
  );
});

http.listen(PORT, () => {
  console.log(`server on :${PORT}`);
  loadHistory();
  connectBinance();
});
