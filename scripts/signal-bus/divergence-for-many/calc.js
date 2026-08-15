// Faithful JS port of pine/divergence-for-many-relevance-gated.pine's regular-divergence +
// promoted-glow-level logic, under the "Commander default profile" settings (prd=10, showlimit=3,
// searchdiv="Regular", source="Close", 4 enabled indicators: MACD, MACD Histogram, RSI,
// Stochastic). Hidden divergence is NOT implemented here -- it's disabled by default and, per the
// source, never affects glow-level promotion anyway (promotion gates on regular-divergence count
// specifically, see badgeglow_min_reg_divs). Add it later if a real need shows up, not now.
//
// This is a historical/offline reimplementation (scripts/signal-bus/), not a live-rendering one --
// output is a badge-event list and a zone list with exact bar/time anchors, not Pine line objects.
//
// One unverified assumption, flagged rather than silently guessed: Pine's ta.pivothigh/pivotlow
// tie-handling (whether equal values on either side still count as a pivot) is implemented here as
// STRICT inequality on both sides -- the common convention, but not verified against a live TV
// instance this session. Cross-check against a live capture before trusting pivot COUNTS precisely;
// the divergence logic downstream is far less sensitive to this than raw pivot counting would be.

const PRD = 10; // Pivot Period
const SHOWLIMIT = 3; // Minimum Number of Divergence (total, across enabled indicators)
const MAXPP = 10; // Maximum Pivot Points to Check
const MAXBARS = 100; // Maximum Bars to Check
const MAXARRAYSIZE = 20; // pivot history retained (mirrors Pine's ph_positions/pl_positions size)
const DONTCONFIRM = false; // Commander default: wait for confirmation (startpoint = 1)
const BADGEGLOW_MIN_REG_DIVS = 3;
const BADGEGLOW_MAX_LEVELS = 3; // per side
const BADGEGLOW_ATR_LEN = 14;
const BADGEGLOW_ATR_MULT = 0.6;
const BADGEGLOW_EXPIRE_BARS = 200;

// ── Oscillator series (the 4 Commander-default-enabled indicators) ─────────

function ema(values, length) {
  const out = new Array(values.length).fill(NaN);
  if (values.length < length) return out;
  let seed = 0;
  for (let i = 0; i < length; i++) seed += values[i];
  out[length - 1] = seed / length;
  const alpha = 2 / (length + 1);
  for (let i = length; i < values.length; i++) {
    out[i] = alpha * values[i] + (1 - alpha) * out[i - 1];
  }
  return out;
}

// Wilder's RSI (matches Pine ta.rsi)
function rsi(closes, length) {
  const out = new Array(closes.length).fill(NaN);
  if (closes.length <= length) return out;
  let gainSum = 0, lossSum = 0;
  for (let i = 1; i <= length; i++) {
    const chg = closes[i] - closes[i - 1];
    if (chg >= 0) gainSum += chg;
    else lossSum -= chg;
  }
  let avgGain = gainSum / length, avgLoss = lossSum / length;
  out[length] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
  for (let i = length + 1; i < closes.length; i++) {
    const chg = closes[i] - closes[i - 1];
    const gain = chg > 0 ? chg : 0;
    const loss = chg < 0 ? -chg : 0;
    avgGain = (avgGain * (length - 1) + gain) / length;
    avgLoss = (avgLoss * (length - 1) + loss) / length;
    out[i] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
  }
  return out;
}

// MACD histogram (deltamacd in source): macdLine(12,26) - signalLine(ema9 of macdLine)
function macdHistogram(closes) {
  const ema12 = ema(closes, 12);
  const ema26 = ema(closes, 26);
  const macdLine = closes.map((_, i) => (Number.isNaN(ema12[i]) || Number.isNaN(ema26[i]) ? NaN : ema12[i] - ema26[i]));
  const firstValid = macdLine.findIndex((v) => !Number.isNaN(v));
  const macdLineFromValid = macdLine.slice(firstValid).map((v) => (Number.isNaN(v) ? 0 : v));
  const signalFromValid = ema(macdLineFromValid, 9);
  const signalLine = new Array(closes.length).fill(NaN);
  for (let i = 0; i < signalFromValid.length; i++) signalLine[firstValid + i] = signalFromValid[i];
  return macdLine.map((v, i) => (Number.isNaN(v) || Number.isNaN(signalLine[i]) ? NaN : v - signalLine[i]));
}

