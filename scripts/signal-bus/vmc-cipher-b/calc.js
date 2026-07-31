// Faithful JS port of pine/vmc-cipher-b-divergences.pine's WaveTrend regular + hidden divergence
// detection (f_wavetrend + f_findDivs applied to wt2), under the LIVE chart's actual settings --
// confirmed 2026-07-31 via a direct properties probe against the running indicator (entity Ilt4Lv,
// "VuManChu B Divergences"), NOT the Pine author's documented defaults. One setting genuinely
// deviates from the author's own default: wtShowHiddenDiv is live-set to TRUE (author's default is
// false) -- so hidden divergences are actually being shown on the chart, not just regular ones.
// Both are implemented here and tagged separately (kind: 'regular' | 'hidden') so they can be
// tested independently before any decision about pooling them.
//
// Scope, deliberately narrow for this first pass: only the flagship WT-wave2 divergence signal --
// the one the indicator is literally named after ("VuManChu B Divergences") and the one under
// discussion on 2026-07-31 (W/D showing div lines, 4h "matured"). NOT implemented yet: RSI
// divergence (rsiShowDiv=false live, confirmed off), Stoch divergence (stochShowDiv=false live,
// confirmed off), buySignal/sellSignal (WT cross at OB/OS, no divergence requirement), wtGoldBuy,
// Sommi flag/diamond (sommiFlagShow/sommiDiamondShow both false live, confirmed off). Those are
// out of scope for this build, not forgotten -- add if/when there's a concrete reason to.
//
// This is a historical/offline reimplementation (scripts/signal-bus/), not a live-rendering one:
// output is a "zones" list shaped identically to divergence-for-many's (side, price, confirmedBarIdx,
// confirmedTime, expiresBarIdx, expiresTime, status) specifically so the EXISTING touches.js and
// confluence.js can be reused unmodified via import -- no need to re-derive that logic.

const WT_CHANNEL_LEN = 9; // live-confirmed (wtChannelLen, in_6)
const WT_AVERAGE_LEN = 12; // live-confirmed (wtAverageLen, in_7)
const WT_MA_LEN = 3; // live-confirmed (wtMALen, in_9)
const WT_DIV_OB_LEVEL = 45; // live-confirmed (wtDivOBLevel, in_19) -- regular bearish div min
const WT_DIV_OS_LEVEL = -65; // live-confirmed (wtDivOSLevel, in_20) -- regular bullish div min
// Hidden divergence, live-confirmed showHiddenDiv_nl=true (in_18): uses the NO-LIMIT fractal variant
// (topLimit/botLimit ignored), matching f_findDivs(wt2, 0, 0, false) in the source.

// A "zone" here doesn't expire on its own the way Divergence-for-Many's promoted levels do (Cipher
// B has no analogous expiry mechanism) -- so expiresBarIdx/expiresTime stay null forever, and
// status is always "active". touches.js only uses expiresBarIdx to bound its forward scan, so null
// correctly means "scan to the end of the series," which is what we want here.
const NO_EXPIRY = { expiresBarIdx: null, expiresTime: null, status: "active" };

function ema(values, length) {
  const out = new Array(values.length).fill(NaN);
  const alpha = 2 / (length + 1);
  let prev = NaN;
  for (let i = 0; i < values.length; i++) {
    const v = values[i];
    if (Number.isNaN(v)) { out[i] = NaN; continue; }
    prev = Number.isNaN(prev) ? v : alpha * v + (1 - alpha) * prev;
    out[i] = prev;
  }
  return out;
}

function sma(values, length) {
  const out = new Array(values.length).fill(NaN);
  for (let i = length - 1; i < values.length; i++) {
    let sum = 0, bad = false;
    for (let j = i - length + 1; j <= i; j++) {
      if (Number.isNaN(values[j])) { bad = true; break; }
      sum += values[j];
    }
    out[i] = bad ? NaN : sum / length;
  }
  return out;
}

// f_wavetrend(hlc3, 9, 12, 3, current-tf): esa=ema(src,chlen); de=ema(abs(src-esa),chlen);
// ci=(src-esa)/(0.015*de); wt1=ema(ci,avg); wt2=sma(wt1,malen). security(...,timeframe.period,...)
// on the CURRENT chart timeframe is a no-op for historical (closed-bar) computation, so it's
// dropped here.
export function computeWaveTrend(candles) {
  const hlc3 = candles.map((c) => (c.h + c.l + c.c) / 3);
  const esa = ema(hlc3, WT_CHANNEL_LEN);
  const absDiff = hlc3.map((v, i) => Math.abs(v - esa[i]));
  const de = ema(absDiff, WT_CHANNEL_LEN);
  const ci = hlc3.map((v, i) => (de[i] === 0 || Number.isNaN(de[i]) ? NaN : (v - esa[i]) / (0.015 * de[i])));
  const wt1 = ema(ci, WT_AVERAGE_LEN);
  const wt2 = sma(wt1, WT_MA_LEN);
  return { wt1, wt2 };
}

