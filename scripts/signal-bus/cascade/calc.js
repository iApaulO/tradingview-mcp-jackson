// CASCADE ENCODING -- multi-timeframe regime propagation as an ORDERED SEQUENCE OVER TIME.
//
// WHY THIS EXISTS, AND WHY EVERY PRIOR MEASUREMENT MISSED IT.
// Rows #128 through #134 all encoded multi-timeframe context as a STATIC SNAPSHOT: each rung's
// direction at a bar (#128/#131), the agreement depth D at a bar (#132/#133), the trade's
// alignment with one rung (#133/#134). Every one of those is a state vector sampled at an instant.
//
// iapaulo's correction (2026-08-15): the object being claimed is not a state, it is a TRAJECTORY --
// "the 4h initiates, then the daily follows, then the lower timeframes apply." A cascade has an
// ORDER, a DIRECTION OF PROPAGATION, a LATENCY between steps, and a point where it either completes
// or STALLS. None of those properties can be represented by a snapshot, so no test built on
// snapshots could have detected them regardless of how the statistics were done. This is a defect
// in the encoding, not in the null models or the sample sizes.
//
// This maps directly onto EEH-CITI-1.0 §19 (Sequence Intelligence): "Sequence identity may matter
// more than any individual element."
//
// WHAT A CASCADE IS HERE. Starting from a flip at some rung k in direction X, the cascade extends
// to rung k+1 (the next FINER rung) if that rung also flips to X, strictly AFTER the parent flip
// and within a propagation window scaled to the PARENT rung's bar duration. It continues down the
// ladder until a rung fails to follow within its window -- that rung is the STALL point. Strict
// time-ordering is the entire content of the hypothesis: a cascade where the 15m flipped before the
// daily is not the same object as one where the daily led, even if the end state is identical.
//
// TOP-DOWN vs BOTTOM-UP. The same detector is run in reverse (fine -> coarse) to produce bottom-up
// cascades. This is the control that the snapshot tests never had: if top-down propagation carries
// information because HTF leads LTF, then bottom-up sequences over the same data should behave
// differently. If the two are indistinguishable, "top-down" is not the mechanism.
//
// LOOK-AHEAD. A cascade is only knowable at the moment its LAST participating rung flips, and a
// STALL is only knowable once the window on the next rung has fully elapsed. Both are recorded
// explicitly (`knownAtTime` and `stallConfirmedTime`) and they are NOT the same instant. Using the
// cascade's start time as its timestamp would be look-ahead of exactly the kind that produced this
// project's two shipped bugs.

// Coarse -> fine. Index 0 is the slowest rung; "top-down" means increasing index.
export const LADDER = [
  { tf: "1w", sec: 604800 },
  { tf: "1d", sec: 86400 },
  { tf: "4h", sec: 14400 },
  { tf: "3h", sec: 10800 },
  { tf: "2h", sec: 7200 },
  { tf: "1h", sec: 3600 },
  { tf: "15m", sec: 900 },
  { tf: "5m", sec: 300 },
];

// Propagation window, scale-relative rather than absolute so the same rule means the same thing at
// every rung. Which rung it scales to is a REAL modelling choice with no obviously correct answer,
// so it is an explicit parameter rather than a buried constant:
//   'parent'  -- the rung that just moved sets the clock.
//   'child'   -- the responding rung gets WINDOW_MULT of ITS OWN bars to react.
//   'coarser' -- the SLOWER of the two rungs sets the clock, whichever direction we are travelling.
//
// 'coarser' IS THE DEFAULT AND THE ONLY ONE VALID FOR TOP-DOWN vs BOTTOM-UP COMPARISON, because it
// is the only rule that is SYMMETRIC between the two directions. Measured directly (window-rule
// sweep, 2026-08-15): under 'child' scaling the coarser rung is always the responder in a bottom-up
// cascade, so it receives a long absolute window and bottom-up chains far more easily -- 5,174
// bottom-up cascades versus 927 top-down at mult=8. Under 'parent' scaling the bias runs the other
// way. Either would have manufactured a directional asymmetry that is a property of the WINDOW
// RULE, not of the market. With 'coarser', the 1w<->1d step uses the weekly duration in both
// directions, so the comparison is fair by construction.
//
// A result that exists under only one window rule is a result about the rule; sweep before trusting.
export const DEFAULT_WINDOW_MULT = 2;
export const DEFAULT_WINDOW_SCALE = "coarser";

