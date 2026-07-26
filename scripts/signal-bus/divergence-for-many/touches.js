// Touch/interaction detection for zones produced by calc.js. This is the piece that turns a zone
// list ("these levels existed") into the actual narrative ("price tested this level twice before
// breaking, then the next higher-timeframe level caught it") -- see the 2026-07-25 discussion:
// zones alone don't capture that, interaction sequences do.
//
// An "interaction" is a maximal run of consecutive bars where price reaches the zone's price
// (bar.low <= price for a bullish/support zone, bar.high >= price for a bearish/resistance zone).
// Consecutive touching bars are ONE interaction, not one per bar -- "touched it twice" means two
// separate approach-and-resolve events, not five bars in a row counted as five touches. A new
// interaction starts only after price has moved away (no longer touching) and comes back.
//
// outcome: "held" if the interaction's last bar closed back on the zone's defended side (above
// price for bullish/support, below price for bearish/resistance) -- "broken" if it closed through.
// maxPenetration: how far price pushed beyond the level during the interaction (wick depth) --
// magnitude of the test, not just a binary outcome, for later "does confluence predict a stronger
// reaction" analysis (see the research-protocol-shaped hypothesis from the 2026-07-25 discussion).

function isTouching(bar, zone) {
  return zone.side === "bullish" ? bar.l <= zone.price : bar.h >= zone.price;
}

function penetration(bar, zone) {
  return zone.side === "bullish" ? Math.max(0, zone.price - bar.l) : Math.max(0, bar.h - zone.price);
}

function resolveOutcome(lastClose, zone) {
  return zone.side === "bullish" ? (lastClose > zone.price ? "held" : "broken") : lastClose < zone.price ? "held" : "broken";
}

export function detectTouches(candles, zone) {
  const startBar = zone.confirmedBarIdx;
  const endBar = zone.expiresBarIdx != null ? Math.min(zone.expiresBarIdx, candles.length - 1) : candles.length - 1;
  const interactions = [];
  let current = null;

  for (let i = startBar; i <= endBar; i++) {
    const bar = candles[i];
    if (isTouching(bar, zone)) {
      if (!current) current = { startBarIdx: i, startTime: bar.t, barsCount: 0, maxPenetration: 0 };
      current.barsCount++;
      const p = penetration(bar, zone);
      if (p > current.maxPenetration) current.maxPenetration = p;
      current.endBarIdx = i;
      current.endTime = bar.t;
      current.lastClose = bar.c;
    } else if (current) {
      current.outcome = resolveOutcome(current.lastClose, zone);
      interactions.push(current);
      current = null;
    }
  }
  if (current) {
    current.outcome = resolveOutcome(current.lastClose, zone);
    current.ongoing = zone.status === "active" && endBar === candles.length - 1;
    interactions.push(current);
  }
  return interactions;
}

// Attaches `.touches` to every zone in place and returns the same array, for convenience.
export function computeAllTouches(candles, zones) {
  for (const zone of zones) {
    zone.touches = detectTouches(candles, zone);
  }
  return zones;
}
