// Order-block touch tracking. Order blocks are RANGES (barLow-barHigh), not single price lines
// like Divergence for Many's zones, so "touch" means the bar's range overlapping the box, not
// reaching a single level -- and unlike that indicator, SMC's own mitigation rule already gives an
// authoritative, precise "broken" event (source's deleteOrderBlocks: a bearish/supply block is
// mitigated the instant price's HIGH clears above barHigh; a bullish/demand block the instant
// LOW clears below barLow -- default HIGHLOW mitigation source, not close). That means mitigation
// is terminal and immediate on full breach, not a close-based judgment call -- so touch tracking's
// real value here isn't redefining "broken" (already correct from calc.js), it's capturing
// everything that happened BEFORE that: how many times was the block tested, how deep did each
// test penetrate, before it was ultimately mitigated (or, if still active, so far).
//
// An "interaction" is a maximal run of consecutive bars whose range overlaps [barLow, barHigh].
// outcome: "broken" if the block's real mitigation event falls inside this interaction's bar
// range (there can be at most one such interaction per block, since mitigation ends tracking);
// otherwise "held" -- price entered the box and retreated back out without triggering mitigation.
// penetrationPct: how deep the interaction reached into (or through) the box, as a fraction of box
// height measured from the approached side -- 0 = just grazed the near edge, 1.0 = reached the far
// edge exactly, >1.0 = wicked through the far side without yet closing/mitigating on HIGHLOW terms
// (can happen since mitigation source is high/low, so a same-bar wick-through-and-back is still
// only "held" if it doesn't persist -- actually under HIGHLOW source a wick through IS mitigation
// the same bar, so >1.0 penetration should coincide with outcome="broken" by construction; kept as
// a number rather than clamped so that invariant is checkable rather than hidden).

function isTouching(bar, ob) {
  return bar.h >= ob.barLow && bar.l <= ob.barHigh;
}

function penetrationPct(bar, ob, approachDirection) {
  const height = ob.barHigh - ob.barLow;
  if (height <= 0) return 0;
  if (approachDirection === "above") return (ob.barHigh - bar.l) / height;
  if (approachDirection === "below") return (bar.h - ob.barLow) / height;
  return 1; // already inside at interaction start (rare -- see header note on why "from below" on a
  // bullish block, or "from above" on a bearish one, is expected to be effectively unreachable
  // under default HIGHLOW mitigation, since breaching the far side IS mitigation)
}

export function detectOrderBlockTouches(candles, ob) {
  const startBar = ob.createdBarIdx;
  const endBar = ob.mitigatedBarIdx != null ? Math.min(ob.mitigatedBarIdx, candles.length - 1) : candles.length - 1;
  const interactions = [];
  let current = null;

  for (let i = startBar; i <= endBar; i++) {
    const bar = candles[i];
    if (isTouching(bar, ob)) {
      if (!current) {
        const priorClose = i > 0 ? candles[i - 1].c : bar.c;
        const approachDirection = priorClose > ob.barHigh ? "above" : priorClose < ob.barLow ? "below" : "inside";
        current = { startBarIdx: i, startTime: bar.t, barsCount: 0, maxPenetrationPct: 0, approachDirection };
      }
      current.barsCount++;
      const p = penetrationPct(bar, ob, current.approachDirection);
      if (p > current.maxPenetrationPct) current.maxPenetrationPct = p;
      current.endBarIdx = i;
      current.endTime = bar.t;
    } else if (current) {
      current.outcome = resolveOutcome(current, ob);
      interactions.push(current);
      current = null;
    }
  }
  if (current) {
    current.outcome = resolveOutcome(current, ob);
    current.ongoing = ob.status === "active" && endBar === candles.length - 1;
    interactions.push(current);
  }
  return interactions;
}

function resolveOutcome(interaction, ob) {
  if (ob.mitigatedBarIdx != null && interaction.startBarIdx <= ob.mitigatedBarIdx && ob.mitigatedBarIdx <= interaction.endBarIdx) {
    return "broken";
  }
  return "held";
}

export function computeAllOrderBlockTouches(candles, orderBlocks) {
  for (const ob of orderBlocks) {
    ob.touches = detectOrderBlockTouches(candles, ob);
  }
  return orderBlocks;
}
