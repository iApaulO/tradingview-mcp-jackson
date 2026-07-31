#!/usr/bin/env node
// First significance pass for VMC Cipher B's WT divergence zones. Two questions, same permutation
// discipline as the existing SMC recurrenceCount / Divergence-for-Many confluenceCount tests
// (zone-level shuffle, not touch-level -- a zone's touches are not independent observations of it):
//
//   1. kind effect: the live chart has wtShowHiddenDiv=true (a real deviation from the Pine
//      author's own documented default of false, confirmed 2026-07-31) -- does "hidden" divergence
//      actually predict anything different from "regular," or is enabling it just adding noise to
//      the chart? Statistic: hold-rate gap (hidden - regular).
//   2. confluence effect: same test already run for Divergence-for-Many (does cross-timeframe
//      agreement at a price level predict a higher hold rate), applied here to Cipher B's zones.
//      Statistic: point-biserial correlation (confluence_count vs held/broken) + isolated(1)-vs-3way
//      bucket gap, mirroring divergence-for-many/confluence-significance.js exactly.
//
// PERFORMANCE NOTE (2026-07-31): unlike Divergence-for-Many's zones, Cipher B's never expire (no
// analogous mechanism in the source), so touches accumulate across ALL of remaining history after
// each zone forms -- 4M+ touches total here vs. the tens of thousands the original per-touch-array
// permutation pattern was built against. Expanding to a full per-touch array every iteration (the
// original pattern) was measured to take minutes per test at this scale -- killed and rewritten
// below to work from precomputed per-zone aggregates (nTouches, nHeld) instead, since every
// statistic used here (point-biserial correlation, bucket hold-rate gaps) is a weighted sum over
// touches and can be computed exactly from those aggregates without ever materializing a per-touch
// array. Same real statistic, same real permutation, ~160x fewer operations per iteration (zones,
// not touches) -- not an approximation.
//
// Usage: node scripts/signal-bus/vmc-cipher-b/kind-confluence-significance.js --iterations=5000

import { DatabaseSync } from "node:sqlite";

const DB_PATH = new URL("../../../data/signal-bus/vmc-cipher-b.db", import.meta.url);

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

// ── Aggregate-based statistics ──────────────────────────────────────────────
// Every zone contributes (nTouches, nHeld) once; a `labels` array (one entry per zone, whatever is
// being permuted -- kind string or confluenceCount number) drives the grouping. All three
// statistics below are exact, not approximations: touches within a zone are homogeneous in their
// label (it's a zone-level property), so per-zone sums are all that's needed.

// Point-biserial correlation between a numeric per-zone label (repeated nTouches times) and the
// held/broken outcome, computed from aggregates: sum(x)=sum(label*nTouches), sum(x^2)=sum(label^2*
// nTouches), sum(y)=sum(nHeld) [y is 0/1 so sum(y^2)=sum(y)], sum(xy)=sum(label*nHeld), n=sum(nTouches).
function pointBiserialAgg(labels, zoneStats) {
  let n = 0, sumX = 0, sumX2 = 0, sumY = 0, sumXY = 0;
  for (let i = 0; i < zoneStats.length; i++) {
    const { nTouches, nHeld } = zoneStats[i];
    const x = labels[i];
    n += nTouches;
    sumX += x * nTouches;
    sumX2 += x * x * nTouches;
    sumY += nHeld;
    sumXY += x * nHeld;
  }
  const meanX = sumX / n, meanY = sumY / n;
  const cov = sumXY - n * meanX * meanY;
  const varX = sumX2 - n * meanX * meanX;
  const varY = sumY - n * meanY * meanY; // sum(y^2)=sum(y) since y in {0,1}
  return varX <= 0 || varY <= 0 ? 0 : cov / Math.sqrt(varX * varY);
}

function bucketOf(count) {
  return count >= 4 ? "4+" : String(count);
}

// Hold-rate gap between two numeric-label buckets ("3" vs "1"), from aggregates.
function bucket3vs1GapAgg(labels, zoneStats) {
  let held1 = 0, n1 = 0, held3 = 0, n3 = 0;
  for (let i = 0; i < zoneStats.length; i++) {
    const b = bucketOf(labels[i]);
    const { nTouches, nHeld } = zoneStats[i];
    if (b === "1") { n1 += nTouches; held1 += nHeld; }
    else if (b === "3") { n3 += nTouches; held3 += nHeld; }
  }
  if (n1 === 0 || n3 === 0) return null;
  return { gap: held3 / n3 - held1 / n1, n1, n3 };
}

// Hold-rate gap between two string-label groups ("regular" vs "hidden"), from aggregates.
function kindGapAgg(labels, zoneStats) {
  let heldReg = 0, nReg = 0, heldHid = 0, nHid = 0;
  for (let i = 0; i < zoneStats.length; i++) {
    const { nTouches, nHeld } = zoneStats[i];
    if (labels[i] === "regular") { nReg += nTouches; heldReg += nHeld; }
    else { nHid += nTouches; heldHid += nHeld; }
  }
  if (nReg === 0 || nHid === 0) return null;
  return { gap: heldHid / nHid - heldReg / nReg, nReg, nHid };
}

