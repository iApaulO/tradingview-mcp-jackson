#!/usr/bin/env node
// Permutation significance test for recurrenceCount (same-timeframe order-block recurrence) vs.
// hold rate -- exact same method as confluence-significance.js (order-block-level shuffle, not
// touch-level, to avoid pseudo-replicating a block's own touches as independent observations),
// applied to the NEW recurrenceCount field instead of confluenceCount. Built 2026-07-28 after a
// live discretionary chart read ("nested/stacked zones seem more truthful") surfaced that
// confluenceCount is structurally blind to same-timeframe recurrence (it counts distinct
// TIMEFRAMES, timeframesSeen.size in confluence.js) -- this asks the question confluenceCount
// cannot answer: does demand/supply re-forming repeatedly on ONE timeframe predict a higher hold
// rate, independent of any cross-timeframe agreement?
//
// Usage: node scripts/signal-bus/smc/recurrence-significance.js --iterations=50000

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

function topVsBottomGap(xs, ys) {
  let heldTop = 0, nTop = 0, heldBottom = 0, nBottom = 0;
  let maxX = -Infinity; for (const x of xs) if (x > maxX) maxX = x; // avoid Math.max(...xs) call-stack limit on large trade arrays
  for (let i = 0; i < xs.length; i++) {
    if (xs[i] === 1) { nBottom++; heldBottom += ys[i]; }
    else if (xs[i] === maxX) { nTop++; heldTop += ys[i]; }
  }
  if (nTop === 0 || nBottom === 0) return null;
  return { gap: heldTop / nTop - heldBottom / nBottom, nTop, nBottom, maxX };
}

export function runRecurrenceSignificanceTest({ iterations = 5000, seed = 42, dbPath = DB_PATH } = {}) {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  const rows = db.prepare(
    `SELECT ob.id as ob_id, ob.recurrence_count, obt.outcome
     FROM order_block_touches obt JOIN order_blocks ob ON ob.id = obt.order_block_id`,
  ).all();
  db.close();

  const obMap = new Map();
  for (const r of rows) {
    if (!obMap.has(r.ob_id)) obMap.set(r.ob_id, { recurrenceCount: r.recurrence_count, outcomes: [] });
    obMap.get(r.ob_id).outcomes.push(r.outcome === "held" ? 1 : 0);
  }
  const obs = [...obMap.values()];

  const realLabels = obs.map((o) => o.recurrenceCount);
  const realX = [], realY = [];
  for (const o of obs) for (const y of o.outcomes) { realX.push(o.recurrenceCount); realY.push(y); }

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

  // Descriptive: hold rate by exact recurrenceCount bucket (per-touch), for the write-up table.
  const byBucket = new Map();
  for (let i = 0; i < realX.length; i++) {
    const b = realX[i];
    if (!byBucket.has(b)) byBucket.set(b, { n: 0, held: 0 });
    byBucket.get(b).n++;
    byBucket.get(b).held += realY[i];
  }
  const obCountByBucket = new Map();
  for (const o of obs) obCountByBucket.set(o.recurrenceCount, (obCountByBucket.get(o.recurrenceCount) || 0) + 1);

  return {
    obCount: obs.length,
    touchCount: rows.length,
    iterations,
    seed,
    maxRecurrence: realGapInfo?.maxX,
    topBucketObCount: realGapInfo?.nTop,
    bottomBucketObCount: realGapInfo?.nBottom,
    bucketSummary: [...byBucket.entries()].sort((a, b) => a[0] - b[0]).map(([recurrenceCount, v]) => ({
      recurrenceCount, obCount: obCountByBucket.get(recurrenceCount) || 0, touchCount: v.n, holdRate: v.held / v.n,
    })),
    correlation: { real: realR, p: pR, permutedMean: permutedR.reduce((s, x) => s + x, 0) / permutedR.length, permutedRange: [permutedR[0], permutedR[permutedR.length - 1]] },
    gap: realGap == null ? null : { real: realGap, p: pGap, permutedMean: permutedGaps.reduce((s, x) => s + x, 0) / permutedGaps.length, permutedRange: [permutedGaps[0], permutedGaps[permutedGaps.length - 1]] },
  };
}

function main() {
  const result = runRecurrenceSignificanceTest({ iterations: ITERATIONS, seed: SEED });
  console.log(`Loaded ${result.obCount} order blocks with touches, ${result.touchCount} total touches.`);
  console.log(`Max recurrenceCount observed: ${result.maxRecurrence} (top bucket n=${result.topBucketObCount} order blocks, bottom/isolated bucket n=${result.bottomBucketObCount})\n`);

  console.log("=== Hold rate by recurrenceCount (descriptive) ===");
  for (const b of result.bucketSummary) {
    console.log(`  recurrence=${b.recurrenceCount}  obs=${b.obCount}  touches=${b.touchCount}  hold_rate=${(b.holdRate * 100).toFixed(1)}%`);
  }

  console.log(`\nReal point-biserial correlation: r = ${result.correlation.real.toFixed(4)}`);
  if (result.gap) console.log(`Real top(${result.maxRecurrence})-vs-bottom(1) gap: ${(result.gap.real * 100).toFixed(2)} points`);

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
