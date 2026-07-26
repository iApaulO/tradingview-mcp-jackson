#!/usr/bin/env node
// Permutation significance test for the confluence-vs-hold-rate finding (2026-07-25): does hold
// rate genuinely rise with confluence count, or could a gap this size show up by chance given how
// confluence_count is distributed across zones?
//
// Unit of permutation is the ZONE, not the touch. confluence_count is a lifetime property of a
// zone (computed once by confluence.js), and a zone's touches are NOT independent observations of
// it -- shuffling labels at the touch level would break that clustering and produce an
// artificially narrow null distribution (pseudo-replication), overstating significance. Instead:
// shuffle which zones get which confluence_count label (preserving the real multiset of labels and
// each zone's own real touch outcomes), recompute the statistic, repeat -- the same "reshuffle
// the thing being tested, keep everything else real" logic as the backtest program's Monte Carlo
// baseline (scripts/backtest/lib/monte-carlo.js), applied to the right level here.
//
// Two statistics, both one-sided (the hypothesis is directional: higher confluence -> higher hold
// rate), computed over the SAME permutations so both p-values come from one coherent null:
//   1. Point-biserial correlation between confluence_count and outcome (1=held/0=broken) across
//      every touch -- uses the full gradient, standard, robust to how buckets are drawn.
//   2. The specific bucket-3-vs-bucket-1 hold-rate gap -- mirrors the exact comparison actually
//      discussed (53.4% isolated vs 60.6% at 3-way), since bucket 4+ was already flagged as thin
//      (n=171) and noisy (hold rate dropped there), not part of the core claim being tested.
//
// Usage: node scripts/signal-bus/divergence-for-many/confluence-significance.js --iterations=5000

import { DatabaseSync } from "node:sqlite";

const DB_PATH = new URL("../../../data/signal-bus/divergence-for-many.db", import.meta.url);

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

// Point-biserial correlation: confluenceCounts (continuous) vs outcomes (0/1 binary), one value
// per touch (a zone's confluence_count repeated once per touch it has).
function pointBiserial(confluenceCounts, outcomes) {
  const n = confluenceCounts.length;
  const meanX = confluenceCounts.reduce((s, x) => s + x, 0) / n;
  const meanY = outcomes.reduce((s, y) => s + y, 0) / n;
  let cov = 0, varX = 0, varY = 0;
  for (let i = 0; i < n; i++) {
    const dx = confluenceCounts[i] - meanX;
    const dy = outcomes[i] - meanY;
    cov += dx * dy;
    varX += dx * dx;
    varY += dy * dy;
  }
  return varX === 0 || varY === 0 ? 0 : cov / Math.sqrt(varX * varY);
}

function bucketOf(count) {
  return count >= 4 ? "4+" : String(count);
}

function bucket3vs1Gap(confluenceCounts, outcomes) {
  let held1 = 0, n1 = 0, held3 = 0, n3 = 0;
  for (let i = 0; i < confluenceCounts.length; i++) {
    const b = bucketOf(confluenceCounts[i]);
    if (b === "1") { n1++; held1 += outcomes[i]; }
    else if (b === "3") { n3++; held3 += outcomes[i]; }
  }
  if (n1 === 0 || n3 === 0) return null;
  return held3 / n3 - held1 / n1;
}

