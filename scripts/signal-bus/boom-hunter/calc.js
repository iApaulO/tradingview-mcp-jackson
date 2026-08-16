// Faithful JS port of pine/boom-hunter-pro.pine's actual TRADEABLE signals, now extended (2026-08-09)
// to cover the "dead code" per iapaulo's request -- conditions computed in source but never wired to
// a plotshape(): enter ("q1 crosses trigger below a long-horizon LSMA of a separate WT system"),
// enter2 ("Boom!", plotshape literally commented out at source line 387), enter4 (a fifth Long
// variant, computed, never referenced by any plotshape/alertcondition). Real code, just not
// user-visible in the live indicator -- being evaluated here for whether it deserves to be.
//
// Still skips EOT3 (Quotient5/6) -- confirmed it feeds ONLY the two Exit Warning circles, nothing
// tradeable in either the visible or dead-code set.
//
// bearish_continuation is NOT ported from source -- there is no bearish mirror of the Continuation
// signal in boom-hunter-pro.pine. dbreak2/ubreak2 ARE computed (source lines 354-364) but never
// consumed by any plotshape or further logic -- genuinely abandoned, not a hidden finished signal,
// and their own shape doesn't cleanly mirror the working bullish version (both use the same tight
// 1/1 pivot, where the bullish version deliberately uses an asymmetric 5/5-break/1/1-reclaim split).
// Rather than guess at unfinished intent, bearish_continuation here is a NEW signal constructed by
// mirroring the VALIDATED bullish logic exactly (swap crossover<->crossunder, highUsePivot<->
// lowUsePivot, same 5/5 and 1/1 pivot lengths) -- flagged with its own event type so it is never
// confused with something veryfid actually shipped.
//
// Two Ehlers-style oscillator pipelines (EOT1, EOT2), each: highpass filter -> SuperSmoother filter
// -> fast-attack/slow-decay Peak normalizer -> Quotient. EOT1 (LPPeriod=6) drives q1, the main line
// pivots/breaks are tracked against. EOT2 (LPPeriod2=27, K12=0.8) drives Quotient3, gating several
// Long variants and the Break/short signal.
//
// Validated 2026-08-08 against the real live instance iapaulo pointed at directly: BITUNIX:BTCUSDT.P
// 4h, 24-26jun26. Computed q1 = -10.00 at 2026-06-24 16:00 (first dip) vs q1 = +19.53 at
// 2026-06-25 12:00 (price's actual lowest low in the window, 58,000 vs 59,010.7 at the first dip) --
// a real bullish divergence between price and this oscillator, matching what was seen live before
// this file existed. Continuation signal fires ~30jun/1jul, also matching the live read.
//
// pivothigh/pivotlow ported with the same care as Cipher B's fractal offset: Pine's
// `fixnan(ta.pivothigh(src,left,right))[1]` means (1) a pivot is CONFIRMED `right` bars after the
// actual extreme, (2) fixnan carries the last confirmed pivot value forward through bars with no new
// pivot, (3) the whole series is then shifted one MORE bar to avoid using a pivot on the very bar it
// confirms. All three steps reproduced explicitly, not approximated.

const PI = Math.PI;
const ALPHA1 = (Math.cos(0.707 * 2 * PI / 100) + Math.sin(0.707 * 2 * PI / 100) - 1) / Math.cos(0.707 * 2 * PI / 100);

function highpass(candles, alpha) {
  const n = candles.length;
  const HP = new Array(n).fill(0);
  for (let i = 0; i < n; i++) {
    const close = candles[i].c;
    const close1 = i >= 1 ? candles[i - 1].c : close;
    const close2 = i >= 2 ? candles[i - 2].c : close;
    const HP1 = i >= 1 ? HP[i - 1] : 0;
    const HP2 = i >= 2 ? HP[i - 2] : 0;
    HP[i] = (1 - alpha / 2) * (1 - alpha / 2) * (close - 2 * close1 + close2) + 2 * (1 - alpha) * HP1 - (1 - alpha) * (1 - alpha) * HP2;
  }
  return HP;
}

