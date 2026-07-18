#!/usr/bin/env node
// Background runner for pine/ml-adaptive-supertrend-algoalpha.pine (K-Means Adaptive SuperTrend).
// Read-only: pulls public OHLC candles and recomputes the indicator in JS. No orders, no exchange
// keys, nothing written except a status file. Independent of whatever chart TradingView Desktop
// currently has open — safe to run continuously alongside it.
//
// Usage:
//   node scripts/supertrend-monitor.js             # loop forever, one pass per bar-aligned interval
//   node scripts/supertrend-monitor.js --once       # single pass, print + write status, exit
//   node scripts/supertrend-monitor.js --interval=60 # poll every 60s instead of the default 300s

import { readFileSync, writeFileSync } from "fs";

const args = process.argv.slice(2);
const ONCE = args.includes("--once");
const intervalArg = args.find((a) => a.startsWith("--interval="));
const POLL_SECONDS = intervalArg ? parseInt(intervalArg.split("=")[1], 10) : 300;

const RULES_PATH = new URL("../rules.json", import.meta.url);
const STATUS_PATH = new URL("../supertrend-status.json", import.meta.url);

// ── Indicator settings (mirrors pine/ml-adaptive-supertrend-algoalpha.pine defaults) ──
const ATR_LEN = 10;
const FACTOR = 3;
const TRAINING_PERIOD = 100;
const HIGHVOL_GUESS = 0.75;
const MIDVOL_GUESS = 0.5;
const LOWVOL_GUESS = 0.25;
const KMEANS_MAX_ITER = 200;
const KMEANS_EPS = 1e-9;

const TF_TO_STEP = { 1: 60, 5: 300, 15: 900, 30: 1800, 60: 3600, 120: 7200, 240: 14400, 360: 21600, 720: 43200, D: 86400 };

function loadRules() {
  const rules = JSON.parse(readFileSync(RULES_PATH, "utf8"));
  const step = TF_TO_STEP[rules.default_timeframe] || 14400;
  if (!TF_TO_STEP[rules.default_timeframe]) {
    console.warn(`  ⚠ Unrecognized default_timeframe "${rules.default_timeframe}" — defaulting to 4H (14400s)`);
  }
  return { watchlist: rules.watchlist, step };
}

// ── Bitstamp public OHLC (no auth) ──────────────────────────────────────────
async function fetchCandles(symbol, step, limit = 250) {
  const pair = symbol.toLowerCase();
  const res = await fetch(`https://www.bitstamp.net/api/v2/ohlc/${pair}/?step=${step}&limit=${limit}`);
  const json = await res.json();
  if (!json.data?.ohlc) throw new Error(json.reason || `no data for ${symbol}`);
  return json.data.ohlc
    .map((c) => ({
      t: parseInt(c.timestamp),
      o: parseFloat(c.open),
      h: parseFloat(c.high),
      l: parseFloat(c.low),
      c: parseFloat(c.close),
    }))
    .sort((a, b) => a.t - b.t);
}

// ── True Range / ATR (Wilder's RMA, matches Pine ta.atr) ───────────────────
function calcATRSeries(candles, length) {
  const tr = candles.map((c, i) => {
    if (i === 0) return c.h - c.l;
    const prevClose = candles[i - 1].c;
    return Math.max(c.h - c.l, Math.abs(c.h - prevClose), Math.abs(c.l - prevClose));
  });
  const atr = new Array(candles.length).fill(NaN);
  if (candles.length < length) return atr;
  let seed = 0;
  for (let i = 0; i < length; i++) seed += tr[i];
  atr[length - 1] = seed / length;
  for (let i = length; i < candles.length; i++) {
    atr[i] = (atr[i - 1] * (length - 1) + tr[i]) / length;
  }
  return atr;
}

function highestLowest(values, endIdx, period) {
  let hi = -Infinity, lo = Infinity;
  for (let i = endIdx - period + 1; i <= endIdx; i++) {
    if (Number.isNaN(values[i])) continue;
    if (values[i] > hi) hi = values[i];
    if (values[i] < lo) lo = values[i];
  }
  return { hi, lo };
}

// ── K-Means volatility clustering — mirrors the Pine while-loop exactly ────
function kmeansCluster(atrWindow, lower, upper) {
  let amean = [lower + (upper - lower) * HIGHVOL_GUESS];
  let bmean = [lower + (upper - lower) * MIDVOL_GUESS];
  let cmean = [lower + (upper - lower) * LOWVOL_GUESS];

  const changed = (arr) => arr.length === 1 || Math.abs(arr[0] - arr[1]) > KMEANS_EPS;

  let iterations = 0;
  let sizeA = 0, sizeB = 0, sizeC = 0;
  while ((changed(amean) || changed(bmean) || changed(cmean)) && iterations < KMEANS_MAX_ITER) {
    const hv = [], mv = [], lv = [];
    for (const v of atrWindow) {
      const d1 = Math.abs(v - amean[0]);
      const d2 = Math.abs(v - bmean[0]);
      const d3 = Math.abs(v - cmean[0]);
      if (d1 < d2 && d1 < d3) hv.push(v);
      else if (d2 < d1 && d2 < d3) mv.push(v);
      else if (d3 < d1 && d3 < d2) lv.push(v);
    }
    const avg = (arr, fallback) => (arr.length ? arr.reduce((s, x) => s + x, 0) / arr.length : fallback);
    amean = [avg(hv, amean[0]), amean[0]];
    bmean = [avg(mv, bmean[0]), bmean[0]];
    cmean = [avg(lv, cmean[0]), cmean[0]];
    sizeA = hv.length;
    sizeB = mv.length;
    sizeC = lv.length;
    iterations++;
  }

  return {
    centroids: [amean[0], bmean[0], cmean[0]], // [high, medium, low]
    sizes: [sizeA, sizeB, sizeC],
    iterations,
  };
}