function macdLineOnly(closes) {
  const ema12 = ema(closes, 12);
  const ema26 = ema(closes, 26);
  return closes.map((_, i) => (Number.isNaN(ema12[i]) || Number.isNaN(ema26[i]) ? NaN : ema12[i] - ema26[i]));
}

// stoch(close, high, low, 14) then sma(.., 3) -- Pine's %K definition, not the smoothed %D
function stochSma3(candles) {
  const len = candles.length;
  const rawStoch = new Array(len).fill(NaN);
  for (let i = 13; i < len; i++) {
    let hh = -Infinity, ll = Infinity;
    for (let j = i - 13; j <= i; j++) {
      if (candles[j].h > hh) hh = candles[j].h;
      if (candles[j].l < ll) ll = candles[j].l;
    }
    rawStoch[i] = hh === ll ? 0 : (100 * (candles[i].c - ll)) / (hh - ll);
  }
  const out = new Array(len).fill(NaN);
  for (let i = 15; i < len; i++) {
    if (Number.isNaN(rawStoch[i]) || Number.isNaN(rawStoch[i - 1]) || Number.isNaN(rawStoch[i - 2])) continue;
    out[i] = (rawStoch[i] + rawStoch[i - 1] + rawStoch[i - 2]) / 3;
  }
  return out;
}

// ── Additional oscillators (Commander default profile disables these 6; added 2026-07-25 for the
// "what if the remaining indicators were enabled" exploratory pass -- NOT wired into the default
// export path, opt-in via computeDivergenceForMany's `enabledIndicators` option). "External" (the
// 11th slot) is skipped -- its source is user-configurable in Pine with no fixed default meaning,
// so there's nothing faithful to port. ────────────────────────────────────────────────────────

// ta.cci(source, length) = (source - sma(source,length)) / (0.015 * meanAbsDev(source,length))
function cci(closes, length) {
  const out = new Array(closes.length).fill(NaN);
  for (let i = length - 1; i < closes.length; i++) {
    let sum = 0;
    for (let j = i - length + 1; j <= i; j++) sum += closes[j];
    const mean = sum / length;
    let devSum = 0;
    for (let j = i - length + 1; j <= i; j++) devSum += Math.abs(closes[j] - mean);
    const meanDev = devSum / length;
    out[i] = meanDev === 0 ? 0 : (closes[i] - mean) / (0.015 * meanDev);
  }
  return out;
}

// mom(close, length) = close[i] - close[i-length]
function momentum(closes, length) {
  const out = new Array(closes.length).fill(NaN);
  for (let i = length; i < closes.length; i++) out[i] = closes[i] - closes[i - length];
  return out;
}

// Cumulative On-Balance Volume
function obv(candles) {
  const out = new Array(candles.length).fill(NaN);
  out[0] = 0;
  for (let i = 1; i < candles.length; i++) {
    const chg = candles[i].c - candles[i - 1].c;
    out[i] = out[i - 1] + (chg > 0 ? candles[i].v : chg < 0 ? -candles[i].v : 0);
  }
  return out;
}

function vwma(candles, length) {
  const out = new Array(candles.length).fill(NaN);
  for (let i = length - 1; i < candles.length; i++) {
    let pv = 0, vsum = 0;
    for (let j = i - length + 1; j <= i; j++) {
      pv += candles[j].c * candles[j].v;
      vsum += candles[j].v;
    }
    out[i] = vsum === 0 ? NaN : pv / vsum;
  }
  return out;
}

// vwmacd = vwma(close,12) - vwma(close,26)
function vwmacd(candles) {
  const fast = vwma(candles, 12);
  const slow = vwma(candles, 26);
  return candles.map((_, i) => (Number.isNaN(fast[i]) || Number.isNaN(slow[i]) ? NaN : fast[i] - slow[i]));
}

