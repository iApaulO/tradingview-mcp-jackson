// Faithful JS port of pine/ict-concepts-luxalgo.pine's LOW-TIMEFRAME primitives:
// Displacement, Fair Value Gaps (FVG and IFVG variants), and Volume Imbalance.
//
// WHY LTF FIRST, AND WHY ONLY THESE THREE. Register #128 and #129 independently established --
// different statistic, different null family, different unit of observation -- that the
// exploitable information in this indicator family sits at the FINE end of the timeframe ladder.
// #128 (per-bar conditional MI, circular-shift null) found 4h/3h/2h carry no measurable
// conditional information while 1h/15m/5m clear at p=0.0000; #129 (trade-level, five nulls
// including block permutation) independently found 4h/2h never significant, 3h significant only
// under the weaker nulls, and 1h/15m/5m robust throughout. FVG, Volume Imbalance and Displacement
// are inherently low-timeframe objects. The HTF anchors in the same indicator (NWOG/NDOG, daily
// liquidity pools) are deliberately NOT ported yet -- that ordering is evidence-backed, not
// stylistic, and reverses the priority that was assumed before those two rows existed.
//
// RESEARCH CONFIGURATION -- deliberately NOT the live chart's defaults. The Pine indicator is a
// display tool and its defaults exist to keep a chart readable; a research bus needs the superset,
// with gating deferred to analysis time. This is the same pattern already applied twice in this
// project: hidden divergences are computed and tagged rather than gated (vmc-cipher-b/calc.js), and
// ORDER_BLOCK_MAX_TRACKED was raised from the live indicator's 100 to effectively unbounded for the
// historical build (smc/calc.js). Concretely, versus the Pine defaults:
//   * i_mode = 'Historical'. The Pine `per` gate is
//     `i_mode == 'Present' ? last_bar_index - bar_index <= 500 : true`, and FVG creation is gated
//     on it -- in Present mode the indicator computes NOTHING before the last 500 bars. Fatal for
//     a historical bus, so `per` is always true here.
//   * No display caps. Pine keeps only `visBxs` (default 2!) FVGs per side and `.delete()`s the
//     rest, and only checks the most recent `bxBack` (10) boxes for breaks. Both are display
//     conveniences that DESTROY state. Every zone is retained and every active zone is checked.
//   * Broken zones are retained with a lifecycle status rather than deleted, matching the
//     `status`/`mitigated_*` pattern already used in smc/store.js.
//   * BOTH the FVG and IFVG variants are computed and tagged by `kind`. They are mutually
//     exclusive in Pine (one input toggle) but there is no reason for a database to choose.
//
// LOOK-AHEAD. Every construct here is confirmed on the bar it is detected on and references only
// that bar and earlier ones. An FVG detected at bar i spans bars i-2..i and is knowable at i's
// close -- `createdBarIdx` is i, NOT i-2, even though the zone's geometry reaches back two bars.
// This project has shipped two real look-ahead bugs (1e64de8, and the #124 touch-refresh clock),
// both from exactly this kind of index confusion, so the origin/confirmation distinction is kept
// explicit throughout rather than left implicit in an offset.

// Pine: perc_Body = 0.36 (hardcoded there; the input is commented out in the source).
const PERC_BODY = 0.36;
// Pine: meanBody = ta.sma(body, len) where `len` is the MARKET STRUCTURES length input, default 5
// -- NOT the Order Blocks `length` input (default 10). The two are distinct in the source and it
// would be easy to bind the wrong one; displacement uses `len`.
const MEAN_BODY_LEN = 5;
const ATR_LEN = 10; // Pine: atr = ta.atr(10)

function sma(values, length) {
  const out = new Array(values.length).fill(NaN);
  let sum = 0;
  for (let i = 0; i < values.length; i++) {
    sum += values[i];
    if (i >= length) sum -= values[i - length];
    if (i >= length - 1) out[i] = sum / length;
  }
  return out;
}

function atrSeries(candles, length) {
  const tr = candles.map((c, i) => {
    if (i === 0) return c.h - c.l;
    const pc = candles[i - 1].c;
    return Math.max(c.h - c.l, Math.abs(c.h - pc), Math.abs(c.l - pc));
  });
  const out = new Array(candles.length).fill(NaN);
  if (candles.length < length) return out;
  let seed = 0;
  for (let i = 0; i < length; i++) seed += tr[i];
  out[length - 1] = seed / length;
  for (let i = length; i < candles.length; i++) out[i] = (out[i - 1] * (length - 1) + tr[i]) / length;
  return out;
}