// EOT1/EOT2 share this exact SuperSmoother + Peak-normalize shape; EOT3 (unported) uses a different
// HP formula ((1-a/3)*(1-a/2) instead of (1-a/2)^2) so this helper is NOT reused for it, deliberately.
function superSmootherAndNormalize(HP, lpPeriod) {
  const n = HP.length;
  const a1 = Math.exp(-1.414 * PI / lpPeriod);
  const b1 = 2 * a1 * Math.cos(1.414 * PI / lpPeriod);
  const c2 = b1, c3 = -a1 * a1, c1 = 1 - c2 - c3;

  const Filt = new Array(n).fill(0);
  const Peak = new Array(n).fill(0);
  const X = new Array(n).fill(0);
  for (let i = 0; i < n; i++) {
    const Filt1 = i >= 1 ? Filt[i - 1] : 0;
    const Filt2 = i >= 2 ? Filt[i - 2] : 0;
    const HPprev = i >= 1 ? HP[i - 1] : 0;
    Filt[i] = c1 * (HP[i] + HPprev) / 2 + c2 * Filt1 + c3 * Filt2;

    const Peak1 = i >= 1 ? Peak[i - 1] : 0;
    Peak[i] = 0.991 * Peak1;
    if (Math.abs(Filt[i]) > Peak[i]) Peak[i] = Math.abs(Filt[i]);

    X[i] = Peak[i] !== 0 ? Filt[i] / Peak[i] : (i >= 1 ? X[i - 1] : 0);
  }
  return X;
}

function quotient(X, K) {
  return X.map((x) => (x + K) / (K * x + 1));
}

// Pine ta.pivothigh/pivotlow: a pivot at bar (i-right) is confirmed at bar i once `right` future bars
// are known, and only if it's the strict extreme over [i-right-left, i-right+right].
function rawPivot(src, left, right, isHigh) {
  const n = src.length;
  const out = new Array(n).fill(NaN);
  for (let i = left + right; i < n; i++) {
    const pivotIdx = i - right;
    const pivotVal = src[pivotIdx];
    if (Number.isNaN(pivotVal)) continue;
    let isPivot = true;
    for (let k = pivotIdx - left; k <= pivotIdx + right; k++) {
      if (k < 0 || k >= n || k === pivotIdx) continue;
      if (isHigh ? !(pivotVal > src[k]) : !(pivotVal < src[k])) { isPivot = false; break; }
    }
    if (isPivot) out[i] = pivotVal;
  }
  return out;
}
function fixnanSeries(raw) {
  const out = new Array(raw.length).fill(NaN);
  let last = NaN;
  for (let i = 0; i < raw.length; i++) {
    if (!Number.isNaN(raw[i])) last = raw[i];
    out[i] = last;
  }
  return out;
}
function shiftOne(series) {
  const out = new Array(series.length).fill(NaN);
  for (let i = 1; i < series.length; i++) out[i] = series[i - 1];
  return out;
}
function fixnanShiftedPivot(src, left, right, isHigh) {
  return shiftOne(fixnanSeries(rawPivot(src, left, right, isHigh)));
}

function sma(series, len) {
  const out = new Array(series.length).fill(NaN);
  let sum = 0;
  for (let i = 0; i < series.length; i++) {
    sum += series[i];
    if (i >= len) sum -= series[i - len];
    if (i >= len - 1) out[i] = sum / len;
  }
  return out;
}

function crossover(a, b, i) { return i >= 1 && a[i - 1] <= b[i - 1] && a[i] > b[i]; }
function crossunder(a, b, i) { return i >= 1 && a[i - 1] >= b[i - 1] && a[i] < b[i]; }
function crossoverConst(a, c, i) { return i >= 1 && a[i - 1] <= c && a[i] > c; }
function crossunderConst(a, c, i) { return i >= 1 && a[i - 1] >= c && a[i] < c; }

