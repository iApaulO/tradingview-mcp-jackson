// Shared calc engine for pine/ml-adaptive-supertrend-algoalpha.pine (K-Means Adaptive SuperTrend).
// Read-only: pulls public Bitstamp OHLC candles and recomputes the indicator in JS — no exchange
// keys, no orders. Used by both scripts/supertrend-monitor.js (background poller) and
// scripts/signal-grid.js (multi-timeframe grid).

// ── Indicator settings (mirrors pine/ml-adaptive-supertrend-algoalpha.pine defaults) ──
const ATR_LEN = 10;
const FACTOR = 3;
const TRAINING_PERIOD = 100;
const HIGHVOL_GUESS = 0.75;
const MIDVOL_GUESS = 0.5;
const LOWVOL_GUESS = 0.25;
const KMEANS_MAX_ITER = 200;
const KMEANS_EPS = 1e-9;

// Bitstamp's OHLC endpoint tops out at 3-day candles — no native weekly step.
// "W" is synthesized by fetching daily candles and aggregating 7 calendar days at a time.
export const TF_TO_STEP = { 1: 60, 5: 300, 15: 900, 30: 1800, 60: 3600, 120: 7200, 240: 14400, 360: 21600, 720: 43200, D: 86400, W: "agg-weekly" };

export const VOL_LABEL = ["HIGH", "MEDIUM", "LOW"];

async function fetchBitstampOhlc(symbol, step, limit) {
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

function aggregateWeekly(dailyCandles) {
  // Group by ISO week (Monday 00:00 UTC boundary) — crypto trades 24/7 so this is exact.
  const weeks = new Map();
  for (const c of dailyCandles) {
    const d = new Date(c.t * 1000);
    const dow = (d.getUTCDay() + 6) % 7; // 0 = Monday
    const monday = new Date(d);
    monday.setUTCDate(d.getUTCDate() - dow);
    monday.setUTCHours(0, 0, 0, 0);
    const key = monday.getTime() / 1000;
    if (!weeks.has(key)) weeks.set(key, []);
    weeks.get(key).push(c);
  }
  return [...weeks.entries()]
    .sort(([a], [b]) => a - b)
    .map(([t, bars]) => ({
      t,
      o: bars[0].o,
      h: Math.max(...bars.map((b) => b.h)),
      l: Math.min(...bars.map((b) => b.l)),
      c: bars[bars.length - 1].c,
    }));
}

// ── Public: fetch candles for a timeframe key from TF_TO_STEP ("15", "60", "240", "D", "W") ──
export async function fetchCandles(symbol, timeframeKey, limit = 250) {
  const step = TF_TO_STEP[timeframeKey];
  if (!step) throw new Error(`Unrecognized timeframe "${timeframeKey}"`);
  if (step === "agg-weekly") {
    // Need enough daily history to build `limit` weekly bars once aggregated (~7x, plus buffer).
    const daily = await fetchBitstampOhlc(symbol, TF_TO_STEP.D, Math.min(limit * 7 + 30, 1000));
    return aggregateWeekly(daily);
  }
  return fetchBitstampOhlc(symbol, step, limit);
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
    iterations++;
  }

  return { centroids: [amean[0], bmean[0], cmean[0]] }; // [high, medium, low]
}

// ── Adaptive SuperTrend — recursive band logic, mirrors pine_supertrend() ──
function computeAdaptiveSuperTrend(candles, atr) {
  const n = candles.length;
  const dir = new Array(n).fill(NaN);
  const st = new Array(n).fill(NaN);
  const cluster = new Array(n).fill(NaN); // 0=high, 1=medium, 2=low
  let prevUpperBand = NaN, prevLowerBand = NaN, prevST = NaN;

  const warmup = ATR_LEN + TRAINING_PERIOD;

  for (let i = 0; i < n; i++) {
    if (i < warmup || Number.isNaN(atr[i])) continue;

    const { hi: upper, lo: lower } = highestLowest(atr, i, TRAINING_PERIOD);
    const atrWindow = [];
    for (let k = i - TRAINING_PERIOD + 1; k <= i; k++) atrWindow.push(atr[k]);

    const { centroids } = kmeansCluster(atrWindow, lower, upper);
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

    st[i] = direction === -1 ? lowerBand : upperBand;
    dir[i] = direction;
    prevUpperBand = upperBand;
    prevLowerBand = lowerBand;
    prevST = st[i];
  }

  return { dir, st, cluster };
}

// ── Public: full scan for one symbol + timeframe — fetch, compute, summarize ──
export async function scanAdaptiveSuperTrend(symbol, timeframeKey, limit = 250) {
  const candles = await fetchCandles(symbol, timeframeKey, limit);
  const atr = calcATRSeries(candles, ATR_LEN);
  const { dir, st, cluster } = computeAdaptiveSuperTrend(candles, atr);

  const last = candles.length - 1;
  if (Number.isNaN(dir[last])) {
    return { symbol, timeframe: timeframeKey, error: "insufficient history for warmup (need more candles)" };
  }

  let flipBar = null;
  for (let i = last; i > 0; i--) {
    if (!Number.isNaN(dir[i]) && !Number.isNaN(dir[i - 1]) && dir[i] !== dir[i - 1]) {
      flipBar = i;
      break;
    }
  }

  return {
    symbol,
    timeframe: timeframeKey,
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
