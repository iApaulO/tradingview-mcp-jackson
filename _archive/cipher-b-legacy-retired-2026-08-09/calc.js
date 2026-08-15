// Faithful JS port of pine/vmc-cipher-b-divergences.pine's fractal-based divergence detection
// (WT regular, WT "2nd"/looser-threshold, RSI, Stochastic RSI -- each in both regular and hidden
// form, both sides), under the indicator's own default settings. This is the same kind of offline
// reimplementation as smc/calc.js -- a historical event series, not a live-rendering one.
//
// Every constant below is cited to its exact source line so a future re-read of the .pine file can
// verify this against a newer version rather than trust it blindly.
//
// KEY CORRECTION (2026-08-08): this session's earlier ad-hoc verification scripts computed a plain
// price-based Stochastic for "stochK"/"stochD". The real source (f_stochrsi, line 223-230) computes
// STOCHASTIC RSI on log(close), not price -- RSI(log(close),14) first, then %K of THAT RSI series
// over its own 14-bar range, then smoothed 3/3. Different formula, different numbers. Fixed here.

const WT_CHANNEL_LEN = 9, WT_AVERAGE_LEN = 12, WT_MA_LEN = 3; // wtChannelLen/wtAverageLen/wtMALen, line 48-51 (source=hlc3)
const WT_DIV_OB = 45, WT_DIV_OS = -65; // wtDivOBLevel/wtDivOSLevel, line 65-66 -- regular WT div gate
const WT_DIV_OB_ADD = 15, WT_DIV_OS_ADD = -40; // wtDivOBLevel_add/wtDivOSLevel_add, line 70-71 -- "2nd" WT div gate
const RSI_LEN = 14; // rsiLen, line 82 (source=close)
const RSI_DIV_OB = 60, RSI_DIV_OS = 30; // rsiDivOBLevel/rsiDivOSLevel, line 89-90
const STOCH_LEN = 14, STOCH_RSI_LEN = 14, STOCH_K_SMOOTH = 3, STOCH_D_SMOOTH = 3; // line 97-100 (source=close, log=true, avg=false)
// showHiddenDiv_nl, line 64, default true: hidden divergences (for WT-regular and RSI) are computed
// from a SEPARATE ungated fractal pass (topLimit=botLimit=0, useLimits=false), not the gated one --
// confirmed by the source's own wtBearDivHidden_/rsiBearDivHidden_ reassignment (line 336-337,
// 352-353). WT-2nd has no such override (line 345-346 use wtBearDivHidden_add directly, gated).
// Stoch has no override either (line 367-368 use stochBearDivHidden directly, always ungated).

const COLOR = {
  bear: "#e60000", // WTBearDivColorDown / rsiBearColor / stochbearcolor -- same red across all three
  bull: "#00e676", // wtBullDivColorUp / rsiBullColor / stochbullcolor -- same green across all three
};

function ema(vals, len) {
  const k = 2 / (len + 1);
  const out = new Array(vals.length);
  let prev;
  for (let i = 0; i < vals.length; i++) {
    prev = i === 0 ? vals[i] : vals[i] * k + prev * (1 - k);
    out[i] = prev;
  }
  return out;
}

function sma(vals, len) {
  const out = new Array(vals.length).fill(NaN);
  for (let i = len - 1; i < vals.length; i++) {
    let s = 0;
    for (let j = i - len + 1; j <= i; j++) s += vals[j];
    out[i] = s / len;
  }
  return out;
}

// Pine's rsi(): Wilder-smoothed RS, seeded from a simple average of the first `len` gains/losses.
function rsiWilder(vals, len) {
  const out = new Array(vals.length).fill(NaN);
  if (vals.length <= len) return out;
  let gain = 0, loss = 0;
  for (let i = 1; i <= len; i++) {
    const d = vals[i] - vals[i - 1];
    if (d >= 0) gain += d; else loss -= d;
  }
  gain /= len; loss /= len;
  out[len] = 100 - 100 / (1 + (loss === 0 ? Infinity : gain / loss));
  for (let i = len + 1; i < vals.length; i++) {
    const d = vals[i] - vals[i - 1];
    const g = d > 0 ? d : 0, l = d < 0 ? -d : 0;
    gain = (gain * (len - 1) + g) / len;
    loss = (loss * (len - 1) + l) / len;
    out[i] = 100 - 100 / (1 + (loss === 0 ? Infinity : gain / loss));
  }
  return out;
}

