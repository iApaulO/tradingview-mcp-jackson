// Faithful JS port of pine/smart-money-concepts-luxalgo.pine's structure (BOS/CHoCH), EQH/EQL,
// and order-block logic, under the indicator's own default settings (COLORED style, internal
// leg size=5, swing leg size=50, equal-highs/lows size=3, ATR-based order block filter,
// high/low mitigation source). FVG and Premium/Discount zones deliberately deferred -- FVG is
// off by default in the source itself, and premium/discount is a single live-state display (the
// current trailing range), not a historical zone series, so it doesn't fit the same zone/touch
// analysis pattern the rest of this does.
//
// This is a historical/offline reimplementation (scripts/signal-bus/), not a live-rendering one.
// One deliberate deviation from the source: Pine only DISPLAYS the most recent 5 order blocks per
// scope (internalOrderBlocksSizeInput/swingOrderBlocksSizeInput) even though it TRACKS up to 100
// internally. We track and analyze all of them (up to the same 100 cap) -- more data is more
// useful for analysis, and the 5-item display cap is a rendering-performance concern that doesn't
// apply here.
//
// Colors are carried through EXACTLY as the source defines them (not simplified to a generic
// bullish/bearish flag) -- order blocks are blue/red-family, not green/red, and that distinction
// matters for anyone consuming this data expecting the chart to look a specific way.

const BULLISH = 1;
const BEARISH = -1;
const BULLISH_LEG = 1;
const BEARISH_LEG = 0;

const COLOR = {
  structureBull: "#089981", // GREEN
  structureBear: "#F23645", // RED
  eqlColor: "#089981", // EQL uses swingBullishColor
  eqhColor: "#F23645", // EQH uses swingBearishColor
  obInternalBull: "#3179f5",
  obInternalBear: "#f77c80",
  obSwingBull: "#1848cc",
  obSwingBear: "#b22833",
};

const INTERNAL_LEG_SIZE = 5;
const SWING_LEG_SIZE = 50; // swingsLengthInput default
const EQUAL_LEG_SIZE = 3; // equalHighsLowsLengthInput default
const EQUAL_THRESHOLD = 0.1; // equalHighsLowsThresholdInput default, x ATR(200)
const ATR_LEN = 200;
// Raised 2026-08-08 from 100 (the live LuxAlgo indicator's own on-chart tracking limit) for the
// HISTORICAL build specifically -- at 100/scope, the rolling eviction meant "historical" order
// blocks for anything faster than daily were actually just a recent trailing window (5m: 6.5 weeks
// of the 9 years of candles loaded; 15m: ~5 months), which was silently starving every attachment/
// recurrence significance test of real sample size. A backtest has legitimate access to the full
// historical record -- unlike a live chart's bounded memory, there's no reason a significance test
// needs to forget order blocks the way the live indicator's on-screen state does. Set high enough
// that it won't realistically trigger against this dataset (effectively unbounded), not tuned to a
// specific expected count.
const ORDER_BLOCK_MAX_TRACKED = 1000000;

