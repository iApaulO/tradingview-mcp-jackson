// Faithful JS port of pine/vmc-cipher-b-divergences.pine's WaveTrend regular + hidden divergence
// detection (f_wavetrend + f_findDivs applied to wt2), under the LIVE chart's actual settings --
// confirmed 2026-07-31 via a direct properties probe against the running indicator (entity Ilt4Lv,
// "VuManChu B Divergences"), NOT the Pine author's documented defaults. One setting genuinely
// deviates from the author's own default: wtShowHiddenDiv is live-set to TRUE (author's default is
// false) -- so hidden divergences are actually being shown on the chart, not just regular ones.
// Both are implemented here and tagged separately (kind: 'regular' | 'hidden') so they can be
// tested independently before any decision about pooling them.
//
// EXTENDED 2026-07-31 per the authoritative "Intro to Market Cipher" walkthrough (crypto_face,
// youtu.be/bxkm4Kjubqs), which this Pine source is a faithful clone of: the divergence signal above
// is NOT what that video's trading community treats as primary -- `buySignal`/`sellSignal` (the
// "green dot"/"red dot", WT1/WT2 cross at oversold/overbought, no divergence requirement) is
// called explicitly more reliable than divergence. `computeWtCrossSignals()` below adds that.
// Still NOT implemented: RSI divergence (rsiShowDiv=false live, confirmed off), Stoch divergence
// (stochShowDiv=false live, confirmed off), wtGoldBuy (the video itself warns against trading it:
// "DON'T BUY WHEN GOLD CIRCLE APPEARS"), Sommi flag/diamond (both false live, confirmed off).
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
const OB_LEVEL = 53; // live-confirmed (obLevel, in_10) -- buySignal/sellSignal's overbought threshold
const OS_LEVEL = -53; // live-confirmed (osLevel, in_13) -- buySignal/sellSignal's oversold threshold
const MFI_PERIOD = 60; // live-confirmed (rsiMFIperiod, in_25) -- matches Pine default, no deviation
const MFI_MULTIPLIER = 150; // live-confirmed (rsiMFIMultiplier, in_26)
const MFI_POS_Y = 2.5; // live-confirmed (rsiMFIPosY, in_27) -- subtracted inside Cipher B's own
// f_rsimfi (NOTE: Cipher A's f_rsimfi does NOT subtract this -- a real, confirmed difference
// between the two scripts' otherwise-identically-named MFI functions, relevant for Phase 4).
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

// f_rsimfi(60, 150, current-tf) - 2.5: sma(((close-open)/(high-low)) * 150, 60) - 2.5. The video's
// "environment" filter -- positive = bullish regime (long dips), negative = bearish (short peaks).
// Guards h===l (a literal doji with zero range, essentially never real market data but defensive
// against a divide-by-zero) by treating that bar's raw term as 0, matching how this project's other
// per-bar ratio indicators (e.g. divergence-for-many's CMF) handle the same edge case.
export function computeMfi(candles) {
  const raw = candles.map((c) => (c.h === c.l ? 0 : ((c.c - c.o) / (c.h - c.l)) * MFI_MULTIPLIER));
  const smoothed = sma(raw, MFI_PERIOD);
  return smoothed.map((v) => (Number.isNaN(v) ? NaN : v - MFI_POS_Y));
}

// buySignal = wtCross and wtCrossUp and wtOversold; sellSignal = wtCross and wtCrossDown and
// wtOverbought. Pine's wtCross = cross(wt1, wt2) (a crossing occurred, either direction, on THIS
// bar); wtCrossUp = wt2 - wt1 <= 0 (post-cross state: wt1 now >= wt2); wtCrossDown = wt2 - wt1 >= 0
// (wt1 now <= wt2). Implemented directly as a same-bar sign-change check on (wt1 - wt2), which is
// exactly what a "cross on this bar" means and avoids relying on Pine's own cross() being anything
// more subtle than that.
//
// Public: buySignal/sellSignal events over a full candle series -- the video's "green dot"/"red
// dot," called more reliable than divergence. Returns { events } shaped like divergence-for-many's
// zones (side, price, confirmedBarIdx, confirmedTime, no expiry) for the same reuse reasons as
// computeVmcCipherB -- `price` here is the close at the signal bar (there's no natural "level" the
// way a divergence pivot has one; the signal is a momentum event, not a price level).
export function computeWtCrossSignals(candles) {
  const { wt1, wt2 } = computeWaveTrend(candles);
  const mfi = computeMfi(candles); // attached per-event below for Phase 2's regime gate -- avoids every caller recomputing it separately
  const n = candles.length;
  const events = [];
  for (let i = 1; i < n; i++) {
    if (Number.isNaN(wt1[i]) || Number.isNaN(wt2[i]) || Number.isNaN(wt1[i - 1]) || Number.isNaN(wt2[i - 1])) continue;
    const diffPrev = wt1[i - 1] - wt2[i - 1];
    const diffNow = wt1[i] - wt2[i];
    const crossedUp = diffPrev <= 0 && diffNow > 0; // wt1 crossed above wt2
    const crossedDown = diffPrev >= 0 && diffNow < 0; // wt1 crossed below wt2
    if (crossedUp && wt2[i] <= OS_LEVEL) {
      events.push({ side: "bullish", signal: "buySignal", price: candles[i].c, confirmedBarIdx: i, confirmedTime: candles[i].t, mfi: mfi[i], ...NO_EXPIRY });
    }
    if (crossedDown && wt2[i] >= OB_LEVEL) {
      events.push({ side: "bearish", signal: "sellSignal", price: candles[i].c, confirmedBarIdx: i, confirmedTime: candles[i].t, mfi: mfi[i], ...NO_EXPIRY });
    }
  }
  return { events };
}

