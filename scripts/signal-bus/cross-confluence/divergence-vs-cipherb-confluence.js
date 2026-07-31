#!/usr/bin/env node
// Cross-indicator confluence test #2 (2026-07-31): does a Divergence-for-Many zone that overlaps a
// VMC Cipher B WT-divergence zone hold more reliably than one with no such overlap? Same base
// indicator (Divergence-for-Many) and same methodology as cross-confluence-significance.js's
// already-falsified SMC test -- deliberately kept apples-to-apples so the two results are directly
// comparable: "does SMC add anything to Divergence-for-Many" (tested, falsified) vs. "does Cipher B
// add anything to Divergence-for-Many" (this test).
//
// cipherBConfluence = at least one same-side Cipher B zone (regular OR hidden -- pooled, since the
// standalone kind test found no meaningful difference between them) whose confirmed_time is <= the
// divergence zone's confirmed_time (Cipher B zones never expire -- once formed, "live" forever, so
// there's no upper bound to check, unlike SMC's mitigated_time/sweep_time), within 0.2% of price --
// the same flat tolerance used throughout this project (confluence.js).
//
// Zone-level permutation, same discipline as every other significance test here: a zone's touches
// are not independent observations of it, so the confluence label is shuffled at the ZONE level.
//
// Usage: node scripts/signal-bus/cross-confluence/divergence-vs-cipherb-confluence.js --iterations=20000

import { DatabaseSync } from "node:sqlite";
import { writeFileSync, mkdirSync } from "fs";
import { execSync } from "child_process";

const DIV_DB_PATH = new URL("../../../data/signal-bus/divergence-for-many.db", import.meta.url);
const CIPHERB_DB_PATH = new URL("../../../data/signal-bus/vmc-cipher-b.db", import.meta.url);
const PRICE_TOLERANCE_PCT = 0.002; // matches confluence.js's flat tolerance, not a new invented number

const args = Object.fromEntries(process.argv.slice(2).map((a) => a.replace(/^--/, "").split("=")));
const ITERATIONS = parseInt(args.iterations || "20000", 10);
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

// Aggregate-based statistics (see vmc-cipher-b/kind-confluence-significance.js's header note --
// Cipher B's own DB proved too high-volume for a naive per-touch-array permutation; the SAME
// concern applies here since we're joining against it, so this test is aggregate-based from the
// start rather than needing a rewrite after the fact).
function pointBiserialAgg(labels, zoneStats) {
  let n = 0, sumX = 0, sumX2 = 0, sumY = 0, sumXY = 0;
  for (let i = 0; i < zoneStats.length; i++) {
    const { nTouches, nHeld } = zoneStats[i];
    const x = labels[i];
    n += nTouches; sumX += x * nTouches; sumX2 += x * x * nTouches; sumY += nHeld; sumXY += x * nHeld;
  }
  const meanX = sumX / n, meanY = sumY / n;
  const cov = sumXY - n * meanX * meanY;
  const varX = sumX2 - n * meanX * meanX;
  const varY = sumY - n * meanY * meanY;
  return varX <= 0 || varY <= 0 ? 0 : cov / Math.sqrt(varX * varY);
}
function anyVsNoneGapAgg(labels, zoneStats) {
  let heldAny = 0, nAny = 0, heldNone = 0, nNone = 0;
  for (let i = 0; i < zoneStats.length; i++) {
    const { nTouches, nHeld } = zoneStats[i];
    if (labels[i] === 1) { nAny += nTouches; heldAny += nHeld; } else { nNone += nTouches; heldNone += nHeld; }
  }
  if (nAny === 0 || nNone === 0) return null;
  return { gap: heldAny / nAny - heldNone / nNone, nAny, nNone };
}

function gitCommit() {
  try {
    return execSync("git rev-parse HEAD", { cwd: new URL("../../../", import.meta.url), encoding: "utf8" }).trim();
  } catch {
    return "unknown";
  }
}

function sideMatch(divergenceSide, cipherBSide) {
  return divergenceSide === cipherBSide; // both use "bullish"/"bearish" directly, no EQH/EQL-style remapping needed
}