function atr(candles, length) {
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

// leg(size): var-persisted per distinct size (Pine keeps one `var leg` per call site -- we
// simulate that by giving each size its own independent state machine).
function legSeries(candles, size) {
  const n = candles.length;
  const legs = new Array(n).fill(BEARISH_LEG);
  let leg = BEARISH_LEG;
  for (let i = size; i < n; i++) {
    let highestRecent = -Infinity, lowestRecent = Infinity;
    for (let j = i - size + 1; j <= i; j++) {
      if (candles[j].h > highestRecent) highestRecent = candles[j].h;
      if (candles[j].l < lowestRecent) lowestRecent = candles[j].l;
    }
    const newLegHigh = candles[i - size].h > highestRecent;
    const newLegLow = candles[i - size].l < lowestRecent;
    if (newLegHigh) leg = BEARISH_LEG;
    else if (newLegLow) leg = BULLISH_LEG;
    legs[i] = leg;
  }
  return legs;
}

// ── Public: continuous swing-scope high/low pivot LEVELS per bar (not break events) ─────────
// Additive helper -- reuses the exact same swing-leg pivot tracking subset as computeSMC's main
// loop (SWING_LEG_SIZE), but returns the CURRENT (not-yet-broken) pivot level at every bar, which
// computeSMC itself never exposes (only structureEvents, fired when a pivot IS broken). Needed for
// a "stop at the previous swing high/low" construction -- the relevant pivot for that is the one
// still standing, not the one that was just crossed to trigger the current signal.
export function computeSwingPivotSeries(candles) {
  const n = candles.length;
  const swingLegs = legSeries(candles, SWING_LEG_SIZE);
  const swingHighLevel = new Array(n).fill(NaN), swingLowLevel = new Array(n).fill(NaN);
  let curHigh = NaN, curLow = NaN;
  for (let i = SWING_LEG_SIZE; i < n; i++) {
    if (swingLegs[i] !== swingLegs[i - 1]) {
      const pivotBarIdx = i - SWING_LEG_SIZE;
      if (pivotBarIdx >= 0) {
        if (swingLegs[i] === BULLISH_LEG) curLow = candles[pivotBarIdx].l;
        else curHigh = candles[pivotBarIdx].h;
      }
    }
    swingHighLevel[i] = curHigh;
    swingLowLevel[i] = curLow;
  }
  return { swingHighLevel, swingLowLevel };
}

// ── Public: compute structure (BOS/CHoCH, both scopes), EQH/EQL, and order blocks ──────────
// candles: [{t,o,h,l,c,v}, ...] chronological.
export function computeSMC(candles) {
  const n = candles.length;
  const atr200 = atr(candles, ATR_LEN);
  const trueRangeAtrForVol = atr200; // orderBlockFilterInput default = "Atr"

  // parsedHigh/parsedLow: swap high/low on high-volatility bars (range >= 2x ATR200), a filter so
  // an outlier wick doesn't anchor an order block.
  const parsedHigh = new Array(n), parsedLow = new Array(n);
  for (let i = 0; i < n; i++) {
    const vol = trueRangeAtrForVol[i];
    const highVol = !Number.isNaN(vol) && candles[i].h - candles[i].l >= 2 * vol;
    parsedHigh[i] = highVol ? candles[i].l : candles[i].h;
    parsedLow[i] = highVol ? candles[i].h : candles[i].l;
  }

  const internalLegs = legSeries(candles, INTERNAL_LEG_SIZE);
  const swingLegs = legSeries(candles, SWING_LEG_SIZE);
  const equalLegs = legSeries(candles, EQUAL_LEG_SIZE);

  // Pivot state per scope: { currentLevel, lastLevel, crossed, barTime, barIndex }
  const mkPivot = () => ({ currentLevel: NaN, lastLevel: NaN, crossed: false, barIdx: -1, time: null });
  const swingHigh = mkPivot(), swingLow = mkPivot();
  const internalHigh = mkPivot(), internalLow = mkPivot();
  const equalHigh = mkPivot(), equalLow = mkPivot();
  let swingTrendBias = 0, internalTrendBias = 0;
  const swingBias = new Array(candles.length).fill(0);
  const internalBias = new Array(candles.length).fill(0);

  const eqhEqlEvents = [];
  const structureEvents = [];
  const orderBlocks = { internal: [], swing: [] };

  // We need pivots and structure interleaved bar-by-bar (structure breaks are checked every bar
  // against the CURRENT pivot state), so rather than fully vectorizing pivot updates first, walk
  // the whole series once and apply both pivot updates and structure/OB checks per bar, matching
  // Pine's actual per-bar execution order: swing pivots -> internal pivots -> equal pivots ->
  // internal structure/OBs -> swing structure/OBs -> OB mitigation.
  function storeOrderBlock(scope, pivot, bias, breakBarIdx) {
    const arr = bias === BEARISH ? parsedHigh : parsedLow;
    let bestIdx = pivot.barIdx, bestVal = arr[pivot.barIdx];
    for (let j = pivot.barIdx; j <= breakBarIdx; j++) {
      if (bias === BEARISH ? arr[j] > bestVal : arr[j] < bestVal) {
        bestVal = arr[j];
        bestIdx = j;
      }
    }
    const color =
      scope === "internal"
        ? bias === BULLISH ? COLOR.obInternalBull : COLOR.obInternalBear
        : bias === BULLISH ? COLOR.obSwingBull : COLOR.obSwingBear;
    const ob = {
      scope,
      side: bias === BULLISH ? "bullish" : "bearish",
      barHigh: parsedHigh[bestIdx],
      barLow: parsedLow[bestIdx],
      originBarIdx: bestIdx,
      originTime: candles[bestIdx].t,
      createdBarIdx: breakBarIdx,
      createdTime: candles[breakBarIdx].t,
      color,
      status: "active",
      mitigatedBarIdx: null,
      mitigatedTime: null,
    };
    orderBlocks[scope].push(ob);
    if (orderBlocks[scope].length > ORDER_BLOCK_MAX_TRACKED) orderBlocks[scope].shift();
  }

  function mitigateOrderBlocks(scope, i) {
    const bearishSrc = candles[i].h; // orderBlockMitigationInput default = HIGHLOW -> high
    const bullishSrc = candles[i].l;
    for (const ob of orderBlocks[scope]) {
      if (ob.status !== "active") continue;
      if (ob.side === "bearish" && bearishSrc > ob.barHigh) {
        ob.status = "mitigated";
        ob.mitigatedBarIdx = i;
        ob.mitigatedTime = candles[i].t;
      } else if (ob.side === "bullish" && bullishSrc < ob.barLow) {
        ob.status = "mitigated";
        ob.mitigatedBarIdx = i;
        ob.mitigatedTime = candles[i].t;
      }
    }
  }

  const minBar = Math.max(SWING_LEG_SIZE + 1, ATR_LEN + 1);
  for (let i = minBar; i < n; i++) {
    // --- pivot updates (leg flips at this bar) ---
    if (swingLegs[i] !== swingLegs[i - 1]) {
      const pivotBarIdx = i - SWING_LEG_SIZE;
      if (pivotBarIdx >= 0) {
        if (swingLegs[i] === BULLISH_LEG) {
          swingLow.lastLevel = swingLow.currentLevel;
          swingLow.currentLevel = candles[pivotBarIdx].l;
          swingLow.crossed = false;
          swingLow.barIdx = pivotBarIdx;
          swingLow.time = candles[pivotBarIdx].t;
        } else {
          swingHigh.lastLevel = swingHigh.currentLevel;
          swingHigh.currentLevel = candles[pivotBarIdx].h;
          swingHigh.crossed = false;
          swingHigh.barIdx = pivotBarIdx;
          swingHigh.time = candles[pivotBarIdx].t;
        }
      }
    }
    if (internalLegs[i] !== internalLegs[i - 1]) {
      const pivotBarIdx = i - INTERNAL_LEG_SIZE;
      if (pivotBarIdx >= 0) {
        if (internalLegs[i] === BULLISH_LEG) {
          internalLow.lastLevel = internalLow.currentLevel;
          internalLow.currentLevel = candles[pivotBarIdx].l;
          internalLow.crossed = false;
          internalLow.barIdx = pivotBarIdx;
          internalLow.time = candles[pivotBarIdx].t;
        } else {
          internalHigh.lastLevel = internalHigh.currentLevel;
          internalHigh.currentLevel = candles[pivotBarIdx].h;
          internalHigh.crossed = false;
          internalHigh.barIdx = pivotBarIdx;
          internalHigh.time = candles[pivotBarIdx].t;
        }
      }
    }
    if (equalLegs[i] !== equalLegs[i - 1]) {
      const pivotBarIdx = i - EQUAL_LEG_SIZE;
      if (pivotBarIdx >= 0) {
        if (equalLegs[i] === BULLISH_LEG) {
          if (!Number.isNaN(equalLow.currentLevel) && Math.abs(equalLow.currentLevel - candles[pivotBarIdx].l) < EQUAL_THRESHOLD * atr200[i]) {
            eqhEqlEvents.push({ side: "EQL", level: candles[pivotBarIdx].l, pivotBarIdx, pivotTime: candles[pivotBarIdx].t, confirmBarIdx: i, confirmTime: candles[i].t, color: COLOR.eqlColor });
          }
          equalLow.currentLevel = candles[pivotBarIdx].l;
          equalLow.barIdx = pivotBarIdx;
          equalLow.time = candles[pivotBarIdx].t;
        } else {
          if (!Number.isNaN(equalHigh.currentLevel) && Math.abs(equalHigh.currentLevel - candles[pivotBarIdx].h) < EQUAL_THRESHOLD * atr200[i]) {
            eqhEqlEvents.push({ side: "EQH", level: candles[pivotBarIdx].h, pivotBarIdx, pivotTime: candles[pivotBarIdx].t, confirmBarIdx: i, confirmTime: candles[i].t, color: COLOR.eqhColor });
          }
          equalHigh.currentLevel = candles[pivotBarIdx].h;
          equalHigh.barIdx = pivotBarIdx;
          equalHigh.time = candles[pivotBarIdx].t;
        }
      }
    }

    // --- structure checks (internal, then swing) -- every bar, against current pivot state ---
    // Internal structure additionally requires its pivot to differ from the swing pivot at the
    // same level (source's `extraCondition`) -- suppresses a duplicate internal signal when the
    // internal and swing pivots happen to coincide. Confluence filter (off by default) not ported.
    for (const scope of ["internal", "swing"]) {
      const highPivot = scope === "internal" ? internalHigh : swingHigh;
      const lowPivot = scope === "internal" ? internalLow : swingLow;
      const trendBias = scope === "internal" ? internalTrendBias : swingTrendBias;
      const highExtra = scope === "internal" ? internalHigh.currentLevel !== swingHigh.currentLevel : true;
      const lowExtra = scope === "internal" ? internalLow.currentLevel !== swingLow.currentLevel : true;

      if (highExtra && !Number.isNaN(highPivot.currentLevel) && !highPivot.crossed && candles[i].c > highPivot.currentLevel && candles[i - 1].c <= highPivot.currentLevel) {
        const tag = trendBias === BEARISH ? "CHOCH" : "BOS";
        highPivot.crossed = true;
        if (scope === "internal") internalTrendBias = BULLISH;
        else swingTrendBias = BULLISH;
        structureEvents.push({ scope, type: tag, side: "bullish", barIdx: i, time: candles[i].t, price: highPivot.currentLevel, color: COLOR.structureBull });
        storeOrderBlock(scope, highPivot, BULLISH, i);
      }
      if (lowExtra && !Number.isNaN(lowPivot.currentLevel) && !lowPivot.crossed && candles[i].c < lowPivot.currentLevel && candles[i - 1].c >= lowPivot.currentLevel) {
        const tag = trendBias === BULLISH ? "CHOCH" : "BOS";
        lowPivot.crossed = true;
        if (scope === "internal") internalTrendBias = BEARISH;
        else swingTrendBias = BEARISH;
        structureEvents.push({ scope, type: tag, side: "bearish", barIdx: i, time: candles[i].t, price: lowPivot.currentLevel, color: COLOR.structureBear });
        storeOrderBlock(scope, lowPivot, BEARISH, i);
      }
    }

    // Per-bar SWING trend bias. LuxAlgo labels its trailing extremes from exactly this value:
    // `swingTrend.bias == BULLISH ? 'Strong Low' : 'Weak Low'` (source L733) and
    // `swingTrend.bias == BEARISH ? 'Strong High' : 'Weak High'` (L728). It was computed here
    // since the port but never exposed, so no test could condition on it -- which is why
    // iapaulo's "preceding structure defined by arrow" (a Strong Low) was missing from the
    // corpus entirely. Added 2026-08-19.
    swingBias[i] = swingTrendBias;
    internalBias[i] = internalTrendBias;

    // --- order block mitigation, every bar ---
    mitigateOrderBlocks("internal", i);
    mitigateOrderBlocks("swing", i);
  }

  return { structureEvents, eqhEqlEvents, orderBlocks: [...orderBlocks.internal, ...orderBlocks.swing], swingBias, internalBias };
}