export function runKindConfluenceSignificanceTest({ iterations = 5000, seed = 42, dbPath = DB_PATH } = {}) {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  // Aggregate directly in SQL -- avoids ever loading 4M+ individual touch rows into JS.
  const rows = db.prepare(
    `SELECT z.id as zone_id, z.kind, z.confluence_count,
            COUNT(*) as n_touches,
            SUM(CASE WHEN t.outcome = 'held' THEN 1 ELSE 0 END) as n_held
     FROM touches t JOIN zones z ON z.id = t.zone_id
     GROUP BY z.id`,
  ).all();
  db.close();

  const zoneStats = rows.map((r) => ({ nTouches: r.n_touches, nHeld: r.n_held }));
  const totalTouches = zoneStats.reduce((s, z) => s + z.nTouches, 0);

  // ── Kind test ────────────────────────────────────────────────────────────
  const realKindLabels = rows.map((r) => r.kind);
  const realKindGapInfo = kindGapAgg(realKindLabels, zoneStats);

  const rng1 = mulberry32(seed);
  const permutedKindGaps = [];
  for (let iter = 0; iter < iterations; iter++) {
    const shuffled = shuffle(realKindLabels, rng1);
    const g = kindGapAgg(shuffled, zoneStats);
    if (g != null) permutedKindGaps.push(g.gap);
  }
  permutedKindGaps.sort((a, b) => a - b);
  const pKind = permutedKindGaps.filter((g) => Math.abs(g) >= Math.abs(realKindGapInfo.gap)).length / permutedKindGaps.length; // two-sided: no prior direction assumed

  // ── Confluence test (mirrors divergence-for-many/confluence-significance.js) ───────────────
  const realConfLabels = rows.map((r) => r.confluence_count);
  const realR = pointBiserialAgg(realConfLabels, zoneStats);
  const realGapInfo = bucket3vs1GapAgg(realConfLabels, zoneStats);

  const rng2 = mulberry32(seed + 1);
  const permutedR = [], permutedGaps = [];
  for (let iter = 0; iter < iterations; iter++) {
    const shuffled = shuffle(realConfLabels, rng2);
    permutedR.push(pointBiserialAgg(shuffled, zoneStats));
    const g = bucket3vs1GapAgg(shuffled, zoneStats);
    if (g != null) permutedGaps.push(g.gap);
  }
  permutedR.sort((a, b) => a - b);
  permutedGaps.sort((a, b) => a - b);
  const pR = permutedR.filter((r) => r >= realR).length / permutedR.length;
  const pGap = realGapInfo == null ? null : permutedGaps.filter((g) => g >= realGapInfo.gap).length / permutedGaps.length;

  return {
    zoneCount: zoneStats.length,
    touchCount: totalTouches,
    iterations,
    seed,
    kind: {
      real: realKindGapInfo,
      p: pKind,
      permutedMean: permutedKindGaps.reduce((s, x) => s + x, 0) / permutedKindGaps.length,
      permutedRange: [permutedKindGaps[0], permutedKindGaps[permutedKindGaps.length - 1]],
    },
    confluence: {
      correlation: { real: realR, p: pR, permutedMean: permutedR.reduce((s, x) => s + x, 0) / permutedR.length, permutedRange: [permutedR[0], permutedR[permutedR.length - 1]] },
      gap: realGapInfo == null ? null : { real: realGapInfo.gap, n1: realGapInfo.n1, n3: realGapInfo.n3, p: pGap, permutedMean: permutedGaps.reduce((s, x) => s + x, 0) / permutedGaps.length, permutedRange: [permutedGaps[0], permutedGaps[permutedGaps.length - 1]] },
    },
  };
}

function main() {
  const result = runKindConfluenceSignificanceTest({ iterations: ITERATIONS, seed: SEED });
  console.log(`Loaded ${result.zoneCount} zones, ${result.touchCount} total touches.\n`);

  console.log("=== Test 1: regular vs hidden divergence (hold-rate gap) ===");
  console.log(`  regular: ${result.kind.real.nReg} touches`);
  console.log(`  hidden:  ${result.kind.real.nHid} touches`);
  console.log(`  real gap (hidden - regular): ${(result.kind.real.gap * 100).toFixed(2)} points`);
  console.log(`  permutation test (${ITERATIONS} iterations, zone-level shuffle, two-sided): p = ${result.kind.p.toFixed(4)} ${result.kind.p < 0.05 ? "(significant at 5%)" : "(NOT significant)"}`);

  console.log("\n=== Test 2: cross-timeframe confluence vs hold-rate ===");
  console.log(`  point-biserial r = ${result.confluence.correlation.real.toFixed(4)}, p = ${result.confluence.correlation.p.toFixed(4)} ${result.confluence.correlation.p < 0.05 ? "(significant at 5%)" : "(NOT significant)"}`);
  if (result.confluence.gap) {
    console.log(`  3-way(n=${result.confluence.gap.n3} touches) vs isolated(n=${result.confluence.gap.n1} touches) gap: ${(result.confluence.gap.real * 100).toFixed(2)} points, p = ${result.confluence.gap.p.toFixed(4)} ${result.confluence.gap.p < 0.05 ? "(significant at 5%)" : "(NOT significant)"}`);
  }

  console.log(`\nVerdict (kind): ${result.kind.p < 0.05 ? "Regular vs hidden divergence hold rates differ more than chance -- real, worth distinguishing." : "No detectable difference between regular and hidden divergence hold rates -- the live wtShowHiddenDiv=true setting is not adding distinguishable signal by this test."}`);
  const pR = result.confluence.correlation.p, pGap = result.confluence.gap?.p;
  console.log(`Verdict (confluence): ${pGap != null && pR < 0.05 && pGap < 0.05 ? "Both statistics clear 5% -- cross-timeframe agreement predicts hold rate here too." : (pR < 0.05 || (pGap != null && pGap < 0.05)) ? "Mixed -- unresolved." : "Neither clears 5% -- does NOT survive the test."}`);
}

if (import.meta.url === `file://${process.argv[1].replace(/\\/g, "/")}` || import.meta.url === `file:///${process.argv[1].replace(/\\/g, "/")}`) {
  main();
}
