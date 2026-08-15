#!/usr/bin/env node
// Cross-INDICATOR confluence test, structure variant (2026-08-05): cross-confluence-significance.js
// tested Divergence-for-Many zones against SMC order blocks and EQH/EQL liquidity levels and found
// no significant effect (re-run same day: r=0.0058, p=0.153, n=38 "both" zones -- see that file's
// results/). It never queried structure_events (BOS/CHoCH) at all -- so the question "does a recent
// BOS/CHoCH break near a divergence zone's price make that zone hold more reliably" was never
// tested, not falsified. This script tests exactly that, isolated from the already-tested OB/EQH
// signal so the result is directly interpretable.
//
// Definition:
//   structConfluence = the MOST RECENT structure_event (BOS or CHOCH, either scope, any timeframe,
//                       same side, time <= zone's confirmed_time) is within PRICE_TOLERANCE_PCT of
//                       the zone's price.
//   "Most recent, any age" deliberately reuses this project's own established biasAt() convention
//   (scripts/signal-bus/cross-confluence/breakout-bias-backtest.js:47-53,
//    scripts/signal-bus/vmc-cipher-b/divergence-smc-bias-stacking.js:59-67) for WHICH structure event
//   to consider -- BOS/CHoCH have no expiry/mitigation field in this schema (unlike order blocks and
//   EQH/EQL, which do), so there is no house convention for bounding lookback by age, and the
//   existing convention here is explicitly unbounded, not silently missing. What's NEW in this
//   script is applying a price-tolerance check to that most-recent event, which biasAt() never did
//   (biasAt only reads side/direction, not price level).
//   Side-matched the same way as cross-confluence-significance.js: divergence "bullish" (support)
//   <-> structure "bullish" (an upward break); divergence "bearish" (resistance) <-> "bearish".
//
// Zone-level permutation, same discipline as cross-confluence-significance.js: label shuffled at
// the ZONE level, each zone keeps its own real touch outcomes.
//
// Usage: node scripts/signal-bus/cross-confluence/structure-confluence-significance.js --iterations=20000

import { DatabaseSync } from "node:sqlite";
import { writeFileSync, mkdirSync } from "fs";
import { execSync } from "child_process";

const DIV_DB_PATH = new URL("../../../data/signal-bus/divergence-for-many.db", import.meta.url);
const SMC_DB_PATH = new URL("../../../data/signal-bus/smc.db", import.meta.url);

const args = Object.fromEntries(process.argv.slice(2).map((a) => a.replace(/^--/, "").split("=")));
const ITERATIONS = parseInt(args.iterations || "20000", 10);
const SEED = parseInt(args.seed || "42", 10);
// Default matches confluence.js / cross-confluence-significance.js's flat 0.2% tolerance. Overriding
// this via --tolerance is a single disclosed parameter choice (e.g. 2026-08-05: iapaulo asked to
// widen to 0.6% after 0.2% found the live 69685-vs-72055 example itself fell outside tolerance) --
// NOT a scan across thresholds hunting for significance. If this file is ever run at multiple
// tolerance values, all runs and their results must be reported, not just the one that clears 5%.
const PRICE_TOLERANCE_PCT = parseFloat(args.tolerance || "0.002");

function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function shuffle(arr, rng) {
  const out = [...arr];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}
function pointBiserial(xs, ys) {
  const n = xs.length;
  const meanX = xs.reduce((s, x) => s + x, 0) / n;
  const meanY = ys.reduce((s, y) => s + y, 0) / n;
  let cov = 0, varX = 0, varY = 0;
  for (let i = 0; i < n; i++) {
    const dx = xs[i] - meanX, dy = ys[i] - meanY;
    cov += dx * dy; varX += dx * dx; varY += dy * dy;
  }
  return varX === 0 || varY === 0 ? 0 : cov / Math.sqrt(varX * varY);
}
function gitCommit() {
  try {
    return execSync("git rev-parse HEAD", { cwd: new URL("../../../", import.meta.url), encoding: "utf8" }).trim();
  } catch {
    return "unknown";
  }
}