// ── Displacement ────────────────────────────────────────────────────────────────────────────
// Pine:
//   L_body   = high - mx < body * perc_Body and mn - low < body * perc_Body
//   L_bodyUP = body > meanBody and L_body and close > open
//   L_bodyDN = body > meanBody and L_body and close < open
// i.e. a large-bodied candle with small wicks on BOTH sides relative to its own body. The wick
// test is two-sided in the source; a one-sided reading would admit long-tailed candles that the
// indicator excludes.
export function computeDisplacement(candles, meanBodyLen = MEAN_BODY_LEN) {
  const n = candles.length;
  const body = new Array(n);
  const mxArr = new Array(n), mnArr = new Array(n);
  for (let i = 0; i < n; i++) {
    const c = candles[i];
    mxArr[i] = Math.max(c.c, c.o);
    mnArr[i] = Math.min(c.c, c.o);
    body[i] = Math.abs(c.c - c.o);
  }
  const meanBody = sma(body, meanBodyLen);
  const atr = atrSeries(candles, ATR_LEN);

  const up = new Array(n).fill(false);
  const dn = new Array(n).fill(false);
  const events = [];
  for (let i = 0; i < n; i++) {
    if (!Number.isFinite(meanBody[i])) continue;
    const c = candles[i];
    const lBody = c.h - mxArr[i] < body[i] * PERC_BODY && mnArr[i] - c.l < body[i] * PERC_BODY;
    if (!lBody || !(body[i] > meanBody[i])) continue;
    if (c.c > c.o) up[i] = true;
    else if (c.c < c.o) dn[i] = true;
    else continue;
    events.push({
      side: up[i] ? "bullish" : "bearish",
      barIdx: i,
      time: c.t,
      price: c.c,
      body: body[i],
      meanBody: meanBody[i],
      // Strength relative to the recent body average -- this is the raw material for
      // EEH-CITI-1.0 §18's `displacement_strength`, kept as a ratio rather than a bucket so the
      // bucketing decision stays at analysis time.
      bodyRatio: body[i] / meanBody[i],
      bodyAtr: Number.isFinite(atr[i]) && atr[i] > 0 ? body[i] / atr[i] : null,
    });
  }
  return { events, up, dn, body, meanBody, mx: mxArr, mn: mnArr, atr };
}

// ── Fair Value Gap / Implied Fair Value Gap ─────────────────────────────────────────────────
// Pine:
//   imbalanceUP = L_bodyUP[1] and (FVG ? low  > high[2] : low  < high[2])
//   imbalanceDN = L_bodyDN[1] and (FVG ? high < low [2] : high > low [2])
// Note the [1] on the displacement test: the gap is confirmed on the bar AFTER the displacement
// candle, and the geometry reaches back to bar i-2. Detection bar is i.
//
// Box geometry, Pine `box.new(left, top, right, bottom)`:
//   bullish FVG : top = low(i),      bottom = high(i-2)
//   bullish IFVG: top = high(i-2),   bottom = low(i)
//   bearish FVG : top = low(i-2),    bottom = high(i)
//   bearish IFVG: top = high(i),     bottom = low(i-2)
// In every case the imbalance condition guarantees top > bottom.
//
// Consecutive-bar merge: when the previous bar also produced a same-side imbalance, Pine EXTENDS
// the existing box (`set_lefttop`/`set_rightbottom`) instead of creating a new one. Replicated,
// because without it a multi-bar displacement run would be counted as several separate zones.
export function computeFVG(candles, { mode = "fvg", displacement = null } = {}) {
  const disp = displacement || computeDisplacement(candles);
  const isFvg = mode === "fvg";
  const n = candles.length;
  const zones = [];

  const upActive = [], dnActive = []; // indexes into `zones`, newest last
  let prevUp = false, prevDn = false;

  for (let i = 2; i < n; i++) {
    const c = candles[i], c2 = candles[i - 2];
    const dispUp = disp.up[i - 1], dispDn = disp.dn[i - 1];

    const imbUp = dispUp && (isFvg ? c.l > c2.h : c.l < c2.h);
    const imbDn = dispDn && (isFvg ? c.h < c2.l : c.h > c2.l);

    if (imbUp) {
      const top = isFvg ? c.l : c2.h;
      const bottom = isFvg ? c2.h : c.l;
      if (prevUp && upActive.length) {
        const z = zones[upActive[upActive.length - 1]];
        z.top = top; z.bottom = bottom; z.mergedBars++;
      } else {
        zones.push(makeZone("bullish", mode, top, bottom, i, candles, disp));
        upActive.push(zones.length - 1);
      }
    }
    if (imbDn) {
      const top = isFvg ? c2.l : c.h;
      const bottom = isFvg ? c.h : c2.l;
      if (prevDn && dnActive.length) {
        const z = zones[dnActive[dnActive.length - 1]];
        z.top = top; z.bottom = bottom; z.mergedBars++;
      } else {
        zones.push(makeZone("bearish", mode, top, bottom, i, candles, disp));
        dnActive.push(zones.length - 1);
      }
    }
    prevUp = imbUp; prevDn = imbDn;

    // Break/penetration scan. Pine caps this at the most recent `bxBack` (10) boxes; here EVERY
    // active zone is checked, because a cap would silently mark old zones as permanently active.
    scanBreaks(upActive, zones, candles, i, "bullish");
    scanBreaks(dnActive, zones, candles, i, "bearish");
  }

  return { zones };
}

