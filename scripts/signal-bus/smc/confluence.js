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

// recurrenceCount (2026-07-28, added after a live discretionary chart read surfaced that
// same-timeframe order-block recurrence -- demand/supply re-forming at one price band on ONE
// timeframe over time -- is invisible to confluenceCount by definition (distinct TIMEFRAMES seen,
// timeframesSeen.size). Mirrors Divergence for Many's sameTimeframeClusterSize
// (divergence-for-many/confluence.js) exactly: same matching pass, just tallying same-timeframe
// order-block matches instead of (or alongside) distinct-timeframe agreement. A DIFFERENT
// question from confluenceCount, not a replacement for it -- both are computed and stored.

// orderBlocks: the target list (each needs id, priceLow, priceHigh, activeStart, activeEnd, side).
// pool: ALL elements (order blocks + EQH/EQL + structure, all timeframes) to check confluence
// against, each shaped { type, id, timeframe, side, price OR (priceLow/priceHigh), activeStart,
// activeEnd }. Mutates orderBlocks in place: confluenceCount (distinct timeframes agreeing,
// including itself), confluenceSources (breakdown by type), confluentIds, recurrenceCount (how
// many OTHER order blocks on this SAME timeframe are confluent with it -- 1 = this is the only
// order block on its own timeframe in this price/time neighborhood).
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

  // FIXED 2026-08-08: Math.max(...pool.map(...)) blew the call stack once the pool grew past the
  // old 200-order-block-per-timeframe cap (spreading 180k+ elements as call arguments hits the
  // engine's argument-count limit) -- plain loop has no such limit.
  let maxTol = 1;
  for (const el of pool) {
    const tol = el.type === "orderblock" ? 0 : el.price * PRICE_TOLERANCE_PCT;
    if (tol > maxTol) maxTol = tol;
  }

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

  computeRecurrence(orderBlocks);
  return orderBlocks;
}

// recurrenceCount: how many OTHER order blocks on the SAME timeframe (and side) price-overlap
// and time-overlap this one -- deliberately NOT reusing the sweep above. That sweep's
// searchFrom/break bounds assume a matching element starts near `ob`'s own start (true for the
// narrow, tolerance-expanded point sources -- EQH/EQL, structure -- that dominate the pool, 102,868
// of 104,200 elements), which is false for a WIDE order block that starts much earlier than
// another order block yet still overlaps it via its own width. Confirmed as a real bug, not a
// theory: two order blocks with verified real overlap (id 225: $61,067.81-62,147.89, id 229:
// $61,750.90-62,567.99, same side/timeframe, both open-ended) showed ASYMMETRIC results under the
// sweep (225 counted 229 as a match, 229 didn't count 225 back) -- impossible for a symmetric
// overlap relation, traced to id 225's wide range starting well before id 229's own searchFrom
// cutoff. Per-timeframe-group O(n^2) here instead: groups are small (≤200 order blocks per
// scope/timeframe by construction, ORDER_BLOCK_MAX_TRACKED in calc.js), so correctness costs
// nothing worth optimizing away. Left the sweep above untouched for confluenceCount -- that
// finding was already tested/reported against it, and the point-source-dominated pool makes this
// specific bug's impact there minor; revisiting it is a separate, later decision, not bundled in
// here.
function computeRecurrence(orderBlocks) {
  const byGroup = new Map(); // "timeframe|side" -> order blocks
  for (const ob of orderBlocks) {
    const key = `${ob.timeframe}|${ob.side}`;
    if (!byGroup.has(key)) byGroup.set(key, []);
    byGroup.get(key).push(ob);
  }
  for (const group of byGroup.values()) {
    for (const ob of group) {
      const obRange = [ob.priceLow, ob.priceHigh];
      const obWindow = [ob.activeStart, ob.activeEnd ?? Infinity];
      let matches = 0;
      for (const other of group) {
        if (other.id === ob.id) continue;
        const otherRange = [other.priceLow, other.priceHigh];
        const otherWindow = [other.activeStart, other.activeEnd ?? Infinity];
        if (!rangesOverlap(obRange, otherRange, 0)) continue;
        if (!windowsOverlap(obWindow, otherWindow)) continue;
        matches++;
      }
      ob.recurrenceCount = 1 + matches;
    }
  }
}