// Binary search: most recent structure event, same side, time <= t. Same rule as biasAt() in
// breakout-bias-backtest.js:47-53, but returning the event (for its price) not just its side.
function mostRecentStructureEvent(sortedEvents, t) {
  let lo = 0, hi = sortedEvents.length - 1, ans = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (sortedEvents[mid].time <= t) { ans = mid; lo = mid + 1; } else { hi = mid - 1; }
  }
  return ans === -1 ? null : sortedEvents[ans];
}

export function runStructureConfluenceSignificanceTest({ iterations = ITERATIONS, seed = SEED, divDbPath = DIV_DB_PATH, smcDbPath = SMC_DB_PATH } = {}) {
  const dbDiv = new DatabaseSync(divDbPath, { readOnly: true });
  const zones = dbDiv.prepare(`SELECT id, timeframe, side, price, confirmed_time FROM zones`).all();
  const touches = dbDiv.prepare(`SELECT zone_id, outcome FROM touches`).all();
  dbDiv.close();

  const dbSmc = new DatabaseSync(smcDbPath, { readOnly: true });
  const allEvents = dbSmc.prepare(`SELECT side, time, price FROM structure_events ORDER BY time ASC`).all();
  dbSmc.close();

  const eventsBySide = {
    bullish: allEvents.filter((e) => e.side === "bullish"),
    bearish: allEvents.filter((e) => e.side === "bearish"),
  };

  const touchesByZone = new Map();
  for (const t of touches) {
    if (!touchesByZone.has(t.zone_id)) touchesByZone.set(t.zone_id, []);
    touchesByZone.get(t.zone_id).push(t.outcome === "held" ? 1 : 0);
  }

  const enriched = zones
    .filter((z) => touchesByZone.has(z.id))
    .map((z) => {
      const candidates = eventsBySide[z.side];
      const recent = mostRecentStructureEvent(candidates, z.confirmed_time);
      const structConfluence = recent != null && Math.abs(recent.price - z.price) / z.price <= PRICE_TOLERANCE_PCT;
      return { ...z, structConfluence, outcomes: touchesByZone.get(z.id) };
    });

  const byCategory = {};
  for (const name of ["no-structure", "structure"]) {
    const zs = enriched.filter((z) => (name === "structure" ? z.structConfluence : !z.structConfluence));
    const outs = zs.flatMap((z) => z.outcomes);
    byCategory[name] = { zoneCount: zs.length, touchCount: outs.length, holdRate: outs.length ? outs.reduce((s, o) => s + o, 0) / outs.length : null };
  }

  const realLabels = enriched.map((z) => (z.structConfluence ? 1 : 0));
  const realConfPerTouch = [], realOutPerTouch = [];
  for (const z of enriched) for (const o of z.outcomes) { realConfPerTouch.push(z.structConfluence ? 1 : 0); realOutPerTouch.push(o); }
  const realR = pointBiserial(realConfPerTouch, realOutPerTouch);

  function gapFor(labels) {
    let held1 = 0, n1 = 0, held0 = 0, n0 = 0;
    for (let i = 0; i < enriched.length; i++) {
      for (const o of enriched[i].outcomes) {
        if (labels[i] === 1) { n1++; held1 += o; } else { n0++; held0 += o; }
      }
    }
    if (n1 === 0 || n0 === 0) return null;
    return held1 / n1 - held0 / n0;
  }
  const realGap = gapFor(realLabels);

  const rng = mulberry32(seed);
  const permutedR = [], permutedGaps = [];
  for (let iter = 0; iter < iterations; iter++) {
    const shuffled = shuffle(realLabels, rng);
    const confPerTouch = [], outPerTouch = [];
    for (let i = 0; i < enriched.length; i++) for (const o of enriched[i].outcomes) { confPerTouch.push(shuffled[i]); outPerTouch.push(o); }
    permutedR.push(pointBiserial(confPerTouch, outPerTouch));
    const gap = gapFor(shuffled);
    if (gap != null) permutedGaps.push(gap);
  }
  permutedR.sort((a, b) => a - b);
  permutedGaps.sort((a, b) => a - b);
  const pR = permutedR.filter((r) => r >= realR).length / permutedR.length;
  const pGap = permutedGaps.filter((g) => g >= realGap).length / permutedGaps.length;

  return {
    zoneCount: enriched.length,
    touchCount: enriched.reduce((s, z) => s + z.outcomes.length, 0),
    iterations,
    seed,
    byCategory,
    correlation: { real: realR, p: pR, permutedMean: permutedR.reduce((s, x) => s + x, 0) / permutedR.length, permutedRange: [permutedR[0], permutedR[permutedR.length - 1]] },
    gap: { real: realGap, p: pGap, permutedMean: permutedGaps.reduce((s, x) => s + x, 0) / permutedGaps.length, permutedRange: [permutedGaps[0], permutedGaps[permutedGaps.length - 1]] },
  };
}

