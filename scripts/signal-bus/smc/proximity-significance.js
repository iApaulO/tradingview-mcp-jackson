#!/usr/bin/env node
// Permutation significance test for proximityCount (total near-miss events on an order block, see
// proximity.js/ARCHITECTURE.md §12) vs. hold rate -- exact same method as
// confluence-significance.js and recurrence-significance.js (order-block-level shuffle, not
// touch-level, to avoid pseudo-replicating a block's own touches as independent observations).
// Tests the question §12 left explicitly open: does a level that gets "respected from a distance"
// repeatedly also tend to hold better when actually touched?
//
// Usage: node scripts/signal-bus/smc/proximity-significance.js --iterations=50000

import { DatabaseSync } from "node:sqlite";

const DB_PATH = new URL("../../../data/signal-bus/smc.db", import.meta.url);

const args = Object.fromEntries(process.argv.slice(2).map((a) => a.replace(/^--/, "").split("=")));
const ITERATIONS = parseInt(args.iterations || "5000", 10);
const SEED = parseInt(args.seed || "42", 10);

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
    cov += dx * dy;
    varX += dx * dx;
    varY += dy * dy;
  }
  return varX === 0 || varY === 0 ? 0 : cov / Math.sqrt(varX * varY);
}

// Top = literal max observed (mirrors confluence/recurrence's own method for comparability across
// all three metrics) -- disclosed as thin where it is, not hidden. Bottom = zero near-misses,
// the natural "isolated" baseline for this metric (unlike confluence/recurrence, 0 is a real,
// common value here, not absent).
function topVsBottomGap(xs, ys) {
  let heldTop = 0, nTop = 0, heldBottom = 0, nBottom = 0;
  const maxX = Math.max(...xs);
  for (let i = 0; i < xs.length; i++) {
    if (xs[i] === 0) { nBottom++; heldBottom += ys[i]; }
    else if (xs[i] === maxX) { nTop++; heldTop += ys[i]; }
  }
  if (nTop === 0 || nBottom === 0) return null;
  return { gap: heldTop / nTop - heldBottom / nBottom, nTop, nBottom, maxX };
}

export function runProximitySignificanceTest({ iterations = 5000, seed = 42, dbPath = DB_PATH } = {}) {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  const obRows = db.prepare(
    `SELECT ob.id as ob_id, COUNT(obp.id) as proximity_count
     FROM order_blocks ob LEFT JOIN order_block_proximity_events obp ON obp.order_block_id = ob.id
     GROUP BY ob.id`,
  ).all();
  const touchRows = db.prepare(
    `SELECT order_block_id as ob_id, outcome FROM order_block_touches`,
  ).all();
  db.close();

  const proximityById = new Map(obRows.map((r) => [r.ob_id, r.proximity_count]));
  const obMap = new Map();
  for (const t of touchRows) {
    if (!proximityById.has(t.ob_id)) continue;
    if (!obMap.has(t.ob_id)) obMap.set(t.ob_id, { proximityCount: proximityById.get(t.ob_id), outcomes: [] });
    obMap.get(t.ob_id).outcomes.push(t.outcome === "held" ? 1 : 0);
  }
  const obs = [...obMap.values()];

  const realLabels = obs.map((o) => o.proximityCount);
  const realX = [], realY = [];
  for (const o of obs) for (const y of o.outcomes) { realX.push(o.proximityCount); realY.push(y); }

  const realR = pointBiserial(realX, realY);
  const realGapInfo = topVsBottomGap(realX, realY);
  const realGap = realGapInfo?.gap;

  const rng = mulberry32(seed);
  const permutedR = [], permutedGaps = [];
  for (let iter = 0; iter < iterations; iter++) {
    const shuffled = shuffle(realLabels, rng);
    const px = [], py = [];
    for (let i = 0; i < obs.length; i++) {
      for (const y of obs[i].outcomes) { px.push(shuffled[i]); py.push(y); }
    }
    permutedR.push(pointBiserial(px, py));
    const g = topVsBottomGap(px, py);
    if (g != null) permutedGaps.push(g.gap);
  }
  permutedR.sort((a, b) => a - b);
  permutedGaps.sort((a, b) => a - b);

  const pR = permutedR.filter((r) => r >= realR).length / permutedR.length;
  const pGap = realGap == null ? null : permutedGaps.filter((g) => g >= realGap).length / permutedGaps.length;

  // Descriptive: hold rate by proximityCount bucket (0, 1-2, 3-5, 6-10, 11+) -- raw per-count
  // buckets would be too sparse/noisy past ~10, so bucket coarser for the write-up table while
  // keeping the correlation/gap stats on the raw counts above.
  function bucketOf(c) {
    if (c === 0) return "0";
    if (c <= 2) return "1-2";
    if (c <= 5) return "3-5";
    if (c <= 10) return "6-10";
    return "11+";
  }
  const byBucket = new Map();
  const obCountByBucket = new Map();
  for (const o of obs) obCountByBucket.set(bucketOf(o.proximityCount), (obCountByBucket.get(bucketOf(o.proximityCount)) || 0) + 1);
  for (let i = 0; i < realX.length; i++) {
    const b = bucketOf(realX[i]);
    if (!byBucket.has(b)) byBucket.set(b, { n: 0, held: 0 });
    byBucket.get(b).n++;
    byBucket.get(b).held += realY[i];
  }

  const bucketOrder = ["0", "1-2", "3-5", "6-10", "11+"];
  return {
    obCount: obs.length,
    touchCount: touchRows.length,
    iterations,
    seed,
    maxProximity: realGapInfo?.maxX,
    topBucketObCount: realGapInfo?.nTop,
    bottomBucketObCount: realGapInfo?.nBottom,
    bucketSummary: bucketOrder.filter((b) => byBucket.has(b)).map((b) => ({
      bucket: b, obCount: obCountByBucket.get(b) || 0, touchCount: byBucket.get(b).n, holdRate: byBucket.get(b).held / byBucket.get(b).n,
    })),
    correlation: { real: realR, p: pR, permutedMean: permutedR.reduce((s, x) => s + x, 0) / permutedR.length, permutedRange: [permutedR[0], permutedR[permutedR.length - 1]] },
    gap: realGap == null ? null : { real: realGap, p: pGap, permutedMean: permutedGaps.reduce((s, x) => s + x, 0) / permutedGaps.length, permutedRange: [permutedGaps[0], permutedGaps[permutedGaps.length - 1]] },
  };
}

