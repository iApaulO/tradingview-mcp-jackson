// ICT Concepts [LuxAlgo] LIQUIDITY POOLS -- buyside / sellside clustered-pivot zones.
//
// WHY THIS EXISTS AND WHY THE INDEPENDENCE CHECK COMES FIRST. #147 established that iapaulo's
// on-chart "Buyside liquidity" / "Sellside liquidity" references are these boxes, NOT SMC's
// equal-highs/equal-lows -- #146 had checked the wrong construct and wrongly reported them absent.
// They were deliberately deferred in #130, which ported only the LTF primitives.
//
// The reason to port them is NOT "another feature to test standalone". #126's C-1 finding gives a
// LOW prior to any further price-derived feature added to an already-saturated domain-1 stack. The
// reason is that #137 showed the informative multi-timeframe variable is BREADTH -- how many rungs
// agree -- so a SECOND event family could legitimately raise K in the co-occurrence mechanism that
// already works.
//
// **That is exactly why independence must be measured BEFORE integration.** ICT liquidity pools are
// built from clustered PIVOTS, and SMC structure events are ALSO pivot-derived. If the two are
// near-duplicates, feeding liquidity into the cluster builder would inflate K without adding
// information and would manufacture a fake improvement in the one mechanism currently validated.
// #28 is the precedent -- an r=0.9993 pair discarded for exactly this reason. Nothing here may be
// wired into `lib/cooccurrence.js` until that check passes.
//
// PORT NOTES, from pine/ict-concepts-luxalgo.pine:
//   * Pools are detected inside `draw()` on every confirmed pivot, against a 50-slot zigzag `aZZ`
//     built from `ta.pivothigh(hi, left, 1)` / `ta.pivotlow(lo, left, 1)` with left = `len` = 5
//     (the Market Structures length, NOT the Order Blocks `length` of 10 -- the source uses both
//     and binding the wrong one silently changes every pool).
//   * Clustering tolerance is `atr / a` where `a = 10 / 4 = 2.5`, so ±ATR(10)/2.5. ATR length is 10
//     (`atr = ta.atr(10)`), not the 14 used elsewhere in this project.
//   * A pool requires `count > 2`, i.e. **three or more** same-side pivots inside the band.
//   * The scan `break`s as soon as a pivot lies beyond `ph + atr/a`, so it only walks the most
//     recent contiguous run -- it is not a global search. Replicated exactly.
//   * NOTE a quirk in the source, preserved deliberately: `minP` is seeded at 0 and takes the
//     MAXIMUM, `maxP` is seeded at 10e6 and takes the MINIMUM. The names are inverted relative to
//     their behaviour. The box is centred on `avg(minP, maxP)` with half-height `atr/a`, so the
//     inversion does not change the result -- but a "corrected" port would compute the same centre
//     from differently-named variables and look wrong on review. Kept faithful, flagged here.
//   * Display caps (`visLiq` = 2 per side) are NOT applied: research configuration retains every
//     pool, same superset-then-gate rule as #130.
//   * Break state is tracked as in the source: a buyside pool records `brokenTop` when close
//     exceeds its top and `brokenBtm` when close exceeds its bottom, and is fully `broken` once
//     both. Retained rather than deleted, per the #130 lifecycle convention.

const PIVOT_LEFT = 5;      // `len`, Market Structures length -- NOT the Order Blocks `length` (10)
const PIVOT_RIGHT = 1;
const ATR_LEN = 10;        // pine: ta.atr(10)
const MARGIN_DIV = 2.5;    // a = 10 / 4
const MIN_CLUSTER = 3;     // pine: count > 2
const ZZ_MAX = 50;         // maxSize

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

// ta.pivothigh(src, left, right) confirms at bar i, referring to the pivot at i-right.
function pivotHighAt(candles, i, left, right) {
  const p = i - right;
  if (p - left < 0 || i >= candles.length) return null;
  const v = candles[p].h;
  for (let k = p - left; k < p; k++) if (candles[k].h >= v) return null;
  for (let k = p + 1; k <= p + right; k++) if (candles[k].h > v) return null;
  return { barIdx: p, price: v };
}
function pivotLowAt(candles, i, left, right) {
  const p = i - right;
  if (p - left < 0 || i >= candles.length) return null;
  const v = candles[p].l;
  for (let k = p - left; k < p; k++) if (candles[k].l <= v) return null;
  for (let k = p + 1; k <= p + right; k++) if (candles[k].l < v) return null;
  return { barIdx: p, price: v };
}