// Exported so other scripts (e.g. build-analytics-page.js) can get fresh significance numbers
// straight from the DB instead of hardcoding a snapshot of a prior run's output.
export function runConfluenceSignificanceTest({ iterations = 5000, seed = 42, dbPath = DB_PATH } = {}) {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  const rows = db.prepare(
    `SELECT z.id as zone_id, z.confluence_count, t.outcome
     FROM touches t JOIN zones z ON z.id = t.zone_id`,
  ).all();
  db.close();

  const zoneMap = new Map();
  for (const r of rows) {
    if (!zoneMap.has(r.zone_id)) zoneMap.set(r.zone_id, { confluenceCount: r.confluence_count, outcomes: [] });
    zoneMap.get(r.zone_id).outcomes.push(r.outcome === "held" ? 1 : 0);
  }
  const zones = [...zoneMap.values()];

  const realLabels = zones.map((z) => z.confluenceCount);
  const realConfluencePerTouch = [];
  const realOutcomePerTouch = [];
  for (const z of zones) {
    for (const o of z.outcomes) {
      realConfluencePerTouch.push(z.confluenceCount);
      realOutcomePerTouch.push(o);
    }
  }

  const realR = pointBiserial(realConfluencePerTouch, realOutcomePerTouch);
  const realGap = bucket3vs1Gap(realConfluencePerTouch, realOutcomePerTouch);

  const rng = mulberry32(seed);
  const permutedR = [];
  const permutedGaps = [];
  for (let iter = 0; iter < iterations; iter++) {
    const shuffledLabels = shuffle(realLabels, rng);
    const confPerTouch = [];
    const outPerTouch = [];
    for (let i = 0; i < zones.length; i++) {
      const label = shuffledLabels[i];
      for (const o of zones[i].outcomes) {
        confPerTouch.push(label);
        outPerTouch.push(o);
      }
    }
    permutedR.push(pointBiserial(confPerTouch, outPerTouch));
    const gap = bucket3vs1Gap(confPerTouch, outPerTouch);
    if (gap != null) permutedGaps.push(gap);
  }
  permutedR.sort((a, b) => a - b);
  permutedGaps.sort((a, b) => a - b);

  const pR = permutedR.filter((r) => r >= realR).length / permutedR.length;
  const pGap = permutedGaps.filter((g) => g >= realGap).length / permutedGaps.length;

  return {
    zoneCount: zones.length,
    touchCount: rows.length,
    iterations,
    seed,
    correlation: {
      real: realR,
      p: pR,
      permutedMean: permutedR.reduce((s, x) => s + x, 0) / permutedR.length,
      permutedRange: [permutedR[0], permutedR[permutedR.length - 1]],
    },
    gap: {
      real: realGap,
      p: pGap,
      permutedMean: permutedGaps.reduce((s, x) => s + x, 0) / permutedGaps.length,
      permutedRange: [permutedGaps[0], permutedGaps[permutedGaps.length - 1]],
    },
  };
}

function main() {
  const result = runConfluenceSignificanceTest({ iterations: ITERATIONS, seed: SEED });
  console.log(`Loaded ${result.zoneCount} zones with touches, ${result.touchCount} total touches.`);
  console.log(`\nReal point-biserial correlation (confluence_count vs held/broken): r = ${result.correlation.real.toFixed(4)}`);
  console.log(`Real bucket gap (3-way hold% - isolated hold%): ${(result.gap.real * 100).toFixed(2)} points`);

  console.log(`\n--- Permutation test (${ITERATIONS} iterations, zone-level shuffle, seed=${SEED}) ---`);
  console.log(`Correlation: permuted r mean=${result.correlation.permutedMean.toFixed(4)}, range=[${result.correlation.permutedRange[0].toFixed(4)}, ${result.correlation.permutedRange[1].toFixed(4)}]`);
  console.log(`  p-value (fraction of permuted r >= real r): ${result.correlation.p.toFixed(4)} ${result.correlation.p < 0.05 ? "(significant at 5%)" : "(NOT significant at 5%)"}`);
  console.log(`Bucket gap: permuted mean=${(result.gap.permutedMean * 100).toFixed(2)} pts, range=[${(result.gap.permutedRange[0] * 100).toFixed(2)}, ${(result.gap.permutedRange[1] * 100).toFixed(2)}]`);
  console.log(`  p-value (fraction of permuted gap >= real gap): ${result.gap.p.toFixed(4)} ${result.gap.p < 0.05 ? "(significant at 5%)" : "(NOT significant at 5%)"}`);

  const pR = result.correlation.p, pGap = result.gap.p;
  console.log(
    `\nVerdict: ${pR < 0.05 && pGap < 0.05 ? "Both statistics clear 5% -- the confluence effect looks real, not a labeling artifact." : pR < 0.05 || pGap < 0.05 ? "Mixed -- one statistic clears 5%, the other doesn't. Treat as unresolved, not confirmed." : "Neither statistic clears 5% -- the observed gradient is NOT distinguishable from randomly relabeling zones. This does not survive the test."}`,
  );
}

// Only run as CLI when invoked directly -- build-analytics-page.js imports runConfluenceSignificanceTest instead.
if (import.meta.url === `file://${process.argv[1].replace(/\\/g, "/")}` || import.meta.url === `file:///${process.argv[1].replace(/\\/g, "/")}`) {
  main();
}
