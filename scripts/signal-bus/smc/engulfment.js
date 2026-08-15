// Shared engulfment classifier, extracted so both ob-engulfment-significance.js (#117) and
// portfolio-backtest.js's Strategy A can use the exact same classification instead of two
// copies drifting apart. See ob-engulfment-significance.js's header for the full rationale.

function rangesOverlap(aLo, aHi, bLo, bHi) { return aLo <= bHi && bLo <= aHi; }
function windowsOverlap(aLo, aHi, bLo, bHi) { return aLo <= bHi && bLo <= aHi; }

// Mutates orderBlocks in place, adding: hasPartner, isEngulfed, isEngulfing, engulfmentClass
// ("isolated" | "partial" | "engulfment"). orderBlocks entries need: id, timeframe, side,
// bar_high, bar_low, created_time, mitigated_time (or mitigatedTime/createdTime -- both casings
// accepted since the two call sites load rows with slightly different naming).
export function classifyEngulfment(orderBlocks) {
  // Fast path: recurrence_count (already stored/computed) is 1 iff an order block has NO overlap
  // partner at all -- isolated by definition, can't be engulfed/engulfing. Skipping these before the
  // O(n^2) pairwise scan matters a lot in practice: some timeframe/side groups run 20k+ order blocks
  // (the full historical table, not the ~200-per-group live-tracking cap confluence.js's own
  // computeRecurrence was sized for), and roughly half of any group is isolated in this dataset.
  const candidates = orderBlocks.filter((ob) => (ob.recurrence_count ?? 2) >= 2);
  for (const ob of orderBlocks) {
    if ((ob.recurrence_count ?? 2) < 2) { ob.hasPartner = false; ob.isEngulfed = false; ob.isEngulfing = false; ob.engulfmentClass = "isolated"; }
  }

  const byGroup = new Map(); // "timeframe|side" -> obs
  for (const ob of candidates) {
    const key = `${ob.timeframe}|${ob.side}`;
    if (!byGroup.has(key)) byGroup.set(key, []);
    byGroup.get(key).push(ob);
  }
  for (const group of byGroup.values()) {
    for (const ob of group) {
      const createdA = ob.created_time ?? ob.createdTime;
      const obEnd = (ob.mitigated_time ?? ob.mitigatedTime) ?? Infinity;
      let isEngulfed = false, isEngulfing = false, hasPartner = false;
      for (const other of group) {
        if (other.id === ob.id) continue;
        const createdB = other.created_time ?? other.createdTime;
        const otherEnd = (other.mitigated_time ?? other.mitigatedTime) ?? Infinity;
        if (!rangesOverlap(ob.bar_low, ob.bar_high, other.bar_low, other.bar_high)) continue;
        if (!windowsOverlap(createdA, obEnd, createdB, otherEnd)) continue;
        hasPartner = true;
        const otherFullyContainsOb = other.bar_low <= ob.bar_low && other.bar_high >= ob.bar_high && (other.bar_low < ob.bar_low || other.bar_high > ob.bar_high);
        const obFullyContainsOther = ob.bar_low <= other.bar_low && ob.bar_high >= other.bar_high && (ob.bar_low < other.bar_low || ob.bar_high > other.bar_high);
        if (otherFullyContainsOb) isEngulfed = true;
        if (obFullyContainsOther) isEngulfing = true;
      }
      ob.hasPartner = hasPartner;
      ob.isEngulfed = isEngulfed;
      ob.isEngulfing = isEngulfing;
      ob.engulfmentClass = !hasPartner ? "isolated" : (isEngulfed || isEngulfing) ? "engulfment" : "partial";
    }
  }
  return orderBlocks;
}