// Chaikin Money Flow. Source computes sma(moneyFlowVolume,21)/sma(volume,21), which is
// mathematically identical to sum(moneyFlowVolume,21)/sum(volume,21) (the /21 cancels) -- simpler
// to implement as the sum ratio directly.
function cmf(candles, length = 21) {
  const out = new Array(candles.length).fill(NaN);
  const mfv = candles.map((c) => (c.h === c.l ? 0 : (((c.c - c.l) - (c.h - c.c)) / (c.h - c.l)) * c.v));
  for (let i = length - 1; i < candles.length; i++) {
    let mfvSum = 0, vSum = 0;
    for (let j = i - length + 1; j <= i; j++) {
      mfvSum += mfv[j];
      vSum += candles[j].v;
    }
    out[i] = vSum === 0 ? NaN : mfvSum / vSum;
  }
  return out;
}

// ta.mfi(source, length) generalized definition (source = close here, not the typical-price
// textbook MFI): positive/negative money flow classified by source-over-source change, weighted
// by volume*source, not the standard hlc3-based textbook formula.
function mfi(closes, candles, length) {
  const out = new Array(closes.length).fill(NaN);
  for (let i = length; i < closes.length; i++) {
    let posFlow = 0, negFlow = 0;
    for (let j = i - length + 1; j <= i; j++) {
      const chg = closes[j] - closes[j - 1];
      const flow = closes[j] * candles[j].v;
      if (chg > 0) posFlow += flow;
      else if (chg < 0) negFlow += flow;
    }
    out[i] = negFlow === 0 ? 100 : 100 - 100 / (1 + posFlow / negFlow);
  }
  return out;
}

// Registry of every implementable indicator -- computeDivergenceForMany's `enabledIndicators`
// option selects a subset by name (default: the Commander 4). Some need the full candle array
// (volume-dependent), not just closes -- builder takes ({closes, candles}) uniformly.
export const INDICATOR_REGISTRY = {
  macd: ({ closes }) => macdLineOnly(closes),
  macd_hist: ({ closes }) => macdHistogram(closes),
  rsi: ({ closes }) => rsi(closes, 14),
  stoch: ({ candles }) => stochSma3(candles),
  cci: ({ closes }) => cci(closes, 10),
  momentum: ({ closes }) => momentum(closes, 10),
  obv: ({ candles }) => obv(candles),
  vwmacd: ({ candles }) => vwmacd(candles),
  cmf: ({ candles }) => cmf(candles, 21),
  mfi: ({ closes, candles }) => mfi(closes, candles, 14),
};
export const COMMANDER_DEFAULT_INDICATORS = ["macd", "macd_hist", "rsi", "stoch"];
export const ALL_IMPLEMENTED_INDICATORS = Object.keys(INDICATOR_REGISTRY);

// ── Pivot detection (source = "Close", per Commander default) ──────────────
// Returns arrays of {barIdx, confirmBarIdx, val} in chronological order. confirmBarIdx = barIdx +
// PRD, matching Pine's ph_positions/pl_positions which store the CONFIRMATION bar, not the pivot
// bar itself (a pivot is only knowable PRD bars after it happens).
function findPivots(closes) {
  const highs = [], lows = [];
  for (let p = PRD; p < closes.length - PRD; p++) {
    let isHigh = true, isLow = true;
    for (let j = p - PRD; j <= p + PRD; j++) {
      if (j === p) continue;
      if (closes[j] >= closes[p]) isHigh = false;
      if (closes[j] <= closes[p]) isLow = false;
      if (!isHigh && !isLow) break;
    }
    if (isHigh) highs.push({ barIdx: p, confirmBarIdx: p + PRD, val: closes[p] });
    if (isLow) lows.push({ barIdx: p, confirmBarIdx: p + PRD, val: closes[p] });
  }
  return { highs, lows };
}

