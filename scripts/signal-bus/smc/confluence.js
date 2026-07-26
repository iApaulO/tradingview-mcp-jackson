// Confluence detection for SMC: does an order block that aligns with OTHER SMC signals -- other
// order blocks (any timeframe/scope), EQH/EQL levels, or structure breakout prices -- hold more
// reliably than an isolated one? Order blocks are the only element with a real hold/broken
// outcome (via touches.js), so they're the target; everything else is a potential confluence
// source. Same underlying idea as Divergence for Many's confluence.js, adapted for SMC's three
// different signal geometries (order blocks are RANGES, EQH/EQL and structure are POINT levels).
//
// Price match: a point source's level falls within an order block's [barLow, barHigh] expanded by
// a small tolerance; two order blocks are confluent if their (tolerance-expanded) ranges overlap.
// Reuses the same 0.2%-of-price tolerance Divergence for Many's confluence.js settled on, for
// consistency rather than inventing a new unvalidated constant.
//
// Time match: every element gets an "active window" [start, end]. Order blocks: [createdTime,
// mitigatedTime ?? open-ended]. Point sources (EQH/EQL, structure) have no natural expiry, so they
// get the same 200-bar decay concept Divergence for Many's promoted zones use, converted to real
// time via their own timeframe's bar duration -- a stale 2017 structure break shouldn't count as
// "confluent" with a 2024 order block just because both technically exist in the same dataset.
// Two elements are confluent only if their active windows overlap.

const PRICE_TOLERANCE_PCT = 0.002; // 0.2% of price, same choice as divergence-for-many/confluence.js
const DECAY_BARS = 200; // same concept as Divergence for Many's badgeglow_expire_bars

const TF_SECONDS = { "1w": 604800, "1d": 86400, "4h": 14400, "3h": 10800, "2h": 7200, "1h": 3600, "15m": 900, "5m": 300 };

function priceRange(el) {
  if (el.type === "orderblock") return [el.priceLow, el.priceHigh];
  const tol = el.price * PRICE_TOLERANCE_PCT;
  return [el.price - tol, el.price + tol];
}

function rangesOverlap([aLo, aHi], [bLo, bHi], tol) {
  return aLo - tol <= bHi && bLo - tol <= aHi;
}

function activeWindow(el) {
  if (el.type === "orderblock") return [el.activeStart, el.activeEnd ?? Infinity];
  const decaySeconds = DECAY_BARS * (TF_SECONDS[el.timeframe] || 3600);
  return [el.activeStart, el.activeStart + decaySeconds];
}

function windowsOverlap([aLo, aHi], [bLo, bHi]) {
  return aLo <= bHi && bLo <= aHi;
}

// orderBlocks: the target list (each needs id, priceLow, priceHigh, activeStart, activeEnd, side).
// pool: ALL elements (order blocks + EQH/EQL + structure, all timeframes) to check confluence
// against, each shaped { type, id, timeframe, side, price OR (priceLow/priceHigh), activeStart,
// activeEnd }. Mutates orderBlocks in place: confluenceCount (distinct timeframes agreeing,
// including itself), confluenceSources (breakdown by type), confluentIds.
export function computeSMCConfluence(orderBlocks, pool) {
  const sorted = [...pool].sort((a, b) => priceRange(a)[0] - priceRange(b)[0]);
  const lowBounds = sorted.map((el) => priceRange(el)[0]);

  function binarySearchFloor(target) {
    let lo = 0, hi = lowBounds.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (lowBounds[mid] < target) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  }

  const maxTol = Math.max(...pool.map((el) => (el.type === "orderblock" ? 0 : el.price * PRICE_TOLERANCE_PCT)), 1);

  for (const ob of orderBlocks) {
    if (ob.side !== "bullish" && ob.side !== "bearish") continue;
    const obRange = [ob.priceLow, ob.priceHigh];
    const obWindow = [ob.activeStart, ob.activeEnd ?? Infinity];
    const searchFrom = binarySearchFloor(obRange[0] - maxTol - 1);

    const timeframesSeen = new Set([ob.timeframe]);
    const sourceCounts = { orderblock: 0, eqhl: 0, structure: 0 };
    const confluentIds = [];

    for (let i = searchFrom; i < sorted.length; i++) {
      const el = sorted[i];
      const elRange = priceRange(el);
      if (elRange[0] > obRange[1] + maxTol) break; // sorted -- no further candidates
      if (el.id === ob.id && el.type === "orderblock") continue;
      if (el.side !== ob.side) continue;
      // Point sources are already tolerance-expanded inside priceRange(); order-block ranges have
      // real width of their own, so no extra tolerance needed for OB-vs-OB overlap.
      if (!rangesOverlap(obRange, elRange, 0)) continue;
      if (!windowsOverlap(obWindow, activeWindow(el))) continue;

      timeframesSeen.add(el.timeframe);
      sourceCounts[el.type]++;
      confluentIds.push({ type: el.type, id: el.id });
    }

    ob.confluenceCount = timeframesSeen.size;
    ob.confluenceSources = sourceCounts;
    ob.confluentIds = confluentIds;
  }

  return orderBlocks;
}