export function runDivergenceVsCipherBConfluenceTest({ iterations = ITERATIONS, seed = SEED, divDbPath = DIV_DB_PATH, cipherBDbPath = CIPHERB_DB_PATH } = {}) {
  const dbDiv = new DatabaseSync(divDbPath, { readOnly: true });
  const zones = dbDiv.prepare(`SELECT id, timeframe, side, price, confirmed_time FROM zones`).all();
  const touchAgg = dbDiv.prepare(
    `SELECT zone_id, COUNT(*) as n_touches, SUM(CASE WHEN outcome='held' THEN 1 ELSE 0 END) as n_held FROM touches GROUP BY zone_id`,
  ).all();
  dbDiv.close();

  const dbCb = new DatabaseSync(cipherBDbPath, { readOnly: true });
  const cbZones = dbCb.prepare(`SELECT side, price, confirmed_time FROM zones`).all();
  dbCb.close();

  // Sort Cipher B zones by price for a binary-search-friendly tolerance scan (both sides pooled
  // together per side, since regular-vs-hidden showed no meaningful difference standalone).
  const cbBySide = { bullish: cbZones.filter((z) => z.side === "bullish").sort((a, b) => a.price - b.price), bearish: cbZones.filter((z) => z.side === "bearish").sort((a, b) => a.price - b.price) };

  function hasCipherBConfluence(zone) {
    const pool = cbBySide[zone.side];
    const tol = zone.price * PRICE_TOLERANCE_PCT;
    // Linear scan is fine here: pool sizes are in the tens of thousands, called once per
    // divergence zone (thousands), not per touch or per permutation iteration.
    for (const cb of pool) {
      if (cb.confirmed_time > zone.confirmed_time) continue; // must already exist
      if (Math.abs(cb.price - zone.price) <= tol) return true;
    }
    return false;
  }

  const touchStatsByZone = new Map(touchAgg.map((r) => [r.zone_id, { nTouches: r.n_touches, nHeld: r.n_held }]));
  const enriched = zones
    .filter((z) => touchStatsByZone.has(z.id))
    .map((z) => ({ ...z, cipherBConfluence: hasCipherBConfluence(z), stats: touchStatsByZone.get(z.id) }));

  // Descriptive: hold rate by category
  const withConf = enriched.filter((z) => z.cipherBConfluence);
  const without = enriched.filter((z) => !z.cipherBConfluence);
  const holdRateOf = (list) => {
    const nTouches = list.reduce((s, z) => s + z.stats.nTouches, 0);
    const nHeld = list.reduce((s, z) => s + z.stats.nHeld, 0);
    return { zoneCount: list.length, touchCount: nTouches, holdRate: nTouches ? nHeld / nTouches : null };
  };
  const byCategory = { "cipherB-confluent": holdRateOf(withConf), "none": holdRateOf(without) };

  const zoneStats = enriched.map((z) => z.stats);
  const realLabels = enriched.map((z) => (z.cipherBConfluence ? 1 : 0));
  const realR = pointBiserialAgg(realLabels, zoneStats);
  const realGapInfo = anyVsNoneGapAgg(realLabels, zoneStats);

  const rng = mulberry32(seed);
  const permutedR = [], permutedGaps = [];
  for (let iter = 0; iter < iterations; iter++) {
    const shuffled = shuffle(realLabels, rng);
    permutedR.push(pointBiserialAgg(shuffled, zoneStats));
    const g = anyVsNoneGapAgg(shuffled, zoneStats);
    if (g != null) permutedGaps.push(g.gap);
  }
  permutedR.sort((a, b) => a - b);
  permutedGaps.sort((a, b) => a - b);
  const pR = permutedR.filter((r) => r >= realR).length / permutedR.length;
  const pGap = realGapInfo == null ? null : permutedGaps.filter((g) => g >= realGapInfo.gap).length / permutedGaps.length;

  return {
    zoneCount: enriched.length,
    touchCount: zoneStats.reduce((s, z) => s + z.nTouches, 0),
    iterations,
    seed,
    byCategory,
    correlation: { real: realR, p: pR, permutedMean: permutedR.reduce((s, x) => s + x, 0) / permutedR.length, permutedRange: [permutedR[0], permutedR[permutedR.length - 1]] },
    gap: realGapInfo == null ? null : { real: realGapInfo.gap, nAny: realGapInfo.nAny, nNone: realGapInfo.nNone, p: pGap, permutedMean: permutedGaps.reduce((s, x) => s + x, 0) / permutedGaps.length, permutedRange: [permutedGaps[0], permutedGaps[permutedGaps.length - 1]] },
  };
}