function makeZone(side, kind, top, bottom, barIdx, candles, disp) {
  const c = candles[barIdx];
  const atr = disp.atr[barIdx];
  return {
    side, kind, top, bottom,
    // Detection bar -- what is knowable at this bar's close. The zone's GEOMETRY spans
    // barIdx-2..barIdx, which is why originBarIdx is recorded separately; conflating the two is
    // how look-ahead enters a construct like this.
    createdBarIdx: barIdx,
    createdTime: c.t,
    originBarIdx: barIdx - 2,
    originTime: candles[barIdx - 2].t,
    size: top - bottom,
    sizeAtr: Number.isFinite(atr) && atr > 0 ? (top - bottom) / atr : null,
    // Strength of the displacement candle that produced this gap (bar barIdx-1).
    displacementRatio: disp.meanBody[barIdx - 1] > 0 ? disp.body[barIdx - 1] / disp.meanBody[barIdx - 1] : null,
    mergedBars: 1,
    status: "active",
    firstTouchBarIdx: null, firstTouchTime: null, // partial penetration (Pine: dashed border)
    brokenBarIdx: null, brokenTime: null,         // full traversal   (Pine: dotted + inactive)
    maxFillPct: 0,
  };
}

function scanBreaks(activeList, zones, candles, i, side) {
  const c = candles[i];
  for (let k = activeList.length - 1; k >= 0; k--) {
    const z = zones[activeList[k]];
    if (z.createdBarIdx === i) continue; // a zone cannot break on the bar that created it
    if (side === "bullish") {
      // Pine: low < top -> partial (dashed); low < bottom -> full break (dotted, active := false)
      if (c.l < z.top) {
        if (z.firstTouchBarIdx == null) { z.firstTouchBarIdx = i; z.firstTouchTime = c.t; z.status = "touched"; }
        const fill = z.size > 0 ? Math.min(1, (z.top - c.l) / z.size) : 1;
        if (fill > z.maxFillPct) z.maxFillPct = fill;
      }
      if (c.l < z.bottom) {
        z.status = "broken"; z.brokenBarIdx = i; z.brokenTime = c.t; z.maxFillPct = 1;
        activeList.splice(k, 1);
      }
    } else {
      if (c.h > z.bottom) {
        if (z.firstTouchBarIdx == null) { z.firstTouchBarIdx = i; z.firstTouchTime = c.t; z.status = "touched"; }
        const fill = z.size > 0 ? Math.min(1, (c.h - z.bottom) / z.size) : 1;
        if (fill > z.maxFillPct) z.maxFillPct = fill;
      }
      if (c.h > z.top) {
        z.status = "broken"; z.brokenBarIdx = i; z.brokenTime = c.t; z.maxFillPct = 1;
        activeList.splice(k, 1);
      }
    }
  }
}

// ── Volume Imbalance ────────────────────────────────────────────────────────────────────────
// Pine:
//   vImb_Bl = open > close[1] and high[1] > low  and close > close[1] and open > open[1] and high[1] < mn
//   vImb_Br = open < close[1] and low [1] < high and close < close[1] and open < open[1] and low [1] > mx
// where mn/mx are the CURRENT bar's body bottom/top. The zone spans the gap between the previous
// bar's body extreme and the current bar's body extreme -- a body-to-body gap that the wicks
// overlap, which is what distinguishes it from an FVG (a full wick-to-wick gap).
export function computeVolumeImbalance(candles, displacement = null) {
  const disp = displacement || computeDisplacement(candles);
  const n = candles.length;
  const events = [];
  for (let i = 1; i < n; i++) {
    const c = candles[i], p = candles[i - 1];
    const mn = disp.mn[i], mx = disp.mx[i];
    const mxPrev = disp.mx[i - 1], mnPrev = disp.mn[i - 1];
    const atr = disp.atr[i];

    const bl = c.o > p.c && p.h > c.l && c.c > p.c && c.o > p.o && p.h < mn;
    const br = c.o < p.c && p.l < c.h && c.c < p.c && c.o < p.o && p.l > mx;
    if (!bl && !br) continue;

    const top = bl ? mn : mnPrev;
    const bottom = bl ? mxPrev : mx;
    events.push({
      side: bl ? "bullish" : "bearish",
      barIdx: i,
      time: c.t,
      top: Math.max(top, bottom),
      bottom: Math.min(top, bottom),
      size: Math.abs(top - bottom),
      sizeAtr: Number.isFinite(atr) && atr > 0 ? Math.abs(top - bottom) / atr : null,
    });
  }
  return { events };
}