// ── Adaptive SuperTrend — recursive band logic, mirrors pine_supertrend() ──
function computeAdaptiveSuperTrend(candles, atr) {
  const n = candles.length;
  const dir = new Array(n).fill(NaN);
  const st = new Array(n).fill(NaN);
  const cluster = new Array(n).fill(NaN); // 0=high, 1=medium, 2=low
  let prevUpperBand = NaN, prevLowerBand = NaN, prevST = NaN, prevDir = NaN;

  const warmup = ATR_LEN + TRAINING_PERIOD; // need this many bars before clustering is meaningful

  for (let i = 0; i < n; i++) {
    if (i < warmup || Number.isNaN(atr[i])) continue;

    const { hi: upper, lo: lower } = highestLowest(atr, i, TRAINING_PERIOD);
    const atrWindow = [];
    for (let k = i - TRAINING_PERIOD + 1; k <= i; k++) atrWindow.push(atr[k]);

    const { centroids, sizes } = kmeansCluster(atrWindow, lower, upper);
    const distances = centroids.map((c) => Math.abs(atr[i] - c));
    const clusterIdx = distances.indexOf(Math.min(...distances));
    const assignedATR = centroids[clusterIdx];
    cluster[i] = clusterIdx;

    const src = (candles[i].h + candles[i].l) / 2;
    let upperBand = src + FACTOR * assignedATR;
    let lowerBand = src - FACTOR * assignedATR;
    const prevClose = i > 0 ? candles[i - 1].c : candles[i].c;

    if (!Number.isNaN(prevLowerBand)) {
      lowerBand = lowerBand > prevLowerBand || prevClose < prevLowerBand ? lowerBand : prevLowerBand;
    }
    if (!Number.isNaN(prevUpperBand)) {
      upperBand = upperBand < prevUpperBand || prevClose > prevUpperBand ? upperBand : prevUpperBand;
    }

    let direction;
    if (Number.isNaN(prevST)) {
      direction = 1;
    } else if (prevST === prevUpperBand) {
      direction = candles[i].c > upperBand ? -1 : 1;
    } else {
      direction = candles[i].c < lowerBand ? 1 : -1;
    }

    const superTrend = direction === -1 ? lowerBand : upperBand;

    dir[i] = direction;
    st[i] = superTrend;
    prevUpperBand = upperBand;
    prevLowerBand = lowerBand;
    prevST = superTrend;
    prevDir = direction;
  }

  return { dir, st, cluster };
}

const VOL_LABEL = ["HIGH", "MEDIUM", "LOW"];

async function scanSymbol(symbol, step) {
  const candles = await fetchCandles(symbol, step);
  const atr = calcATRSeries(candles, ATR_LEN);
  const { dir, st, cluster } = computeAdaptiveSuperTrend(candles, atr);

  const last = candles.length - 1;
  if (Number.isNaN(dir[last])) {
    return { symbol, error: "insufficient history for warmup (need more candles)" };
  }

  // Find the most recent flip (last bar where direction differs from the one before it)
  let flipBar = null;
  for (let i = last; i > 0; i--) {
    if (!Number.isNaN(dir[i]) && !Number.isNaN(dir[i - 1]) && dir[i] !== dir[i - 1]) {
      flipBar = i;
      break;
    }
  }

  return {
    symbol,
    price: candles[last].c,
    time: new Date(candles[last].t * 1000).toISOString(),
    direction: dir[last] === -1 ? "bullish" : "bearish",
    supertrend: Number(st[last].toFixed(4)),
    volatility_regime: VOL_LABEL[cluster[last]],
    last_flip: flipBar
      ? {
          direction: dir[flipBar] === -1 ? "bullish" : "bearish",
          bars_ago: last - flipBar,
          time: new Date(candles[flipBar].t * 1000).toISOString(),
          price_at_flip: candles[flipBar].c,
        }
      : null,
  };
}

async function runOnce() {
  const { watchlist, step } = loadRules();
  const results = [];
  for (const symbol of watchlist) {
    try {
      results.push(await scanSymbol(symbol, step));
    } catch (err) {
      results.push({ symbol, error: err.message });
    }
  }

  const status = { generated_at: new Date().toISOString(), timeframe_seconds: step, symbols: results };
  writeFileSync(STATUS_PATH, JSON.stringify(status, null, 2));

  console.log(`\n[${status.generated_at}] Adaptive SuperTrend`);
  for (const r of results) {
    if (r.error) {
      console.log(`  ${r.symbol}: ⚠ ${r.error}`);
      continue;
    }
    const arrow = r.direction === "bullish" ? "▲" : "▼";
    const flip = r.last_flip
      ? ` | flipped ${r.last_flip.direction} ${r.last_flip.bars_ago} bar(s) ago @ ${r.last_flip.price_at_flip}`
      : "";
    console.log(
      `  ${r.symbol}: ${arrow} ${r.direction.toUpperCase()} | ST ${r.supertrend} | price ${r.price} | vol: ${r.volatility_regime}${flip}`,
    );
  }
  return status;
}

async function main() {
  await runOnce();
  if (ONCE) return;

  console.log(`\nRunning in background — polling every ${POLL_SECONDS}s. Ctrl+C to stop.`);
  console.log(`Status written to: ${STATUS_PATH.pathname.replace(/^\/([A-Z]:)/, "$1")}\n`);
  setInterval(() => {
    runOnce().catch((err) => console.error("Pass failed:", err.message));
  }, POLL_SECONDS * 1000);
}

main().catch((err) => {
  console.error("Fatal:", err.message);
  process.exit(1);
});
