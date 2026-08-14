// ── shared.js ─────────────────────────────────────────────
// Logic shared between index.html (the ticker) and db.html (the dashboard):
// fetch-with-timeout, localStorage keys, the F&G colour ramp + staleness
// check, mempool fee derivation, and the CDC bar-height maths. Each page
// still owns its own rendering — this only unifies the parts that must agree.
// btcticker_v2_fees in particular is a real cross-page contract: a drift in
// the key or the stored shape silently breaks the OTHER page's
// instant-paint-from-cache, with no error anywhere.
//
// Classic script on purpose, NOT an ES module: install.sh launches the kiosk
// at file://, where <script type="module"> is CORS-blocked and the page goes
// blank — a failure invisible in a plain `python3 -m http.server` dev loop.
// Load this before any other script on both pages, and never add
// defer/async/type="module" to it: db.html's own <script> is parser-blocking
// and runs the instant the parser reaches it, so a deferred shared.js would
// let that inline script run first and fail on "BTC is not defined".
(function (global) {
  'use strict';
  const BTC = global.BTC = global.BTC || {};

  // ── network ─────────────────────────────────────────────
  // callers still wrap this in try/catch — a timed-out or malformed response
  // should fail soft, not throw uncaught
  BTC.fetchJSON = async function fetchJSON(url, timeoutMs = 8000) {
    const ctrl = new AbortController();
    const tid  = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const r = await fetch(url, { signal: ctrl.signal });
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return await r.json();
    } finally {
      clearTimeout(tid);
    }
  };

  BTC.DAY_MS = 86_400_000;

  // ── storage keys ────────────────────────────────────────
  // frozen: both pages read these by reference rather than re-typing the
  // string, so a rename can't silently drift out of sync between them
  BTC.keys = Object.freeze({
    exchange:       'btcticker_v1_exchange',
    exchangeLegacy: 'btcticker_exchange',
    history:        'btcticker_v1_history',
    historyLegacy:  'btcticker_history',
    cdc:            'btcticker_v1_cdc',
    fng:            'btcticker_v1_fng',
    visibility:     'btcticker_v1_visibility',
    fees:           'btcticker_v2_fees',
  });

  // ── price history (24h rolling snapshots) ───────────────
  // the ticker is the sole writer and owns pruning + the pre-v1 key
  // migration; the dashboard is read-only and keeps the legacy-key fallback
  // since it can't assume the ticker has ever run on this machine
  const history = BTC.history = {};
  history.WINDOW_MS = 24 * BTC.DAY_MS;

  history.load = function load() {
    try {
      const raw = localStorage.getItem(BTC.keys.history) || localStorage.getItem(BTC.keys.historyLegacy);
      if (!raw) return [];
      const cutoff = Date.now() - history.WINDOW_MS;
      const parsed = JSON.parse(raw);
      if (!Array.isArray(parsed)) return [];
      // price validated as well as ts: a corrupt/partial entry must not throw
      // out from under a caller rendering it at module top level
      return parsed.filter(e => e && Number.isFinite(e.ts) && Number.isFinite(e.price) && e.ts >= cutoff);
    } catch { return []; }
  };

  history.save = function save(h) {
    try { localStorage.setItem(BTC.keys.history, JSON.stringify(h)); } catch {}
  };

  // ── Fear & Greed ─────────────────────────────────────────
  const fng = BTC.fng = {};
  // quintile bands matching the dashboard's gauge arc: fear -> greed
  fng.COLORS = Object.freeze(['#ff1744', '#ff6d00', '#ffeb3b', '#69f0ae', '#00e676']);
  // clamp both ends: a corrupt reading (negative, >100, non-numeric) would
  // otherwise index outside the table and hand `undefined` to a style setter
  fng.colorFor = function colorFor(v) {
    const n = Number(v);
    if (!Number.isFinite(n)) return fng.COLORS[2];
    return fng.COLORS[Math.min(Math.max(Math.floor(n / 20), 0), 4)];
  };
  // CMC refreshes every 6h; a reading older than this means the refresh
  // pipeline is broken (e.g. the CMC_API_KEY secret expired) and both pages
  // are serving a stale number
  fng.STALE_HOURS = 48;
  fng.STALE_MS = fng.STALE_HOURS * 60 * 60 * 1000;
  fng.isStale = function isStale(stamp) {
    const t = Date.parse(stamp);
    return !isNaN(t) && (Date.now() - t) > fng.STALE_MS;
  };

  // ── mempool fees ─────────────────────────────────────────
  // Fee rates (sat/vB) for four priority tiers, derived from mempool.space's
  // projected blocks. Each projected block holds ~10 min of pending
  // transactions; taking the median fee at the depth matching each tier gives
  // genuinely fractional numbers rather than the whole-sat/vB values the
  // /fees/recommended endpoint rounds to.
  //   High -> next block (~10m)        Med -> ~30m (3rd projected block)
  //   Low  -> ~1h (6th projected block) No  -> cheapest projected block
  const fees = BTC.fees = {};
  fees.URL         = 'https://mempool.space/api/v1/fees/mempool-blocks';
  fees.TTL_MS      = 60_000;
  fees.STORAGE_KEY = BTC.keys.fees;

  // projected blocks -> { no, low, med, high } median fee rates; indices are
  // clamped so a near-empty mempool (one projected block) collapses gracefully
  fees.deriveTiers = function deriveTiers(blocks) {
    if (!Array.isArray(blocks) || !blocks.length) return null;
    const n   = blocks.length;
    const med = i => blocks[Math.min(i, n - 1)].medianFee;
    return { high: med(0), med: med(2), low: med(5), no: med(n - 1) };
  };

  // display-only rounding: values >= 1 sat/vB round to a whole number, values
  // below 1 round to 1 decimal. The stored/fetched values themselves always
  // stay fractional-precise.
  fees.fmtFeeRate = function fmtFeeRate(v) {
    return v >= 1 ? String(Math.round(v)) : v.toFixed(1);
  };

  // last-known tiers from the shared cache (both pages write the same key) —
  // { tiers, ts } so the caller can decide whether it's stale enough to
  // warrant a network hit, or null if nothing is cached yet
  fees.readCache = function readCache() {
    try {
      const cached = JSON.parse(localStorage.getItem(fees.STORAGE_KEY));
      if (cached && cached.tiers) return { tiers: cached.tiers, ts: cached.ts || 0 };
    } catch {}
    return null;
  };

  // last-written tiers JSON, so we only touch localStorage when the reading
  // actually changed — fee tiers move on block timescales (~10 min), not every
  // minute, and on flash-backed kiosk storage every avoided write counts
  let lastFeesTiersJson = '';

  // fetch + derive + cache-write; returns { tiers, ts }, or null when
  // mempool.space reports no projected blocks (not an error). Throws on
  // network failure so each page keeps its own error UX — the ticker
  // swallows it silently, the dashboard shows "offline".
  fees.refresh = async function refresh() {
    const tiers = fees.deriveTiers(await BTC.fetchJSON(fees.URL));
    if (!tiers) return null;
    const ts = Date.now();
    const tiersJson = JSON.stringify(tiers);
    if (tiersJson !== lastFeesTiersJson) {
      lastFeesTiersJson = tiersJson;
      try { localStorage.setItem(fees.STORAGE_KEY, JSON.stringify({ ts, tiers })); } catch {}
    }
    return { tiers, ts };
  };

  // ── CDC bar scaling ──────────────────────────────────────
  // Shares the maths only — each page keeps its own markup and layout
  // mechanism (the ticker bakes pixel heights, the dashboard uses CSS
  // percentages). Both were independently computing the same normalisation
  // over |EMA12-EMA26| with an 8% floor; this is that formula, once, so the
  // two renderers can no longer disagree about what a bar height means.
  const cdc = BTC.cdc = {};
  cdc.MIN_FRAC = 0.08;
  cdc.scale = function scale(blocks) {
    const diffs = blocks.map(b => b.diff);
    const minD  = Math.min(...diffs);
    const maxD  = Math.max(...diffs);
    const range = maxD - minD || 1;
    return blocks.map(b => ({
      ...b,
      frac: cdc.MIN_FRAC + ((b.diff - minD) / range) * (1 - cdc.MIN_FRAC),
    }));
  };
})(window);