export function computeLiquidityPools(candles) {
  const atr = atrSeries(candles, ATR_LEN);
  // Zigzag: newest first, mirroring aZZ.unshift + pop. d: 1 = high pivot, -1 = low pivot.
  const zz = [];
  const pools = [];
  const openPools = { buyside: [], sellside: [] };

  for (let i = 0; i < candles.length; i++) {
    const band = Number.isFinite(atr[i]) ? atr[i] / MARGIN_DIV : NaN;

    // Lifecycle: update open pools against this bar's close before adding anything new.
    for (const side of ["buyside", "sellside"]) {
      for (let k = openPools[side].length - 1; k >= 0; k--) {
        const p = openPools[side][k];
        if (p.createdBarIdx === i) continue;
        const c = candles[i].c;
        if (side === "buyside") {
          if (!p.brokenTop && c > p.top) p.brokenTop = true;
          if (!p.brokenBtm && c > p.bottom) p.brokenBtm = true;
        } else {
          if (!p.brokenTop && c < p.top) p.brokenTop = true;
          if (!p.brokenBtm && c < p.bottom) p.brokenBtm = true;
        }
        if (p.brokenTop && p.brokenBtm && p.status !== "broken") {
          p.status = "broken";
          p.brokenBarIdx = i;
          p.brokenTime = candles[i].t;
          openPools[side].splice(k, 1);
        } else if ((p.brokenTop || p.brokenBtm) && p.status === "active") {
          p.status = "touched";
          p.firstTouchBarIdx = i;
          p.firstTouchTime = candles[i].t;
        }
      }
    }

    const ph = pivotHighAt(candles, i, PIVOT_LEFT, PIVOT_RIGHT);
    const pl = pivotLowAt(candles, i, PIVOT_LEFT, PIVOT_RIGHT);

    for (const [dir, piv, side] of [[1, ph, "buyside"], [-1, pl, "sellside"]]) {
      if (!piv || !Number.isFinite(band)) continue;

      // Cluster scan over the zigzag as it stood BEFORE this pivot was pushed, exactly as the
      // source does (the pivot is unshifted after the liquidity block in Pine's control flow).
      let count = 0, startBar = null, startPrice = null, hi = 0, lo = 1e7;
      for (let z = 0; z < Math.min(zz.length, ZZ_MAX); z++) {
        if (zz[z].d !== dir) continue;
        const y = zz[z].y;
        const beyond = dir === 1 ? y > piv.price + band : y < piv.price - band;
        if (beyond) break; // contiguous run only -- not a global search
        if (y > piv.price - band && y < piv.price + band) {
          count++;
          startBar = zz[z].x;
          startPrice = y;
          if (y > hi) hi = y;
          if (y < lo) lo = y;
        }
      }

      if (count >= MIN_CLUSTER) {
        const centre = (hi + lo) / 2;
        const existing = openPools[side][0];
        if (existing && existing.startBarIdx === startBar) {
          // same anchor -> the source RESIZES the live box rather than creating a second one
          existing.top = centre + band;
          existing.bottom = centre - band;
          existing.pivotCount = count;
        } else {
          const pool = {
            side,
            top: centre + band,
            bottom: centre - band,
            level: startPrice,
            pivotCount: count,
            startBarIdx: startBar,
            startTime: candles[startBar] ? candles[startBar].t : null,
            // Detection bar -- what is knowable at this bar's close. The pool's geometry reaches
            // back to startBarIdx, which is why both are recorded (same discipline as #130's FVG).
            createdBarIdx: i,
            createdTime: candles[i].t,
            bandAtr: band,
            status: "active",
            brokenTop: false,
            brokenBtm: false,
            firstTouchBarIdx: null, firstTouchTime: null,
            brokenBarIdx: null, brokenTime: null,
          };
          pools.push(pool);
          openPools[side].unshift(pool);
        }
      }
    }

    // Push confirmed pivots onto the zigzag, newest first, capped at maxSize.
    if (ph) { zz.unshift({ d: 1, x: ph.barIdx, y: ph.price }); if (zz.length > ZZ_MAX) zz.pop(); }
    if (pl) { zz.unshift({ d: -1, x: pl.barIdx, y: pl.price }); if (zz.length > ZZ_MAX) zz.pop(); }
  }

  return { pools };
}