// Below: the separate WT/LSMA system, ported ONLY because `enter` (dead code) depends on it via
// `lsma`. Same ema() shape already validated in cipher-b/calc.js, reused for consistency.
// FIXED for this file's usage: cipher-b/calc.js's original always seeds from vals[0] on real price
// data, which is never NaN there. tci()'s ratio hits an exact 0/0 = NaN at bar 0 by construction
// (diff[0] and emaAbsDiff[0] are both 0), and an unguarded recursive EMA seeded with NaN never
// recovers -- every subsequent bar is NaN*k + NaN*(1-k) = NaN forever. Guarded here to skip NaN
// inputs until a real seed is found, rather than poisoning the whole series from one bad bar.
function ema(vals, len) {
  const k = 2 / (len + 1);
  const out = new Array(vals.length);
  let prev;
  for (let i = 0; i < vals.length; i++) {
    if (Number.isNaN(vals[i])) { out[i] = prev; continue; }
    prev = prev === undefined ? vals[i] : vals[i] * k + prev * (1 - k);
    out[i] = prev;
  }
  return out;
}
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
// Pine ta.linreg(source, length, offset): least-squares fit over the trailing `length` bars,
// evaluated at x=(length-1-offset). O(length) per bar -- acceptable at this project's scale (already
// proven on 5m's 939k candles elsewhere in this file).
function linreg(series, length, offset) {
  const out = new Array(series.length).fill(NaN);
  for (let i = length - 1; i < series.length; i++) {
    let sumX = 0, sumY = 0, sumXY = 0, sumX2 = 0;
    for (let j = 0; j < length; j++) {
      const y = series[i - length + 1 + j];
      sumX += j; sumY += y; sumXY += j * y; sumX2 += j * j;
    }
    const denom = length * sumX2 - sumX * sumX;
    const slope = denom === 0 ? 0 : (length * sumXY - sumX * sumY) / denom;
    const intercept = (sumY - slope * sumX) / length;
    out[i] = intercept + slope * ((length - 1) - offset);
  }
  return out;
}
function tci(src, n1, n2) {
  const emaSrc = ema(src, n1);
  const diff = src.map((v, i) => v - emaSrc[i]);
  const absDiff = diff.map(Math.abs);
  const emaAbsDiff = ema(absDiff, n1);
  const ratio = diff.map((v, i) => v / (0.025 * emaAbsDiff[i]));
  return ema(ratio, n2).map((v) => v + 50);
}
// Literal port of source's mf(): sums volume*RAW-SOURCE-VALUE (not volume*change) gated by the
// sign of the bar-to-bar change -- not a textbook Money Flow Index, reproduced exactly as coded.
function moneyFlow(src, candles, n3) {
  const n = src.length;
  const out = new Array(n).fill(NaN);
  for (let i = n3; i < n; i++) {
    let upSum = 0, downSum = 0;
    for (let j = i - n3 + 1; j <= i; j++) {
      const change = src[j] - src[j - 1];
      if (change > 0) upSum += candles[j].v * src[j];
      if (change < 0) downSum += candles[j].v * src[j];
    }
    out[i] = 100 - 100 / (1 + upSum / downSum);
  }
  return out;
}
function tradition(src, candles, n1, n2, n3) {
  const tciVal = tci(src, n1, n2);
  const mfVal = moneyFlow(src, candles, n3);
  const rsiVal = rsiWilder(src, n3);
  return src.map((_, i) => (tciVal[i] + mfVal[i] + rsiVal[i]) / 3);
}

