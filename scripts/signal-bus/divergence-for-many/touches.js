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
// This label is direction-agnostic by construction (it only asks "which side did price end up
// on", not "which side did it come from") -- correct regardless of approach, but it throws away
// information: a support zone re-tested from BELOW after already breaking once is the classical
// "old support becomes resistance" polarity-flip retest, a materially different event than a
// fresh descent-and-defend, even though both could resolve as "held". approachDirection +
// polarityFlipRetest (added 2026-07-25, prompted by a direct question about this exact case) fix
// that: approachDirection is read from the close of the bar immediately before the interaction
// started (always available -- it's a real prior candle in the full series, independent of the
// zone's own confirmed/expired lifecycle window). polarityFlipRetest is true when a zone is
// approached from the side OPPOSITE its natural creation side (bullish zones are naturally
// approached from above; bearish from below) -- the actual signature of a level's role flipping.
//
// maxPenetration: how far price pushed beyond the level during the interaction (wick depth) --
// magnitude of the test, not just a binary outcome, for later "does confluence predict a stronger
// reaction" analysis (see the research-protocol-shaped hypothesis from the 2026-07-25 discussion).

// BUG FIX 2026-07-25: originally `bar.l <= price` (bullish) / `bar.h >= price` (bearish) alone --
// which is ALSO true for every bar entirely past the level and still drifting further away, not
// just bars genuinely reaching it. That silently merged "broke and drifted off for 100+ bars"
// into one continuous "interaction" with the drift counted as penetration, and made a
// re-approach-from-the-far-side impossible to ever detect (the "interaction" never ended long
// enough to start a new one) -- caught by asking what should happen on a from-below retest, which
// surfaced 0 polarity-flip retests out of 17,037 touches, an implausible result that was the tell.
// Correct definition: the bar's own range has to actually contain the price level.
function isTouching(bar, zone) {
  return bar.l <= zone.price && bar.h >= zone.price;
}

function penetration(bar, zone) {
  return zone.side === "bullish" ? Math.max(0, zone.price - bar.l) : Math.max(0, bar.h - zone.price);
}

function resolveOutcome(lastClose, zone) {
  return zone.side === "bullish" ? (lastClose > zone.price ? "held" : "broken") : lastClose < zone.price ? "held" : "broken";
}

function naturalSide(zone) {
  return zone.side === "bullish" ? "above" : "below";
}

export function detectTouches(candles, zone) {
  const startBar = zone.confirmedBarIdx;
  const endBar = zone.expiresBarIdx != null ? Math.min(zone.expiresBarIdx, candles.length - 1) : candles.length - 1;
  const interactions = [];
  let current = null;

  for (let i = startBar; i <= endBar; i++) {
    const bar = candles[i];
    if (isTouching(bar, zone)) {
      if (!current) {
        const priorClose = i > 0 ? candles[i - 1].c : bar.c;
        const approachDirection = priorClose > zone.price ? "above" : priorClose < zone.price ? "below" : "at";
        current = {
          startBarIdx: i,
          startTime: bar.t,
          barsCount: 0,
          maxPenetration: 0,
          approachDirection,
          polarityFlipRetest: approachDirection !== "at" && approachDirection !== naturalSide(zone),
        };
      }
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