function main() {
  const result = runStructureConfluenceSignificanceTest({ iterations: ITERATIONS, seed: SEED });
  console.log(`Loaded ${result.zoneCount} divergence zones with touches (${result.touchCount} touches), cross-referenced against SMC structure_events (BOS/CHoCH).\n`);

  console.log("=== Hold rate by structure confluence category (descriptive) ===");
  for (const [name, c] of Object.entries(result.byCategory)) {
    console.log(`  ${name.padEnd(14)} zones=${c.zoneCount}  touches=${c.touchCount}  hold_rate=${c.holdRate != null ? (c.holdRate * 100).toFixed(1) + "%" : "n/a"}`);
  }

  console.log(`\nReal point-biserial correlation (structConfluence vs held/broken): r = ${result.correlation.real.toFixed(4)}`);
  console.log(`Real gap (structure hold% - no-structure hold%): ${(result.gap.real * 100).toFixed(2)} points`);

  console.log(`\n--- Permutation test (${ITERATIONS} iterations, zone-level shuffle, seed=${SEED}) ---`);
  console.log(`Correlation: permuted mean=${result.correlation.permutedMean.toFixed(4)}, range=[${result.correlation.permutedRange[0].toFixed(4)}, ${result.correlation.permutedRange[1].toFixed(4)}]`);
  console.log(`  p=${result.correlation.p.toFixed(4)} ${result.correlation.p < 0.05 ? "(significant at 5%)" : "(NOT significant at 5%)"}`);
  console.log(`Gap: permuted mean=${(result.gap.permutedMean * 100).toFixed(2)} pts, range=[${(result.gap.permutedRange[0] * 100).toFixed(2)}, ${(result.gap.permutedRange[1] * 100).toFixed(2)}]`);
  console.log(`  p=${result.gap.p.toFixed(4)} ${result.gap.p < 0.05 ? "(significant at 5%)" : "(NOT significant at 5%)"}`);

  const pR = result.correlation.p, pGap = result.gap.p;
  console.log(`\nVerdict: ${pR < 0.05 && pGap < 0.05 ? "Both statistics clear 5% -- structure confluence looks real, not a labeling artifact." : pR < 0.05 || pGap < 0.05 ? "Mixed -- one statistic clears 5%, the other doesn't. Treat as unresolved, not confirmed." : "Neither statistic clears 5% -- not distinguishable from randomly relabeling zones. Does NOT survive the test."}`);

  const RESULTS_DIR = new URL("results/", import.meta.url);
  mkdirSync(RESULTS_DIR, { recursive: true });
  const out = { ...result, git_commit: gitCommit(), generated_at: new Date().toISOString() };
  const fname = `structure_confluence_significance_${out.generated_at.replace(/[:.]/g, "-")}.json`;
  writeFileSync(new URL(fname, RESULTS_DIR), JSON.stringify(out, null, 2));
  console.log(`\nSaved: ${new URL(fname, RESULTS_DIR).pathname.replace(/^\/([A-Z]:)/, "$1")}`);
}

if (import.meta.url === `file://${process.argv[1].replace(/\\/g, "/")}` || import.meta.url === `file:///${process.argv[1].replace(/\\/g, "/")}`) {
  main();
}
