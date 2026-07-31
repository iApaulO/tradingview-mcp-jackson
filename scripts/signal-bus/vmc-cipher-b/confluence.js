// Confluence / tight-clustering detection across the full zone set (all 8 timeframes combined).
// Same-timeframe clustering (2-3 lines on one timeframe bunched close enough to read as one wider
// zone -- the 2H example from the 2026-07-25 discussion) and cross-timeframe confluence (the
// hierarchical/cartographic question) turn out to be the SAME underlying test -- "are these two
// zones price-close, time-overlapping, and same-side" -- just read differently depending on
// whether the matched pair shares a timeframe or not. One algorithm, two derived readings.
//
// Tolerance: FIXED percentage of price (PRICE_TOLERANCE_PCT), not ATR-derived. First attempt used
// max(zoneA's ATR tolerance, zoneB's) -- but a weekly ATR-derived tolerance for BTC can be
// thousands of dollars, so every zone within a huge radius of any weekly zone got swept into
// "confluence" regardless of actual tightness (caught by inspecting the max-confluence example:
// it included pairs $2,900-$8,400 apart, not a tight cluster by any reading). A fixed % band
// avoids the coarse-timeframe blowup and is what "tight range" actually means here. 0.2% of price
// is a starting assumption, not a validated constant -- worth tuning once the analytics page makes
// it easy to eyeball whether clusters look right at different price levels/volatility regimes.
//
// Time overlap: two zones are only compared if their ACTIVE lifetimes (confirmedTime ->
// expiresTime, or "now"/open-ended if still active) overlap. Confluence has to mean "these levels
// were simultaneously live," not "these two timeframes each had a zone near this price at some
// point in unrelated history."
//
// Known simplification, not hidden: confluence is computed ONCE per zone, over its whole
// lifetime's overlap with others -- not re-evaluated moment-by-moment as other zones expire or
// get created during that lifetime. A zone's confluence count is a lifetime-level property here,
// not a live/point-in-time one. Good enough for "did lifetime-level confluence predict a higher
// hold rate," not for "what was the confluence reading at the exact moment of touch N."

const PRICE_TOLERANCE_PCT = 0.002; // 0.2% of price -- a starting assumption, see header note.

function tolerance(zone) {
  return zone.price * PRICE_TOLERANCE_PCT;
}

function timeOverlaps(a, b) {
  const aEnd = a.expiresTime ?? Infinity;
  const bEnd = b.expiresTime ?? Infinity;
  return a.confirmedTime <= bEnd && b.confirmedTime <= aEnd;
}

// allZones: flat array across all timeframes, each needs {id, timeframe, side, price,
// confirmedTime, expiresTime, atrAtCreation}. Mutates each zone in place, adding:
//   confluentZoneIds: ids of all other zones (any timeframe) that are price-close, time-
//     overlapping, and same-side.
//   confluenceCount: number of DISTINCT TIMEFRAMES among {this zone + its confluent zones} --
//     the cross-timeframe hierarchy metric (1 = isolated, no other timeframe agrees).
//   sameTimeframeClusterSize: how many of the confluent zones share THIS zone's own timeframe --
//     the "2-3 lines bunched on one timeframe" metric.
export function computeConfluence(allZones) {
  for (const z of allZones) z.confluentZoneIds = [];

  const sorted = [...allZones].sort((a, b) => a.price - b.price);
  const maxTolBound = Math.max(...allZones.map(tolerance), 0);
  const n = sorted.length;

  for (let i = 0; i < n; i++) {
    const a = sorted[i];
    for (let j = i + 1; j < n; j++) {
      const b = sorted[j];
      if (b.price - a.price > maxTolBound) break; // sorted by price -- no further candidates possible
      if (a.side !== b.side) continue;
      const tol = Math.max(tolerance(a), tolerance(b));
      if (b.price - a.price > tol) continue;
      if (!timeOverlaps(a, b)) continue;
      a.confluentZoneIds.push(b.id);
      b.confluentZoneIds.push(a.id);
    }
  }

  const byId = new Map(allZones.map((z) => [z.id, z]));
  for (const z of allZones) {
    const timeframes = new Set([z.timeframe]);
    let sameTimeframeCount = 0;
    for (const id of z.confluentZoneIds) {
      const other = byId.get(id);
      timeframes.add(other.timeframe);
      if (other.timeframe === z.timeframe) sameTimeframeCount++;
    }
    z.confluenceCount = timeframes.size;
    z.sameTimeframeClusterSize = sameTimeframeCount;
  }

  return allZones;
}