// Phase 5 of the video-driven plan: "Blue Wave" -- the video's own top-billed technique ("I have
// made more money off of these blue waves than any other indicator basically ever").
//
// CORRECTED 2026-07-31 after a thorough reread requested directly by iapaulo: the first version of
// this function tracked swings in wtVwap (wt1-wt2, the separate white "VWAP" area), which was
// wrong. At 20:04 the video explicitly names the oscillator behind Blue Wave: "the blue and light
// blue area... -100 to 100... thresholds at 60 and -60" -- checked against the actual Pine plot
// colors, WT1 is literally blue (#4994ec) and WT2 dark purple/navy (#1f1559, easily read as "light
// blue" against WT1 on screen), and 60/-60 matches `obLevel2`/`osLevel2` exactly. "Blue Wave" is
// WT1 itself, not a third derived series. Also missed the first time: "a nice healthy blue wave...
// that dips below or above this blue line marker" means the REFERENCE wave must clear the 60/-60
// threshold to count as a valid starting point -- not just any two consecutive same-direction
// swings, only ones where the first was a genuine extreme. Still a formalization of a qualitative
// visual description, not a literal port -- disclosed as such, same as before.
//
// A "wave" here is the segment between two consecutive wt1/wt2 crosses (the SAME crossing event
// used for buySignal/sellSignal and entry timing below) -- its magnitude is the largest |wt1|
// reached during that segment, its side is which line was on top (wt1>wt2 -> "pos"/blue-above,
// matching a bullish-momentum wave once it later crosses back down through the setup). Entry fires
// on the cross that ENDS a wave which is (a) smaller than the reference wave and (b) itself
// following a reference wave that cleared +/-60 -- "big wave, then a smaller one, enter on the
// cross back."
const BLUE_WAVE_THRESHOLD = 60; // live-confirmed obLevel2/osLevel2 (in_11/in_14), the "blue line marker"

export function computeBlueWave(candles) {
  const { wt1, wt2 } = computeWaveTrend(candles);
  const n = candles.length;

  const events = [];
  let currentSide = null; // "pos" (wt1 above wt2) | "neg"
  let currentExtreme = 0; // largest |wt1| seen during the current segment
  let prevPos = null, prevNeg = null; // { extreme } of the last COMPLETED wave on each side, only recorded if it cleared the threshold

  for (let i = 1; i < n; i++) {
    if (Number.isNaN(wt1[i]) || Number.isNaN(wt2[i]) || Number.isNaN(wt1[i - 1]) || Number.isNaN(wt2[i - 1])) continue;
    const diff = wt1[i] - wt2[i];
    const side = diff >= 0 ? "pos" : "neg";
    if (currentSide === null) { currentSide = side; currentExtreme = Math.abs(wt1[i]); continue; }
    if (side === currentSide) {
      currentExtreme = Math.max(currentExtreme, Math.abs(wt1[i]));
      continue;
    }
    // Side just flipped at bar i (a wt1/wt2 cross) -- the just-ended wave (on currentSide) is complete.
    const prevSameSide = currentSide === "pos" ? prevPos : prevNeg;
    if (prevSameSide != null && prevSameSide.extreme >= BLUE_WAVE_THRESHOLD && currentExtreme < prevSameSide.extreme) {
      // Reference wave cleared the "blue line marker," and this wave is shallower -> fires at the cross bar i.
      // A shrinking POSITIVE wave (wt1 was above wt2) implies the down-move is exhausting -> bearish next; a
      // shrinking NEGATIVE wave implies the down-thrust is exhausting -> bullish next (matches the video's
      // "cutting into the blue... signifies a bottom" for a shrinking wave on the low side).
      events.push({ side: currentSide === "neg" ? "bullish" : "bearish", price: candles[i].c, confirmedBarIdx: i, confirmedTime: candles[i].t, ...NO_EXPIRY });
    }
    // Only a wave that cleared the threshold becomes a valid future reference -- an already-shallow
    // wave shouldn't set a new, even-lower bar for "smaller than the last one."
    if (currentExtreme >= BLUE_WAVE_THRESHOLD) {
      if (currentSide === "pos") prevPos = { extreme: currentExtreme }; else prevNeg = { extreme: currentExtreme };
    }
    currentSide = side;
    currentExtreme = Math.abs(wt1[i]);
  }
  return { events };
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