// flipsByTf: Map<tf, [{time, direction, price, barIdx}, ...]> sorted ascending by time.
// Returns cascade objects for every possible starting rung; callers filter to maximal ones.
export function computeCascades(flipsByTf, { windowMult = DEFAULT_WINDOW_MULT, windowScale = DEFAULT_WINDOW_SCALE, topDown = true } = {}) {
  const order = topDown ? LADDER.map((_, i) => i) : LADDER.map((_, i) => LADDER.length - 1 - i);
  const cascades = [];

  for (let oi = 0; oi < order.length; oi++) {
    const startIdx = order[oi];
    const startTf = LADDER[startIdx].tf;
    const starts = flipsByTf.get(startTf) || [];

    for (const seed of starts) {
      const dir = seed.direction;
      const steps = [{ rung: startTf, rungIdx: startIdx, time: seed.time, price: seed.price }];
      let lastTime = seed.time;
      let parentIdx = startIdx;
      let stalledAt = null, stallConfirmedTime = null;

      for (let k = oi + 1; k < order.length; k++) {
        const childIdx = order[k];
        const childTf = LADDER[childIdx].tf;
        const scaleSec =
          windowScale === "parent" ? LADDER[parentIdx].sec
          : windowScale === "child" ? LADDER[childIdx].sec
          : Math.max(LADDER[parentIdx].sec, LADDER[childIdx].sec); // 'coarser' -- symmetric
        const windowSec = windowMult * scaleSec;
        const deadline = lastTime + windowSec;
        const childFlips = flipsByTf.get(childTf) || [];
        // First same-direction flip strictly after the parent and inside the window.
        const hit = childFlips.find((f) => f.direction === dir && f.time > lastTime && f.time <= deadline);
        if (!hit) {
          stalledAt = childTf;
          // A stall is only CONFIRMED once the window has fully elapsed -- not at the parent flip.
          stallConfirmedTime = deadline;
          break;
        }
        steps.push({ rung: childTf, rungIdx: childIdx, time: hit.time, price: hit.price });
        lastTime = hit.time;
        parentIdx = childIdx;
      }

      const depth = steps.length;
      if (depth < 2) continue; // a single flip is not a cascade

      // Latency of each step expressed in the RECEIVING rung's own bars -- scale-free, so a 1w->1d
      // latency and a 1h->15m latency are directly comparable.
      const latencies = [];
      for (let s = 1; s < steps.length; s++) {
        const recvSec = LADDER[steps[s].rungIdx].sec;
        latencies.push((steps[s].time - steps[s - 1].time) / recvSec);
      }

      cascades.push({
        direction: dir,
        propagation: topDown ? "top_down" : "bottom_up",
        startRung: startTf,
        startRungIdx: startIdx,
        endRung: steps[steps.length - 1].rung,
        endRungIdx: steps[steps.length - 1].rungIdx,
        depth,
        // reachedEnd means "ran out of ladder without stalling" -- which for a cascade that STARTED
        // at 15m only means it got to 5m. It is NOT the same as traversing the ladder, and
        // conflating the two overstates how often full propagation happens.
        reachedEnd: stalledAt === null,
        fullLadder: depth === LADDER.length,
        stalledAt,
        startTime: seed.time,
        // The instant the cascade's last rung actually flipped -- the earliest time the completed
        // sequence is observable. THIS is the timestamp any forward test must key on.
        knownAtTime: lastTime,
        // When a stall becomes knowable, which is strictly later than knownAtTime.
        stallConfirmedTime,
        totalSpanSec: lastTime - seed.time,
        latencies,
        meanLatencyBars: latencies.length ? latencies.reduce((a, b) => a + b, 0) / latencies.length : null,
        steps,
      });
    }
  }
  return cascades;
}

// A cascade starting at rung k is a strict sub-sequence of one starting at k-1 if the deeper one
// also passed through k at the same time. Keeping both would double-count the same propagation, so
// analyses generally want only MAXIMAL cascades: those not contained in a longer one.
export function maximalCascades(cascades) {
  const byKey = new Map();
  for (const c of cascades) {
    // Two cascades are the same propagation if they end at the same rung, at the same instant, in
    // the same direction. Among those, the one that started highest up the ladder is maximal.
    const key = `${c.direction}|${c.propagation}|${c.endRung}|${c.knownAtTime}`;
    const prev = byKey.get(key);
    if (!prev || c.depth > prev.depth) byKey.set(key, c);
  }
  return [...byKey.values()].sort((a, b) => a.knownAtTime - b.knownAtTime);
}
