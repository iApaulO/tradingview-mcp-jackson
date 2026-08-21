// Shared builder for CO-OCCURRENCE CLUSTERS of SMC structure events, extracted 2026-08-16.
//
// Extracted because this was about to be its third hand-written copy (cooccurrence-vs-order.js plus
// two inline diagnostic runs), and three copies of a population definition is how two of them
// silently diverge -- the same reasoning that produced lib/strategy-g-population.js.
//
// WHAT A CLUSTER IS, AND WHY IT IS ORDER-BLIND. Register #137 established that the informative
// multi-timeframe variable is BREADTH OF AGREEMENT (how many rungs broke the same way inside a
// window), not the ORDER they broke in: cluster size K is significant rung-stratified on both
// instruments (BTC +0.2076pp, ETH +0.3739pp, both p=0.0000) while the order label is null once size
// is controlled (p=0.1226 / p=0.4200). Clustering is therefore done WITHOUT reference to sequence,
// and the order label is attached afterwards purely for diagnostics.
//
// #137 also recorded two structural facts that any consumer needs to know before slicing this:
//   * 'mixed' order is IMPOSSIBLE at K=2 -- with two events one is necessarily first -- so mixed
//     exists only at K>=3. Comparing order labels without controlling K compares size distributions.
//   * 'bottom_up' does not exist at K>=3 AT ALL (zero instances, both instruments). Strictly
//     fine-to-coarse ordering across three or more rungs essentially never occurs.
//
// available_at: a cluster is not observable until its LAST member fires, so `knownAtTime` is the
// max member time and is the only valid key for any forward test. The window is scaled to the
// COARSEST rung present and can only widen as coarser rungs join -- the symmetric rule from #135,
// chosen because scaling to either the initiating or the responding rung biases one travel
// direction and would manufacture a directional result.

import { DatabaseSync } from "node:sqlite";
import { dbSuffix } from "../../lib/instrument.js";
import { HOUSE_LADDER, RUNG_SECONDS } from "../../lib/mtf-state.js";

// MIGRATED 2026-08-21: the ladder is now DERIVED from the shared MTF layer rather than restated
// here. Two copies of an eight-rung list is how the two drift apart silently; the shape of this
// export is unchanged so every consumer is unaffected.
export const LADDER = HOUSE_LADDER.map((tf) => ({ tf, sec: RUNG_SECONDS[tf] }));
const IDX = new Map(LADDER.map((l, i) => [l.tf, i]));

const smcDbFor = (instrument) =>
  new URL(`../../../../data/signal-bus/smc${dbSuffix(instrument)}.db`, import.meta.url);

// scope: 'swing' (default) matches every cascade/co-occurrence row logged so far.
// chochOnly narrows to reversals; #135 built both families.
export function loadStructureEvents(instrument, { scope = "swing", chochOnly = false } = {}) {
  const db = new DatabaseSync(smcDbFor(instrument), { readOnly: true });
  const extra = chochOnly ? "AND type = 'CHOCH'" : "";
  const all = [];
  for (const { tf } of LADDER) {
    const rows = db.prepare(
      `SELECT time, side AS direction, price FROM structure_events WHERE timeframe = ? AND scope = ? ${extra} ORDER BY time`,
    ).all(tf, scope);
    for (const r of rows) all.push({ ...r, rung: tf, rungIdx: IDX.get(tf) });
  }
  db.close();
  all.sort((a, b) => a.time - b.time);
  return all;
}

export function buildCooccurrenceClusters(events, { mult = 1 } = {}) {
  const used = new Array(events.length).fill(false);
  const clusters = [];

  for (let i = 0; i < events.length; i++) {
    if (used[i]) continue;
    const seed = events[i];
    const members = [seed];
    const rungs = new Set([seed.rung]);
    let windowSec = mult * LADDER[seed.rungIdx].sec;
    used[i] = true;

    for (let j = i + 1; j < events.length; j++) {
      if (used[j]) continue;
      const cand = events[j];
      // events are time-sorted, so once past the window nothing later can qualify
      if (cand.time - seed.time > windowSec) break;
      if (cand.direction !== seed.direction) continue;
      if (rungs.has(cand.rung)) continue; // one event per rung per cluster
      members.push(cand);
      rungs.add(cand.rung);
      used[j] = true;
      windowSec = Math.max(windowSec, mult * LADDER[cand.rungIdx].sec); // widens only
    }

    // Order label computed AFTER clustering, so clustering itself stays order-blind.
    const byTime = [...members].sort((a, b) => a.time - b.time);
    let strictDown = true, strictUp = true;
    for (let k = 1; k < byTime.length; k++) {
      if (byTime[k].rungIdx <= byTime[k - 1].rungIdx) strictDown = false;
      if (byTime[k].rungIdx >= byTime[k - 1].rungIdx) strictUp = false;
    }
    const finest = members.reduce((a, b) => (b.rungIdx > a.rungIdx ? b : a));
    const coarsest = members.reduce((a, b) => (b.rungIdx < a.rungIdx ? b : a));

    clusters.push({
      K: members.length,
      order: members.length === 1 ? "single" : strictDown ? "top_down" : strictUp ? "bottom_up" : "mixed",
      direction: seed.direction,
      knownAtTime: Math.max(...members.map((m) => m.time)),
      outcomeRung: finest.rung,
      coarsestRung: coarsest.rung,
      rungs: [...rungs],
    });
  }
  return clusters.sort((a, b) => a.knownAtTime - b.knownAtTime);
}