function main() {
  const result = runProximitySignificanceTest({ iterations: ITERATIONS, seed: SEED });
  console.log(`Loaded ${result.obCount} order blocks with touches, ${result.touchCount} total touches.`);
  console.log(`Max proximityCount observed: ${result.maxProximity} (top bucket n=${result.topBucketObCount} order blocks, bottom/zero bucket n=${result.bottomBucketObCount})\n`);

  console.log("=== Hold rate by proximityCount bucket (descriptive) ===");
  for (const b of result.bucketSummary) {
    console.log(`  proximity=${b.bucket.padEnd(5)}  obs=${b.obCount}  touches=${b.touchCount}  hold_rate=${(b.holdRate * 100).toFixed(1)}%`);
  }

  console.log(`\nReal point-biserial correlation: r = ${result.correlation.real.toFixed(4)}`);
  if (result.gap) console.log(`Real top(${result.maxProximity})-vs-bottom(0) gap: ${(result.gap.real * 100).toFixed(2)} points`);

  console.log(`\n--- Permutation test (${ITERATIONS} iterations, order-block-level shuffle, seed=${SEED}) ---`);
  console.log(`Correlation: permuted mean=${result.correlation.permutedMean.toFixed(4)}, range=[${result.correlation.permutedRange[0].toFixed(4)}, ${result.correlation.permutedRange[1].toFixed(4)}]`);
  console.log(`  p = ${result.correlation.p.toFixed(4)} ${result.correlation.p < 0.05 ? "(significant at 5%)" : "(NOT significant)"}`);
  if (result.gap) {
    console.log(`Gap: permuted mean=${(result.gap.permutedMean * 100).toFixed(2)}pts, range=[${(result.gap.permutedRange[0] * 100).toFixed(2)}, ${(result.gap.permutedRange[1] * 100).toFixed(2)}]`);
    console.log(`  p = ${result.gap.p.toFixed(4)} ${result.gap.p < 0.05 ? "(significant at 5%)" : "(NOT significant)"}`);
  }

  const pR = result.correlation.p, pGap = result.gap?.p;
  console.log(`\nVerdict: ${pGap != null && pR < 0.05 && pGap < 0.05 ? "Both statistics clear 5% -- real, not a labeling artifact." : (pR < 0.05 || (pGap != null && pGap < 0.05)) ? "Mixed -- unresolved." : "Neither clears 5% -- does NOT survive the test."}`);
}

if (import.meta.url === `file://${process.argv[1].replace(/\\/g, "/")}` || import.meta.url === `file:///${process.argv[1].replace(/\\/g, "/")}`) {
  main();
}