export function computeBoomHunter(candles) {
  const n = candles.length;

  // EOT1 (main oscillator, drives q1)
  const HP1 = highpass(candles, ALPHA1);
  const X1 = superSmootherAndNormalize(HP1, 6);
  const Quotient1 = quotient(X1, 0);
  const Quotient2 = quotient(X1, 0.3);
  const q1 = Quotient1.map((v) => v * 60 + 50);
  const trigger = sma(q1, 2);

  // EOT2 (red wave, drives Quotient3 -- gates several Long variants + Break)
  const HP2 = highpass(candles, ALPHA1); // same alpha formula, independent recursive state via its own HP array
  const X2 = superSmootherAndNormalize(HP2, 27);
  const Quotient3 = quotient(X2, 0.8);
  // Quotient4 / q4 added 2026-08-16, closing the gap #146 identified and #153 re-confirmed. Every
  // other EOT exposes BOTH halves of its pair (Quotient1/2, Quotient5/6) and EOT2 exposed only the
  // first, so the red wave was half-implemented. Source: line 151 `Quotient4 := (X2 + K22) / (K22 *
  // X2 + 1)` with K22 = 0.3 (line 33), and line 237 `q4 = Quotient4 * esize + ey` with esize = 60,
  // ey = 50 -- the same scaling every other q line uses. Note K22 = 0.3 is identical to EOT1's
  // K2 = 0.3, so Quotient4 is to Quotient3 exactly what Quotient2 is to Quotient1.
  // q3 is exposed alongside it because the pair is drawn as a FILLED BAND in the source (lines
  // 238-240, both red, fill between them) -- the band's WIDTH is q3-q4 and is only computable with
  // both, which is the form iapaulo's "sharp tips versus flat" question is actually about.
  const Quotient4 = quotient(X2, 0.3);
  const q3 = Quotient3.map((v) => v * 60 + 50);
  const q4 = Quotient4.map((v) => v * 60 + 50);

  // EOT3 ("Yellow Line" per its own input group name), ported 2026-08-09 -- iapaulo asked directly
  // about the yellow (Quotient5) / blue (Quotient6, "Downward Boom Line") pair after noticing a live
  // pattern (yellow line bottoming without an accompanying Long flag). Previously left unported on
  // the assumption it only feeds the two Exit Warning circles -- still true for what it's WIRED to,
  // but that doesn't mean the raw lines have no information of their own, which is the actual
  // question now being tested. Genuinely different highpass formula from EOT1/EOT2 -- confirmed from
  // source (line 170): `(1 - alpha/3) * (1 - alpha/2)`, not the squared `(1 - alpha/2)^2` the other
  // two pipelines use -- so highpassAsymmetric() below is NOT a copy-paste of highpass(), it's a
  // distinct formula. K13/K33: live indicator settings confirmed via data_get_indicator (2026-08-09)
  // -- "Square Line?" (`square`) is TRUE, matching its Pine default, which overrides the raw K1 input
  // (0.99) to 0.9999 (and K33 = -K13 = -0.9999) per source lines 56-59. Using the overridden values,
  // not the naive input.float default, since that's what's actually live.
  function highpassAsymmetric(candles, alpha) {
    const n = candles.length;
    const HP = new Array(n).fill(0);
    for (let i = 0; i < n; i++) {
      const close = candles[i].c;
      const close1 = i >= 1 ? candles[i - 1].c : close;
      const close2 = i >= 2 ? candles[i - 2].c : close;
      const HP1 = i >= 1 ? HP[i - 1] : 0;
      const HP2 = i >= 2 ? HP[i - 2] : 0;
      HP[i] = (1 - alpha / 3) * (1 - alpha / 2) * (close - 2 * close1 + close2) + 2 * (1 - alpha) * HP1 - (1 - alpha) * (1 - alpha) * HP2;
    }
    return HP;
  }
  const HP3 = highpassAsymmetric(candles, ALPHA1); // alpha1333 in source uses the identical fixed-100-period formula as ALPHA1
  const X3 = superSmootherAndNormalize(HP3, 11); // LPPeriod3 = 11 (source default, confirmed live)
  const K13 = 0.9999, K33 = -0.9999; // square=true override, confirmed live -- NOT the raw 0.99 default
  const q5 = quotient(X3, K13).map((v) => v * 60 + 50); // esize2=60, ey2=50, same scaling as q1/trigger
  const q6 = quotient(X3, K33).map((v) => v * 60 + 50);

  // Pivots of q1 itself -- what dbreak/ubreak and Continuation are tracked against.
  const highUsePivot = fixnanShiftedPivot(q1, 1, 1, true);
  const lowUsePivot = fixnanShiftedPivot(q1, 5, 5, false);
  const lowUsePivot2 = fixnanShiftedPivot(q1, 1, 1, false);
  const highUsePivot2 = fixnanShiftedPivot(q1, 1, 1, true); // unused in source too (dbreak2/ubreak2 dead), kept for parity
  // NOT from source -- the 5/5 high pivot bearish_continuation needs, mirroring lowUsePivot exactly.
  const highUsePivot5 = fixnanShiftedPivot(q1, 5, 5, true);

  // WT/LSMA system, ported only for `enter` (dead code). n1=9,n2=6,n3=3,n4=21,lsmaline=200 (source defaults).
  const hlc3 = candles.map((c) => (c.h + c.l + c.c) / 3);
  const wt1 = tradition(hlc3, candles, 9, 6, 3);
  const wt3 = linreg(wt1, 21, 0);
  const lsma = linreg(wt3, 200, 0);

  const events = [];
  let dbreak = 0, ubreak = 0, cont = 0, cont2 = 0;
  let dbreakBear = 0, ubreakBear = 0; // NOT from source -- bearish_continuation's own counters

  for (let i = 0; i < n; i++) {
    const entryCond = crossunderConst(Quotient2, -0.9, i); // Pine's `entry` -- resets break counters
    if (!Number.isNaN(lowUsePivot[i]) && crossunder(q1, lowUsePivot, i)) dbreak++;
    if (entryCond) { dbreak = 0; ubreak = 0; cont = 0; cont2 = 0; }

    if (!Number.isNaN(highUsePivot[i]) && crossover(q1, highUsePivot, i) && dbreak >= 1) ubreak++;

    const continuation = !Number.isNaN(highUsePivot[i]) && crossover(q1, highUsePivot, i) && dbreak >= 1 && ubreak <= 1;
    if (continuation) {
      cont = 1;
      events.push({ type: "continuation", barIdx: i, time: candles[i].t, price: candles[i].c, q1: q1[i] });
    }

    // NOT from source -- constructed mirror of the above (see file header). Reset mirrors `entry`'s
    // extreme-oversold reset with an extreme-overbought one on Quotient2.
    const entryCondBear = crossoverConst(Quotient2, 0.9, i);
    if (!Number.isNaN(highUsePivot5[i]) && crossover(q1, highUsePivot5, i)) dbreakBear++;
    if (entryCondBear) { dbreakBear = 0; ubreakBear = 0; }
    if (!Number.isNaN(lowUsePivot2[i]) && crossunder(q1, lowUsePivot2, i) && dbreakBear >= 1) ubreakBear++;
    const bearishContinuation = !Number.isNaN(lowUsePivot2[i]) && crossunder(q1, lowUsePivot2, i) && dbreakBear >= 1 && ubreakBear <= 1;
    if (bearishContinuation) {
      events.push({ type: "bearish_continuation", barIdx: i, time: candles[i].t, price: candles[i].c, q1: q1[i] });
    }

    const warn2 = crossoverConst(Quotient1, -0.9, i);
    const warn3 = crossunderConst(Quotient1, 0.9, i);
    const co = crossover(q1, trigger, i);
    const cu = crossunder(q1, trigger, i);

    // barssince approximations done with explicit lookback scans (bounded, small windows -- matches
    // Pine's ta.barssince semantics: bars since the condition was last true, Infinity if never).
    const barsSince = (cond, maxLookback) => {
      for (let k = 0; k <= maxLookback && i - k >= 0; k++) if (cond(i - k)) return k;
      return Infinity;
    };

    const enter3 = Quotient3[i] <= -0.9 && co && barsSince((j) => crossoverConst(Quotient1, -0.9, j), 7) <= 7 && q1[i] <= 20 && barsSince((j) => crossoverConst(q1, 20, j), 21) <= 21;
    const enter5 = barsSince((j) => q1[j] <= 0 && crossunder(q1, trigger, j), 5) <= 5 && co;
    const enter6 = barsSince((j) => q1[j] <= 20 && crossunder(q1, trigger, j), 11) <= 11 && co && q1[i] <= 60;
    const enter7 = Quotient3[i] <= -0.9 && co;
    const senter3 = Quotient3[i] >= -0.9 && cu && barsSince((j) => crossunderConst(Quotient1, 0.9, j), 7) <= 7 && q1[i] >= 99 && barsSince((j) => crossoverConst(q1, 80, j), 21) <= 21;

    // Dead code, computed in source but never plotted (see file header) -- ported unmodified.
    const enter2 = Quotient1[i] <= -0.9 && co && barsSince((j) => crossoverConst(Quotient3, -0.9, j), 7) <= 7; // "Boom!" -- plotshape commented out at source line 387
    const enter4 = q1[i] <= 20 && barsSince((j) => crossover(q1, trigger, j) && q1[j] < 10, 5) <= 5 && co; // never referenced by any plotshape/alertcondition
    const enterDead = crossover(q1, trigger, i) && q1[i] < lsma[i]; // Pine's `enter` (distinct from `entry`) -- never referenced anywhere

    if (enter3) events.push({ type: "long_lime", barIdx: i, time: candles[i].t, price: candles[i].c, q1: q1[i] });
    if (enter5) events.push({ type: "long_blue", barIdx: i, time: candles[i].t, price: candles[i].c, q1: q1[i] });
    if (enter6) events.push({ type: "long_gray", barIdx: i, time: candles[i].t, price: candles[i].c, q1: q1[i] });
    if (enter7) events.push({ type: "long_yellow", barIdx: i, time: candles[i].t, price: candles[i].c, q1: q1[i] });
    if (senter3) events.push({ type: "break_short", barIdx: i, time: candles[i].t, price: candles[i].c, q1: q1[i] });
    if (enter2) events.push({ type: "boom_dead", barIdx: i, time: candles[i].t, price: candles[i].c, q1: q1[i] });
    // enter4 graduated 2026-08-09: robustly significant Long->OB->Continuation predictor (all 4
    // R/join-tightness cells p<0.05, see boom-hunter-full-signal-significance.js), wired into the
    // SMC order-block bus (build-boom-confluence.js) as a peer of the visible Long tiers -- renamed
    // from long_dead_enter4 since it's no longer dead code by any functional measure, just not
    // rendered on the live indicator (source's plotshape wiring is unchanged, still not user-visible
    // on the chart itself).
    if (enter4) events.push({ type: "long_enter4", barIdx: i, time: candles[i].t, price: candles[i].c, q1: q1[i] });
    if (enterDead) events.push({ type: "long_dead_enter", barIdx: i, time: candles[i].t, price: candles[i].c, q1: q1[i] });
  }

  // EOT3 down-episodes, persisted 2026-08-09 (previously recomputed fresh in every consuming
  // script -- eot3-bottom-flag-significance.js / eot3-bottom-flag-bias-significance.js, #66/#67).
  // Episode = q5 crossing down through 50 to the next crossover back above (or unresolved if q5
  // hasn't recovered by the end of available data -- excluded, matching #66's own exclusion rule).
  // "Flagged" = any of the five Long-tier events firing anywhere within the episode.
  const LONG_TIER_TYPES = new Set(["long_lime", "long_blue", "long_yellow", "long_gray", "long_enter4"]);
  const longFlagBarIdxs = events.filter((e) => LONG_TIER_TYPES.has(e.type)).map((e) => e.barIdx);
  const eot3Episodes = [];
  for (let i = 1; i < n; i++) {
    if (!crossunderConst(q5, 50, i)) continue;
    let endIdx = null;
    for (let j = i + 1; j < n; j++) { if (crossoverConst(q5, 50, j)) { endIdx = j; break; } }
    if (endIdx == null) continue; // ongoing, unresolved -- excluded (matches #66's rule)
    const hasFlag = longFlagBarIdxs.some((b) => b >= i && b <= endIdx);
    eot3Episodes.push({ startBarIdx: i, startTime: candles[i].t, endBarIdx: endIdx, endTime: candles[endIdx].t, hasFlag });
  }

  return { events, eot3Episodes, series: { q1, trigger, Quotient1, Quotient3, Quotient4, q3, q4, lsma, wt1, wt3, q5, q6 } };
}