// Pine's stoch(src, src, src, len) collapsed to a single series: %K of `vals` against its own
// `len`-bar high/low range.
function stochOfSeries(vals, len) {
  const out = new Array(vals.length).fill(NaN);
  for (let i = len - 1; i < vals.length; i++) {
    let hh = -Infinity, ll = Infinity;
    for (let j = i - len + 1; j <= i; j++) {
      if (Number.isNaN(vals[j])) continue;
      hh = Math.max(hh, vals[j]); ll = Math.min(ll, vals[j]);
    }
    out[i] = hh === ll ? 0 : ((vals[i] - ll) / (hh - ll)) * 100;
  }
  return out;
}

// f_wavetrend, line 185-201 -- only wt1/wt2 needed here (cross/oversold/overbought flags belong to
// the live-signal side of the indicator, not divergence detection).
function waveTrend(candles) {
  const ap = candles.map((c) => (c.h + c.l + c.c) / 3); // hlc3
  const esa = ema(ap, WT_CHANNEL_LEN);
  const de = ema(ap.map((v, i) => Math.abs(v - esa[i])), WT_CHANNEL_LEN);
  const ci = ap.map((v, i) => (de[i] === 0 ? 0 : (v - esa[i]) / (0.015 * de[i])));
  const wt1 = ema(ci, WT_AVERAGE_LEN);
  const wt2 = sma(wt1, WT_MA_LEN);
  return { wt1, wt2 };
}

// f_stochrsi, line 223-230, with stochUseLog=true, stochAvg=false (source defaults) -- k = kk
// (the averaged/`_avg` branch is never taken since stochAvg is false by default).
function stochasticRSI(candles) {
  const src = candles.map((c) => Math.log(c.c));
  const rsiOfSrc = rsiWilder(src, STOCH_RSI_LEN);
  const rawK = stochOfSeries(rsiOfSrc, STOCH_LEN);
  const k = sma(rawK, STOCH_K_SMOOTH);
  const d = sma(k, STOCH_D_SMOOTH);
  return { k, d };
}

// f_top_fractal / f_bot_fractal, line 164-165. Strict 5-bar fractal: bar (i-2) is the pivot,
// confirmed once bar i closes (hence every plot in the source uses offset=-2).
function topFractal(src, i) {
  if (i < 4) return false;
  return src[i - 4] < src[i - 2] && src[i - 3] < src[i - 2] && src[i - 2] > src[i - 1] && src[i - 2] > src[i];
}
function botFractal(src, i) {
  if (i < 4) return false;
  return src[i - 4] > src[i - 2] && src[i - 3] > src[i - 2] && src[i - 2] < src[i - 1] && src[i - 2] < src[i];
}