// f_findDivs(src, topLimit, botLimit, useLimits), generalized over `src` (wt2 here) plus the
// candle highs/lows needed for the price-side comparison. Returns per-bar-i signal flags for the
// fractal CENTERED at i-2 (confirmed once bars i-1 and i are known) -- matches the Pine offset=-2
// rendering exactly. See header comment in the calling code for the valuewhen([2]) derivation.
function findDivergences(src, highs, lows, topLimit, botLimit, useLimits) {
  const n = src.length;
  const bearSignal = new Array(n).fill(false);
  const bullSignal = new Array(n).fill(false);
  const bearDivHidden = new Array(n).fill(false);
  const bullDivHidden = new Array(n).fill(false);

  // Running valuewhen(cond, source, 0) state -- "most recent bar (<= current) where cond was true,
  // carrying that bar's `source` value forward." Two separate trackers per fractal type (top/bot),
  // one for the oscillator value, one for the corresponding price extreme.
  let vwTopOsc = NaN, vwTopPrice = NaN;
  let vwBotOsc = NaN, vwBotPrice = NaN;
  // Pine's `[2]` on the whole valuewhen(...) expression reads that running state as it stood 2
  // bars ago -- i.e., we need a 2-bar-delayed view of vwTopOsc/vwTopPrice/vwBotOsc/vwBotPrice.
  const vwTopOscHist = [], vwTopPriceHist = [], vwBotOscHist = [], vwBotPriceHist = [];

  for (let i = 0; i < n; i++) {
    // fractalTop/fractalBot centered at i-2, need i-4..i all in range.
    let fractalTopVal = NaN, fractalBotVal = NaN;
    if (i >= 4) {
      const s0 = src[i], s1 = src[i - 1], s2 = src[i - 2], s3 = src[i - 3], s4 = src[i - 4];
      if (![s0, s1, s2, s3, s4].some(Number.isNaN)) {
        const isTop = s4 < s2 && s3 < s2 && s2 > s1 && s2 > s0;
        const isBot = s4 > s2 && s3 > s2 && s2 < s1 && s2 < s0;
        if (isTop && (!useLimits || s2 >= topLimit)) fractalTopVal = s2;
        if (isBot && (!useLimits || s2 <= botLimit)) fractalBotVal = s2;
      }
    }
    const highAt2 = i >= 2 ? highs[i - 2] : NaN;
    const lowAt2 = i >= 2 ? lows[i - 2] : NaN;

    if (!Number.isNaN(fractalTopVal)) { vwTopOsc = fractalTopVal; vwTopPrice = highAt2; }
    if (!Number.isNaN(fractalBotVal)) { vwBotOsc = fractalBotVal; vwBotPrice = lowAt2; }
    vwTopOscHist.push(vwTopOsc);
    vwTopPriceHist.push(vwTopPrice);
    vwBotOscHist.push(vwBotOsc);
    vwBotPriceHist.push(vwBotPrice);

    if (i >= 2) {
      const highPrev = vwTopOscHist[i - 2]; // "highPrev" in Pine (oscillator value of the PRIOR top fractal)
      const highPrice = vwTopPriceHist[i - 2]; // prior top fractal's actual price high
      const lowPrev = vwBotOscHist[i - 2];
      const lowPrice = vwBotPriceHist[i - 2];

      if (!Number.isNaN(fractalTopVal) && !Number.isNaN(highPrev) && !Number.isNaN(highPrice)) {
        if (highAt2 > highPrice && fractalTopVal < highPrev) bearSignal[i] = true;
        if (highAt2 < highPrice && fractalTopVal > highPrev) bearDivHidden[i] = true;
      }
      if (!Number.isNaN(fractalBotVal) && !Number.isNaN(lowPrev) && !Number.isNaN(lowPrice)) {
        if (lowAt2 < lowPrice && fractalBotVal > lowPrev) bullSignal[i] = true;
        if (lowAt2 > lowPrice && fractalBotVal < lowPrev) bullDivHidden[i] = true;
      }
    }
  }
  return { bearSignal, bullSignal, bearDivHidden, bullDivHidden };
}

// Public: compute WT regular + hidden divergence zones over a full candle series.
// candles: [{t,o,h,l,c,v}, ...] chronological. Returns { zones } -- shaped for touches.js/
// confluence.js reuse. Each zone's `kind` ('regular'|'hidden') and `price` (the actual high/low at
// the pivot bar, i-2, matching what a trader would read off the chart as "the divergence level")
// are the two fields specific to this indicator; everything else matches divergence-for-many's
// zone shape so the shared machinery works unmodified.
export function computeVmcCipherB(candles) {
  const { wt2 } = computeWaveTrend(candles);
  const highs = candles.map((c) => c.h);
  const lows = candles.map((c) => c.l);

  const regular = findDivergences(wt2, highs, lows, WT_DIV_OB_LEVEL, WT_DIV_OS_LEVEL, true);
  const hidden = findDivergences(wt2, highs, lows, 0, 0, false); // showHiddenDiv_nl=true live -> no-limit variant

  const zones = [];
  const n = candles.length;
  for (let i = 0; i < n; i++) {
    if (regular.bearSignal[i]) zones.push(makeZone("bearish", "regular", highs[i - 2], i, candles));
    if (regular.bullSignal[i]) zones.push(makeZone("bullish", "regular", lows[i - 2], i, candles));
    if (hidden.bearDivHidden[i]) zones.push(makeZone("bearish", "hidden", highs[i - 2], i, candles));
    if (hidden.bullDivHidden[i]) zones.push(makeZone("bullish", "hidden", lows[i - 2], i, candles));
  }
  return { zones };
}

function makeZone(side, kind, price, confirmedBarIdx, candles) {
  return {
    side,
    kind,
    price,
    createdBarIdx: confirmedBarIdx - 2, // the actual pivot bar (i-2), matches Pine's offset=-2 rendering
    createdTime: candles[confirmedBarIdx - 2].t,
    confirmedBarIdx,
    confirmedTime: candles[confirmedBarIdx].t,
    atrAtCreation: null,
    ...NO_EXPIRY,
  };
}
