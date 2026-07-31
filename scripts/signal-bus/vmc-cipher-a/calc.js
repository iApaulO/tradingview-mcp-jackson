// Faithful JS port of pine/vmc-cipher-a-ribbon.pine's `yellowCross` ("yellow X" in the video, "Intro
// to Market Cipher," crypto_face, youtu.be/bxkm4Kjubqs) -- built 2026-07-31 for Phase 4 of the
// approved video-driven plan: does a same-bar yellowCross veto a Cipher B buySignal/sellSignal the
// way the video claims ("if you see a yellow X on the same candle as a green dot, the yellow X
// takes precedent... stay out or short")?
//
// Cipher A is a FULLY SEPARATE script from Cipher B with its own independent WT/RSI/MFI
// calculation -- confirmed by reading both sources side by side, not assumed. Two real differences
// from Cipher B, both live-verified (entity hVarCL, "VuManChu Cipher A" -- every one of 26 inputs
// matches the Pine author's documented defaults exactly, no deviation to account for this time):
//   - wtAverageLen = 13 here (Cipher B uses 12), osLevel3 = -80 here (Cipher B uses -75).
//   - f_rsimfi does NOT subtract rsiMFIPosY here, unlike Cipher B's version (see
//     vmc-cipher-b/calc.js's computeMfi header note) -- this port omits the subtraction to match.
//
// yellowCross = redDiamond and wt2 < 45 and wt2 > osLevel3 and rsi < 30 and rsi > 15 and rsiMFI < -5
//   where redDiamond = wtCross and wtCrossDown (Cipher A's OWN wt1/wt2, not Cipher B's).
// A precise, fully mechanical composite condition -- not a fuzzy visual pattern, despite how the
// video describes it.

const WT_CHANNEL_LEN = 9; // live-confirmed (in_0)
const WT_AVERAGE_LEN = 13; // live-confirmed (in_1) -- differs from Cipher B's 12
const WT_MA_LEN = 3; // live-confirmed (in_3)
const OS_LEVEL3 = -80; // live-confirmed (in_9) -- differs from Cipher B's -75
const RSI_LEN = 14; // live-confirmed (in_20)
const MFI_PERIOD = 60; // live-confirmed (in_24)
const MFI_MULTIPLIER = 150; // live-confirmed (in_25)
const EMA2_LEN = 11; // live-confirmed (in_12) -- longEma/shortEma crossover, the video's OTHER "green dot"
const EMA8_LEN = 34; // live-confirmed (in_18)

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

// Wilder's RSI, same implementation convention as this project's other RSI ports
// (scripts/signal-bus/divergence-for-many/calc.js).
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

// Exported for Phase 8 (multi-indicator confluence): lets a caller read Cipher A's OWN wt2 at an
// arbitrary bar, e.g. to check whether it's ALSO extreme at the same moment Cipher B's signal fires.
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

// f_rsimfi(60, 150, current-tf), Cipher A's version -- NO rsiMFIPosY subtraction (confirmed by
// reading the source; a real, deliberate difference from Cipher B's otherwise identical function).
function computeMfi(candles) {
  const raw = candles.map((c) => (c.h === c.l ? 0 : ((c.c - c.o) / (c.h - c.l)) * MFI_MULTIPLIER));
  return sma(raw, MFI_PERIOD);
}

// Public: yellowCross events over a full candle series. Returns { events }: [{ barIdx, time }].
// Side is intentionally omitted -- yellowCross is exclusively the bearish/redDiamond-gated
// condition in the source (there's no symmetric "yellow cross" for the bullish side in Cipher A),
// so every event here is a same-direction (bearish) warning regardless of which side it's checked
// against downstream.
export function computeYellowCross(candles) {
  const { wt1, wt2 } = computeWaveTrend(candles);
  const closes = candles.map((c) => c.c);
  const rsiSeries = rsi(closes, RSI_LEN);
  const mfiSeries = computeMfi(candles);
  const n = candles.length;
  const events = [];

  for (let i = 1; i < n; i++) {
    if ([wt1[i], wt2[i], wt1[i - 1], wt2[i - 1], rsiSeries[i], mfiSeries[i]].some(Number.isNaN)) continue;
    const diffPrev = wt1[i - 1] - wt2[i - 1];
    const diffNow = wt1[i] - wt2[i];
    const wtCross = (diffPrev <= 0 && diffNow > 0) || (diffPrev >= 0 && diffNow < 0); // cross(wt1,wt2), either direction
    const wtCrossDown = diffNow >= 0; // wt2 - wt1 >= 0, post-cross state check (matches Pine's own definition, not just "diffNow < 0")
    const redDiamond = wtCross && wtCrossDown;
    if (!redDiamond) continue;
    const yellowCross = wt2[i] < 45 && wt2[i] > OS_LEVEL3 && rsiSeries[i] < 30 && rsiSeries[i] > 15 && mfiSeries[i] < -5;
    if (yellowCross) events.push({ barIdx: i, time: candles[i].t });
  }
  return { events };
}

// Phase 6 of the video-driven plan: Cipher A's OWN "green dot" -- `longEma = crossover(ema2, ema8)`
// / `shortEma = crossover(ema8, ema2)`, a completely separate mechanism from Cipher B's buySignal
// (WT cross at oversold). Confirmed by a full transcript reread (§25) that the video treats these
// as two distinct signals used differently: "I prefer Cipher B green dots for entries, I use the
// green dots on Cipher A as more of a confirmation" (9:41). This function is that confirmation
// signal -- tests whether it strengthens a Cipher B buySignal/sellSignal fired on the SAME bar/
// timeframe, the one piece of the video's model never built until now.
export function computeGreenDot(candles) {
  const closes = candles.map((c) => c.c);
  const ema2 = ema(closes, EMA2_LEN);
  const ema8 = ema(closes, EMA8_LEN);
  const n = candles.length;
  const events = [];
  for (let i = 1; i < n; i++) {
    if ([ema2[i], ema8[i], ema2[i - 1], ema8[i - 1]].some(Number.isNaN)) continue;
    const crossedUp = ema2[i - 1] <= ema8[i - 1] && ema2[i] > ema8[i]; // crossover(ema2, ema8) -- longEma
    const crossedDown = ema8[i - 1] <= ema2[i - 1] && ema8[i] > ema2[i]; // crossover(ema8, ema2) -- shortEma
    if (crossedUp) events.push({ side: "bullish", barIdx: i, time: candles[i].t });
    if (crossedDown) events.push({ side: "bearish", barIdx: i, time: candles[i].t });
  }
  return { events };
}

// Companion to computeGreenDot(): the ongoing REGIME (which EMA is on top right now), not the
// crossover event itself. Added after computeGreenDot's "recent crossover event" test came back
// thin and weak (a crossover is rare and, once it happens, the market usually stays in that regime
// for a long time -- so "did a crossover happen in the last N bars" mostly says "no," while "which
// side is the market on right now" is answerable on almost every bar). Matches the pattern already
// seen twice today (divergence confirmation-chasing, same-bar MFI): testing for a recent EVENT is
// often the wrong frame when the underlying idea is a slower-moving STATE.
export function computeEmaRegime(candles) {
  const closes = candles.map((c) => c.c);
  const ema2 = ema(closes, EMA2_LEN);
  const ema8 = ema(closes, EMA8_LEN);
  return closes.map((_, i) => (Number.isNaN(ema2[i]) || Number.isNaN(ema8[i]) ? null : ema2[i] > ema8[i] ? "bullish" : "bearish"));
}