// f_findDivs, line 168-179. `priceHigh`/`priceLow` are the candle's high/low series (source compares
// the oscillator's fractal against `high`/`low`, not against the oscillator's own price proxy).
// Returns regular + hidden divergence events, each carrying BOTH pivots (not just "divergence fired
// here") -- the previous pivot's bar/value is what a forward-projected line needs as its first point.
function findDivs(src, priceHigh, priceLow, topLimit, botLimit, useLimits, label) {
  const events = [];
  let prevTop = null, prevBot = null; // {barIdx, srcVal, priceVal}

  for (let i = 4; i < src.length; i++) {
    const pivotIdx = i - 2;

    if (topFractal(src, i)) {
      const srcVal = src[pivotIdx], priceVal = priceHigh[pivotIdx];
      const passesGate = !useLimits || srcVal >= topLimit;
      if (passesGate) {
        if (prevTop) {
          if (priceVal > prevTop.priceVal && srcVal < prevTop.srcVal) {
            events.push(divEvent(label, "bear", false, prevTop, { barIdx: pivotIdx, srcVal, priceVal }, i));
          } else if (priceVal < prevTop.priceVal && srcVal > prevTop.srcVal) {
            events.push(divEvent(label, "bear", true, prevTop, { barIdx: pivotIdx, srcVal, priceVal }, i));
          }
        }
        prevTop = { barIdx: pivotIdx, srcVal, priceVal };
      }
    }

    if (botFractal(src, i)) {
      const srcVal = src[pivotIdx], priceVal = priceLow[pivotIdx];
      const passesGate = !useLimits || srcVal <= botLimit;
      if (passesGate) {
        if (prevBot) {
          if (priceVal < prevBot.priceVal && srcVal > prevBot.srcVal) {
            events.push(divEvent(label, "bull", false, prevBot, { barIdx: pivotIdx, srcVal, priceVal }, i));
          } else if (priceVal > prevBot.priceVal && srcVal < prevBot.srcVal) {
            events.push(divEvent(label, "bull", true, prevBot, { barIdx: pivotIdx, srcVal, priceVal }, i));
          }
        }
        prevBot = { barIdx: pivotIdx, srcVal, priceVal };
      }
    }
  }
  return events;
}

function divEvent(source, side, hidden, prevPivot, currPivot, confirmIdx) {
  return {
    source, side, hidden,
    color: side === "bear" ? COLOR.bear : COLOR.bull,
    prevBarIdx: prevPivot.barIdx, prevOscVal: prevPivot.srcVal, prevPriceVal: prevPivot.priceVal,
    barIdx: currPivot.barIdx, oscVal: currPivot.srcVal, priceVal: currPivot.priceVal,
    confirmBarIdx: confirmIdx,
  };
}

// computeCipherBDivergences(candles) -- candles: [{t,o,h,l,c,v}, ...], oldest first (same shape
// loadCandles() already produces for smc/calc.js).
export function computeCipherBDivergences(candles) {
  const high = candles.map((c) => c.h);
  const low = candles.map((c) => c.l);
  const close = candles.map((c) => c.c);
  const time = candles.map((c) => c.t);

  const { wt2 } = waveTrend(candles);
  const rsi = rsiWilder(close, RSI_LEN);
  const { k: stochK } = stochasticRSI(candles);

  // WT regular: gated pass for the regular signal, ungated pass supplies its hidden fields
  // (showHiddenDiv_nl default true, line 336-337).
  const wtGated = findDivs(wt2, high, low, WT_DIV_OB, WT_DIV_OS, true, "wt").filter((e) => !e.hidden);
  const wtUngated = findDivs(wt2, high, low, 0, 0, false, "wt").filter((e) => e.hidden);

  // WT 2nd/"add": single gated pass, both regular and hidden used directly (line 345-346, no
  // showHiddenDiv_nl override for this one).
  const wtAdd = findDivs(wt2, high, low, WT_DIV_OB_ADD, WT_DIV_OS_ADD, true, "wt2nd");

  // RSI: same gated/ungated split as WT regular (line 352-353).
  const rsiGated = findDivs(rsi, high, low, RSI_DIV_OB, RSI_DIV_OS, true, "rsi").filter((e) => !e.hidden);
  const rsiUngated = findDivs(rsi, high, low, 0, 0, false, "rsi").filter((e) => e.hidden);

  // Stoch: always ungated, both fields used directly (line 362, 367-368).
  const stoch = findDivs(stochK, high, low, 0, 0, false, "stoch");

  const all = [...wtGated, ...wtUngated, ...wtAdd, ...rsiGated, ...rsiUngated, ...stoch]
    .map((e) => ({
      ...e,
      time: time[e.barIdx],
      prevTime: time[e.prevBarIdx],
      confirmTime: time[e.confirmBarIdx],
      // Line in (bar_idx, oscillator_value) space, connecting the two real pivots -- the object
      // the forward-projection/angle work (next build step) consumes directly.
      slope: (e.oscVal - e.prevOscVal) / (e.barIdx - e.prevBarIdx),
    }))
    .sort((a, b) => a.confirmBarIdx - b.confirmBarIdx);

  return { divergences: all, series: { wt2, rsi, stochK } };
}
