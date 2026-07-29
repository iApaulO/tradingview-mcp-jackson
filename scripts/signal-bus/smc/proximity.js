// Order-block "near-miss" tracking (2026-07-28) -- price approaching an active order block's
// boundary closely without ever entering it, then moving away. Formalizes an ad-hoc investigation
// prompted directly by a live discretionary chart read: iapaulo counted 7 real touches on a
// stacked order-block structure plus "1 time where price found clean support with no touch" --
// verified against real data (a 3-bar pullback on 2026-07-04, closest approach $126/0.20% from
// OB225's top, reversing cleanly without ever entering the box) and formalized here as a
// permanent, reusable capability rather than a one-off script.
//
// Deliberately a SEPARATE, parallel signal from touches.js's "interaction" -- a near-miss is
// mutually exclusive with a touch at the bar level (isTouching is the same predicate touches.js
// uses; a bar is either touching or a near-miss candidate, never both), and mirrors touches.js's
// "maximal run of consecutive qualifying bars" structure so the two remain directly comparable.
// No held/broken outcome here -- by construction a near-miss never enters the box, so there's
// nothing to mitigate; the useful facts are how close it got and for how long.
//
// Tolerance: NOT reusing confluence.js's 0.2% constant -- checked first, and it would have been
// wrong. The motivating event (2026-07-04, OB225) bottomed at 0.20% away, and the runner-up bar
// was 0.33% away; a 0.2% hard cutoff would have EXCLUDED the very case this was built to catch
// (found before shipping it, not after). confluence.js's 0.2% answers a different question --
// whether two separate structures count as "the same" price level for identity-matching -- this
// is "how close counts as almost touching one specific existing box," which should reasonably be
// looser. PROXIMITY_TOLERANCE_PCT = 0.5% is a new starting assumption, not a validated constant,
// chosen to comfortably clear the motivating example with real margin (0.20-0.33% observed) --
// same "starting assumption, not validated, worth tuning once real usage exists" status
// confluence.js's own constant carries.

const PROXIMITY_TOLERANCE_PCT = 0.005;

function isTouching(bar, ob) {
  return bar.h >= ob.barLow && bar.l <= ob.barHigh;
}

// Distance from the bar's near edge to the box's near edge, as a fraction of price -- only
// defined when the bar is outside the box on a specific side (approaching, not yet touching).
function approachDistancePct(bar, ob) {
  if (bar.l > ob.barHigh) return { direction: "above", pct: (bar.l - ob.barHigh) / ob.barHigh };
  if (bar.h < ob.barLow) return { direction: "below", pct: (ob.barLow - bar.h) / ob.barLow };
  return null; // inside or touching -- not a near-miss candidate (isTouching would already be true)
}

export function detectProximityEvents(candles, ob, tolerancePct = PROXIMITY_TOLERANCE_PCT) {
  const startBar = ob.createdBarIdx;
  const endBar = ob.mitigatedBarIdx != null ? Math.min(ob.mitigatedBarIdx, candles.length - 1) : candles.length - 1;
  const events = [];
  let current = null;

  for (let i = startBar; i <= endBar; i++) {
    const bar = candles[i];
    if (isTouching(bar, ob)) {
      if (current) { events.push(current); current = null; } // a real touch ends any in-progress near-miss run
      continue;
    }
    const approach = approachDistancePct(bar, ob);
    const isNear = approach != null && approach.pct <= tolerancePct;
    if (isNear) {
      if (!current || current.approachDirection !== approach.direction) {
        if (current) events.push(current);
        current = { startBarIdx: i, startTime: bar.t, barsCount: 0, closestApproachPct: Infinity, approachDirection: approach.direction };
      }
      current.barsCount++;
      if (approach.pct < current.closestApproachPct) current.closestApproachPct = approach.pct;
      current.endBarIdx = i;
      current.endTime = bar.t;
    } else if (current) {
      events.push(current);
      current = null;
    }
  }
  if (current) {
    current.ongoing = ob.status === "active" && endBar === candles.length - 1;
    events.push(current);
  }
  return events;
}

export function computeAllProximityEvents(candles, orderBlocks, tolerancePct = PROXIMITY_TOLERANCE_PCT) {
  for (const ob of orderBlocks) {
    ob.proximityEvents = detectProximityEvents(candles, ob, tolerancePct);
  }
  return orderBlocks;
}