function main() {
  const result = runDivergenceVsCipherBConfluenceTest({ iterations: ITERATIONS, seed: SEED });
  console.log(`Loaded ${result.zoneCount} Divergence-for-Many zones with touches (${result.touchCount} touches), cross-referenced against VMC Cipher B WT-divergence zones.\n`);

  console.log("=== Hold rate by Cipher B confluence (descriptive) ===");
  for (const [name, c] of Object.entries(result.byCategory)) {
    console.log(`  ${name.padEnd(20)} zones=${c.zoneCount}  touches=${c.touchCount}  hold_rate=${c.holdRate != null ? (c.holdRate * 100).toFixed(1) + "%" : "n/a"}`);
  }

  console.log(`\nReal point-biserial correlation (has Cipher B confluence vs held/broken): r = ${result.correlation.real.toFixed(4)}`);
  if (result.gap) console.log(`Real gap (confluent hold% - none hold%): ${(result.gap.real * 100).toFixed(2)} points`);

  console.log(`\n--- Permutation test (${ITERATIONS} iterations, zone-level shuffle, seed=${SEED}) ---`);
  console.log(`Correlation: permuted mean=${result.correlation.permutedMean.toFixed(4)}, range=[${result.correlation.permutedRange[0].toFixed(4)}, ${result.correlation.permutedRange[1].toFixed(4)}]`);
  console.log(`  p=${result.correlation.p.toFixed(4)} ${result.correlation.p < 0.05 ? "(significant at 5%)" : "(NOT significant at 5%)"}`);
  if (result.gap) {
    console.log(`Gap: permuted mean=${(result.gap.permutedMean * 100).toFixed(2)} pts, range=[${(result.gap.permutedRange[0] * 100).toFixed(2)}, ${(result.gap.permutedRange[1] * 100).toFixed(2)}]`);
    console.log(`  p=${result.gap.p.toFixed(4)} ${result.gap.p < 0.05 ? "(significant at 5%)" : "(NOT significant at 5%)"}`);
  }

  const pR = result.correlation.p, pGap = result.gap?.p;
  console.log(`\nVerdict: ${pGap != null && pR < 0.05 && pGap < 0.05 ? "Both statistics clear 5% -- Cipher B confluence looks real, not a labeling artifact." : (pR < 0.05 || (pGap != null && pGap < 0.05)) ? "Mixed -- one statistic clears 5%, the other doesn't. Treat as unresolved, not confirmed." : "Neither statistic clears 5% -- not distinguishable from randomly relabeling zones. Does NOT survive the test."}`);

  const RESULTS_DIR = new URL("results/", import.meta.url);
  mkdirSync(RESULTS_DIR, { recursive: true });
  const out = { ...result, git_commit: gitCommit(), generated_at: new Date().toISOString() };
  const fname = `divergence_vs_cipherb_confluence_${out.generated_at.replace(/[:.]/g, "-")}.json`;
  writeFileSync(new URL(fname, RESULTS_DIR), JSON.stringify(out, null, 2));
  console.log(`\nSaved: ${new URL(fname, RESULTS_DIR).pathname.replace(/^\/([A-Z]:)/, "$1")}`);
}

if (import.meta.url === `file://${process.argv[1].replace(/\\/g, "/")}` || import.meta.url === `file:///${process.argv[1].replace(/\\/g, "/")}`) {
  main();
}