// ── Regular divergence check against a set of recorded pivots ──────────────
// Mirrors positive_regular_positive_hidden_divergence(src, cond=1) / negative_regular_...(cond=1).
// `direction`: "positive" (checked against pivot LOWS) or "negative" (checked against pivot HIGHS).
// `recentPivots`: pivots with confirmBarIdx <= i, most-recent-first, capped to MAXARRAYSIZE, scanned
// up to MAXPP of them (matches Pine's array unshift + fixed-size scan).
function checkRegularDivergence(osc, closes, i, recentPivots, direction) {
  const startpoint = DONTCONFIRM ? 0 : 1;
  const gateOk = direction === "positive" ? osc[i] > osc[i - 1] || closes[i] > closes[i - 1] : osc[i] < osc[i - 1] || closes[i] < closes[i - 1];
  if (!gateOk) return 0;

  const srcNow = osc[i - startpoint];
  const closeNow = closes[i - startpoint];
  if (Number.isNaN(srcNow) || Number.isNaN(closeNow)) return 0;

  for (let x = 0; x < Math.min(MAXPP, recentPivots.length); x++) {
    const piv = recentPivots[x];
    const len = i - piv.confirmBarIdx + PRD;
    if (len > MAXBARS) break; // matches Pine's break (array exhausted or too old)
    if (len <= 5) continue;
    const idxLen = i - len; // = piv.barIdx, the actual pivot bar
    if (idxLen < 0) continue;
    const srcLen = osc[idxLen];
    const closeLen = closes[idxLen];
    if (Number.isNaN(srcLen) || Number.isNaN(closeLen)) continue;

    const divCondition =
      direction === "positive" ? srcNow > srcLen && closeNow < piv.val : srcNow < srcLen && closeNow > piv.val;
    if (!divCondition) continue;

    const slope1 = (srcNow - srcLen) / (len - startpoint);
    const slope2 = (closeNow - closeLen) / (len - startpoint);
    let vLine1 = srcNow - slope1;
    let vLine2 = closeNow - slope2;
    let arrived = true;
    for (let y = 1 + startpoint; y <= len - 1; y++) {
      const idxY = i - y;
      const srcY = idxY >= 0 ? osc[idxY] : NaN;
      const closeY = idxY >= 0 ? closes[idxY] : NaN;
      const failCond = direction === "positive" ? srcY < vLine1 || (closeY || 0) < vLine2 : srcY > vLine1 || (closeY || 0) > vLine2;
      if (failCond) {
        arrived = false;
        break;
      }
      vLine1 -= slope1;
      vLine2 -= slope2;
    }
    if (arrived) return len;
  }
  return 0;
}

// ── Public: compute badges + promoted zones over a full candle series ──────
// candles: [{t, o, h, l, c, v}, ...] chronological. Returns { badges, zones }.
//   badges: one entry per bar where a Regular-divergence badge fired (>=3 of 4 enabled indicators
//     agree on the same side), { barIdx, time, side: "bullish"|"bearish", count }.
//   zones: promoted glow levels, { side, price, createdBarIdx, createdTime, confirmedBarIdx,
//     confirmedTime, expiresBarIdx, expiresTime, status: "active"|"expired"|"evicted_by_capacity" }
//     -- status/expiresTime reflect the FULL lifecycle as simulated forward through the whole
//     series (this is an offline batch computation, so we know the outcome, unlike live Pine).
// options: { enabledIndicators, showlimit, minRegDivs } -- all default to the exact Commander
// profile, so existing callers (build-historical.js) are unaffected. Added 2026-07-25 to support
// the exploratory "what if the other indicators were enabled" pass without touching the live
// chart's actual settings -- this is a read-only analysis path, not a config change.
export function computeDivergenceForMany(candles, options = {}) {
  const enabledIndicators = options.enabledIndicators || COMMANDER_DEFAULT_INDICATORS;
  const showlimit = options.showlimit ?? SHOWLIMIT;
  const minRegDivs = options.minRegDivs ?? BADGEGLOW_MIN_REG_DIVS;

  const n = candles.length;
  const closes = candles.map((c) => c.c);
  const highs = candles.map((c) => c.h);
  const lows = candles.map((c) => c.l);

  const ctx = { closes, candles };
  const oscillators = enabledIndicators.map((name) => {
    const build = INDICATOR_REGISTRY[name];
    if (!build) throw new Error(`Unknown indicator "${name}" -- expected one of: ${ALL_IMPLEMENTED_INDICATORS.join(", ")}`);
    return { name, series: build(ctx) };
  });

  const { highs: pivotHighsAll, lows: pivotLowsAll } = findPivots(closes);
  // ATR for the dedup tolerance
  let atrSeries;
  {
    const trueRange = candles.map((c, i) => {
      if (i === 0) return c.h - c.l;
      const pc = candles[i - 1].c;
      return Math.max(c.h - c.l, Math.abs(c.h - pc), Math.abs(c.l - pc));
    });
    atrSeries = new Array(n).fill(NaN);
    if (n >= BADGEGLOW_ATR_LEN) {
      let seed = 0;
      for (let i = 0; i < BADGEGLOW_ATR_LEN; i++) seed += trueRange[i];
      atrSeries[BADGEGLOW_ATR_LEN - 1] = seed / BADGEGLOW_ATR_LEN;
      for (let i = BADGEGLOW_ATR_LEN; i < n; i++) {
        atrSeries[i] = (atrSeries[i - 1] * (BADGEGLOW_ATR_LEN - 1) + trueRange[i]) / BADGEGLOW_ATR_LEN;
      }
    }
  }

  const badges = [];
  const zones = []; // finished + still-active, chronological creation order
  const activeBull = []; // indices into `zones`, mirrors Pine's bull_glow_* arrays (oldest first)
  const activeBear = [];

  // Rolling "recorded pivots as of bar i" lists, most-recent-first, capped to MAXARRAYSIZE --
  // mirrors Pine's array.unshift + size cap on ph_positions/pl_positions.
  let recentHighs = [];
  let recentLows = [];
  let phCursor = 0, plCursor = 0; // next un-consumed index into pivotHighsAll/pivotLowsAll

  const startpoint = DONTCONFIRM ? 0 : 1;
  const minBar = Math.max(26 + 9, 15, PRD + PRD + 1); // warmup: MACD needs the most (26+9), stoch needs 15

  for (let i = minBar; i < n; i++) {
    // Advance pivot cursors: a pivot is "recorded" once confirmed (confirmBarIdx <= i)
    while (phCursor < pivotHighsAll.length && pivotHighsAll[phCursor].confirmBarIdx <= i) {
      recentHighs.unshift(pivotHighsAll[phCursor]);
      if (recentHighs.length > MAXARRAYSIZE) recentHighs.pop();
      phCursor++;
    }
    while (plCursor < pivotLowsAll.length && pivotLowsAll[plCursor].confirmBarIdx <= i) {
      recentLows.unshift(pivotLowsAll[plCursor]);
      if (recentLows.length > MAXARRAYSIZE) recentLows.pop();
      plCursor++;
    }

    // Touch-refresh (source: refresh_touched_glows, `pine/divergence-for-many-touch-refresh-
    // intensity.pine` lines 331-341) -- runs BEFORE expiry, same call order as the source. If
    // price is touching a level RIGHT NOW (low <= level <= high, identical test to touches.js),
    // its EXPIRY clock resets to the current bar, extending its life another
    // BADGEGLOW_EXPIRE_BARS from THIS touch instead of the original promotion bar. Missing here
    // until 2026-08-13 -- confirmed via iapaulo's live example (a bullish 1h zone at
    // ~63,732/63,747, confirmed 2026-07-25, still respected live on 2026-08-13 -- 19 days later,
    // 4.5x past the fixed 200-bar/~8.3-day clock this port used to enforce with no refresh at
    // all). In the Pine source, the "bars" array IS the expiry clock and has no separate original-
    // confirmation memory -- but this port's confirmedBarIdx/confirmedTime are relied on elsewhere
    // (touches.js's detectTouches scan-start, confluence.js's activeWindow start) as a FIXED origin
    // for the zone's whole active lifetime, not a drifting clock. Overwriting confirmedBarIdx
    // in-place on refresh (first attempt, reverted) broke exactly that: it made detectTouches only
    // see touches after the LAST refresh, undercounting badly (15m touches dropped 7,389 -> 1,127
    // in one rebuild). Fixed by keeping confirmedBarIdx/confirmedTime as the fixed origin (as
    // every other caller expects) and tracking the drifting refresh clock in a separate field,
    // expiryClockBarIdx/expiryClockTime, used ONLY by the expire check below.
    for (const list of [activeBull, activeBear]) {
      for (const idx of list) {
        const z = zones[idx];
        if (lows[i] <= z.price && highs[i] >= z.price) {
          z.expiryClockBarIdx = i;
          z.expiryClockTime = candles[i].t;
        }
      }
    }

    // Expire old zones (matches source's call order: expire after refresh, before this bar's promotion)
    for (const list of [activeBull, activeBear]) {
      for (let k = list.length - 1; k >= 0; k--) {
        const z = zones[list[k]];
        if (i - z.expiryClockBarIdx > BADGEGLOW_EXPIRE_BARS) {
          z.status = "expired";
          z.expiresBarIdx = z.expiryClockBarIdx + BADGEGLOW_EXPIRE_BARS;
          z.expiresTime = candles[z.expiresBarIdx]?.t ?? null;
          list.splice(k, 1);
        }
      }
    }

    let posCount = 0, negCount = 0;
    for (const { series } of oscillators) {
      if (checkRegularDivergence(series, closes, i, recentLows, "positive") > 0) posCount++;
      if (checkRegularDivergence(series, closes, i, recentHighs, "negative") > 0) negCount++;
    }
    const totalDiv = posCount + negCount; // showlimit gate (Regular-only, matches source under Commander defaults)
    if (totalDiv < showlimit) continue;

    if (negCount > 0) badges.push({ barIdx: i, time: candles[i].t, side: "bearish", count: negCount });
    if (posCount > 0) badges.push({ barIdx: i, time: candles[i].t, side: "bullish", count: posCount });

    const tol = atrSeries[i] * BADGEGLOW_ATR_MULT;
    if (Number.isNaN(tol)) continue;

    if (negCount >= minRegDivs) {
      const level = highs[i - startpoint];
      const nearExisting = activeBear.some((idx) => Math.abs(zones[idx].price - level) <= tol);
      if (!nearExisting) {
        const zoneIdx = zones.length;
        zones.push({
          side: "bearish",
          price: level,
          createdBarIdx: i - startpoint,
          createdTime: candles[i - startpoint].t,
          confirmedBarIdx: i,
          confirmedTime: candles[i].t,
          expiryClockBarIdx: i,
          expiryClockTime: candles[i].t,
          expiresBarIdx: null,
          expiresTime: null,
          status: "active",
          atrAtCreation: atrSeries[i],
        });
        activeBear.push(zoneIdx);
        if (activeBear.length > BADGEGLOW_MAX_LEVELS) {
          const evictedIdx = activeBear.shift(); // oldest (index 0), matches trim_glows_to_max
          zones[evictedIdx].status = "evicted_by_capacity";
          zones[evictedIdx].expiresBarIdx = i;
          zones[evictedIdx].expiresTime = candles[i].t;
        }
      }
    }
    if (posCount >= minRegDivs) {
      const level = lows[i - startpoint];
      const nearExisting = activeBull.some((idx) => Math.abs(zones[idx].price - level) <= tol);
      if (!nearExisting) {
        const zoneIdx = zones.length;
        zones.push({
          side: "bullish",
          price: level,
          createdBarIdx: i - startpoint,
          createdTime: candles[i - startpoint].t,
          confirmedBarIdx: i,
          confirmedTime: candles[i].t,
          expiryClockBarIdx: i,
          expiryClockTime: candles[i].t,
          expiresBarIdx: null,
          expiresTime: null,
          status: "active",
          atrAtCreation: atrSeries[i],
        });
        activeBull.push(zoneIdx);
        if (activeBull.length > BADGEGLOW_MAX_LEVELS) {
          const evictedIdx = activeBull.shift();
          zones[evictedIdx].status = "evicted_by_capacity";
          zones[evictedIdx].expiresBarIdx = i;
          zones[evictedIdx].expiresTime = candles[i].t;
        }
      }
    }
  }

  // Anything still active at series end stays "active" with no expiry recorded yet.
  return { badges, zones };
}
