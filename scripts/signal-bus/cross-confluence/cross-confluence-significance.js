#!/usr/bin/env node
// Cross-INDICATOR confluence test (2026-07-27): every confluence test built so far (SMC's own
// order-block confluence, Divergence-for-Many's own zone confluence) has been WITHIN one
// indicator, across timeframes. This asks a different question: does a Divergence-for-Many zone
// that overlaps SMC structure -- sitting inside a still-active order block, or resting near a
// still-unswept EQH/EQL liquidity level -- hold more reliably than one with no such overlap?
//
// Definitions (side-matched: divergence "bullish" zone = support = order-block "bullish" = EQL;
// divergence "bearish" zone = resistance = order-block "bearish" = EQH):
//   obConfluence  = at least one SMC order block, same side, ACTIVE at the divergence zone's
//                   confirmed_time (created_time <= confirmed_time, not yet mitigated or
//                   mitigated after confirmed_time), whose [bar_low, bar_high] range CONTAINS the
//                   zone's price. Order blocks have real width -- containment, not a tolerance.
//   liqConfluence = at least one SMC EQH/EQL level, same side, confirmed by confirmed_time, still
//                   UNSWEPT at confirmed_time (sweep_time is null or after confirmed_time), within
//                   0.2% of the zone's price -- the same flat tolerance used for every other
//                   proximity test in this project (confluence.js), not a new number.
// Both checks look across ALL SMC timeframes, not just the zone's own timeframe -- structure from
// any resolution can be "in the room" the same way the same-indicator confluence tests treat
// cross-timeframe overlap as real confluence, not noise.
//
// Zone-level permutation, same discipline as confluence-significance.js: a zone's touches are not
// independent observations of it, so the label being tested (here: cross-confluence category,
// not confluence_count) is shuffled at the ZONE level, each zone keeps its own real touch outcomes.
//
// Usage: node scripts/signal-bus/cross-confluence/cross-confluence-significance.js --iterations=20000

import { DatabaseSync } from "node:sqlite";
import { writeFileSync, mkdirSync } from "fs";
import { execSync } from "child_process";

const DIV_DB_PATH = new URL("../../../data/signal-bus/divergence-for-many.db", import.meta.url);
const SMC_DB_PATH = new URL("../../../data/signal-bus/smc.db", import.meta.url);
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

function loadDivergenceZonesAndTouches() {
  const db = new DatabaseSync(DIV_DB_PATH, { readOnly: true });
  const zones = db.prepare(`SELECT id, timeframe, side, price, confirmed_time FROM zones`).all();
  const touches = db.prepare(`SELECT zone_id, outcome FROM touches`).all();
  db.close();
  const touchesByZone = new Map();
  for (const t of touches) {
    if (!touchesByZone.has(t.zone_id)) touchesByZone.set(t.zone_id, []);
    touchesByZone.get(t.zone_id).push(t.outcome === "held" ? 1 : 0);
  }
  return { zones, touchesByZone };
}

function loadSMCStructure() {
  const db = new DatabaseSync(SMC_DB_PATH, { readOnly: true });
  const orderBlocks = db.prepare(`SELECT side, bar_high, bar_low, created_time, mitigated_time FROM order_blocks`).all();
  const eqhEql = db.prepare(`SELECT side, level, confirm_time, sweep_time FROM eqh_eql_events`).all();
  db.close();
  return { orderBlocks, eqhEql };
}

function sideMatch(divergenceSide, obOrEqSide) {
  // divergence "bullish" (support) <-> OB "bullish" <-> EQL ; divergence "bearish" (resistance) <-> OB "bearish" <-> EQH
  if (divergenceSide === "bullish") return obOrEqSide === "bullish" || obOrEqSide === "EQL";
  return obOrEqSide === "bearish" || obOrEqSide === "EQH";
}

function classifyZone(zone, orderBlocks, eqhEql) {
  const t = zone.confirmed_time;
  let obConfluence = false;
  for (const ob of orderBlocks) {
    if (!sideMatch(zone.side, ob.side)) continue;
    if (ob.created_time > t) continue;
    if (ob.mitigated_time != null && ob.mitigated_time <= t) continue;
    if (zone.price >= ob.bar_low && zone.price <= ob.bar_high) { obConfluence = true; break; }
  }
  let liqConfluence = false;
  for (const eq of eqhEql) {
    if (!sideMatch(zone.side, eq.side)) continue;
    if (eq.confirm_time > t) continue;
    if (eq.sweep_time != null && eq.sweep_time <= t) continue;
    if (Math.abs(eq.level - zone.price) / zone.price <= PRICE_TOLERANCE_PCT) { liqConfluence = true; break; }
  }
  return { obConfluence, liqConfluence };
}

function categoryOf({ obConfluence, liqConfluence }) {
  if (obConfluence && liqConfluence) return "both";
  if (obConfluence) return "OB-only";
  if (liqConfluence) return "liquidity-only";
  return "none";
}

export function runCrossConfluenceSignificanceTest({ iterations = ITERATIONS, seed = SEED, divDbPath = DIV_DB_PATH, smcDbPath = SMC_DB_PATH } = {}) {
  const dbDiv = new DatabaseSync(divDbPath, { readOnly: true });
  const zones = dbDiv.prepare(`SELECT id, timeframe, side, price, confirmed_time FROM zones`).all();
  const touches = dbDiv.prepare(`SELECT zone_id, outcome FROM touches`).all();
  dbDiv.close();
  const dbSmc = new DatabaseSync(smcDbPath, { readOnly: true });
  const orderBlocks = dbSmc.prepare(`SELECT side, bar_high, bar_low, created_time, mitigated_time FROM order_blocks`).all();
  const eqhEql = dbSmc.prepare(`SELECT side, level, confirm_time, sweep_time FROM eqh_eql_events`).all();
  dbSmc.close();

  const touchesByZone = new Map();
  for (const t of touches) {
    if (!touchesByZone.has(t.zone_id)) touchesByZone.set(t.zone_id, []);
    touchesByZone.get(t.zone_id).push(t.outcome === "held" ? 1 : 0);
  }

  const enriched = zones
    .filter((z) => touchesByZone.has(z.id))
    .map((z) => {
      const cls = classifyZone(z, orderBlocks, eqhEql);
      return { ...z, ...cls, category: categoryOf(cls), outcomes: touchesByZone.get(z.id) };
    });

  // Descriptive: hold rate per category (per-touch)
  const byCategory = {};
  for (const name of ["none", "OB-only", "liquidity-only", "both"]) {
    const zs = enriched.filter((z) => z.category === name);
    const outs = zs.flatMap((z) => z.outcomes);
    byCategory[name] = { zoneCount: zs.length, touchCount: outs.length, holdRate: outs.length ? outs.reduce((s, o) => s + o, 0) / outs.length : null };
  }

  // Significance: binary "hasAnyCrossConfluence" (0/1) vs outcome, zone-level shuffle
  const realLabels = enriched.map((z) => (z.category === "none" ? 0 : 1));
  const realConfPerTouch = [];
  const realOutPerTouch = [];
  for (const z of enriched) for (const o of z.outcomes) { realConfPerTouch.push(z.category === "none" ? 0 : 1); realOutPerTouch.push(o); }
  const realR = pointBiserial(realConfPerTouch, realOutPerTouch);

  function anyVsNoneGap(labels) {
    let heldAny = 0, nAny = 0, heldNone = 0, nNone = 0;
    for (let i = 0; i < enriched.length; i++) {
      const label = labels[i];
      for (const o of enriched[i].outcomes) {
        if (label === 1) { nAny++; heldAny += o; } else { nNone++; heldNone += o; }
      }
    }
    if (nAny === 0 || nNone === 0) return null;
    return heldAny / nAny - heldNone / nNone;
  }
  const realGap = anyVsNoneGap(realLabels);

  const rng = mulberry32(seed);
  const permutedR = [], permutedGaps = [];
  for (let iter = 0; iter < iterations; iter++) {
    const shuffled = shuffle(realLabels, rng);
    const confPerTouch = [], outPerTouch = [];
    for (let i = 0; i < enriched.length; i++) for (const o of enriched[i].outcomes) { confPerTouch.push(shuffled[i]); outPerTouch.push(o); }
    permutedR.push(pointBiserial(confPerTouch, outPerTouch));
    const gap = anyVsNoneGap(shuffled);
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
  const result = runCrossConfluenceSignificanceTest({ iterations: ITERATIONS, seed: SEED });
  console.log(`Loaded ${result.zoneCount} divergence zones with touches (${result.touchCount} touches), cross-referenced against SMC order blocks + EQH/EQL levels.\n`);

  console.log("=== Hold rate by cross-indicator confluence category (descriptive) ===");
  for (const [name, c] of Object.entries(result.byCategory)) {
    console.log(`  ${name.padEnd(16)} zones=${c.zoneCount}  touches=${c.touchCount}  hold_rate=${c.holdRate != null ? (c.holdRate * 100).toFixed(1) + "%" : "n/a"}`);
  }

  console.log(`\nReal point-biserial correlation (has any cross-confluence vs held/broken): r = ${result.correlation.real.toFixed(4)}`);
  console.log(`Real gap (any cross-confluence hold% - none hold%): ${(result.gap.real * 100).toFixed(2)} points`);

  console.log(`\n--- Permutation test (${ITERATIONS} iterations, zone-level shuffle, seed=${SEED}) ---`);
  console.log(`Correlation: permuted mean=${result.correlation.permutedMean.toFixed(4)}, range=[${result.correlation.permutedRange[0].toFixed(4)}, ${result.correlation.permutedRange[1].toFixed(4)}]`);
  console.log(`  p=${result.correlation.p.toFixed(4)} ${result.correlation.p < 0.05 ? "(significant at 5%)" : "(NOT significant at 5%)"}`);
  console.log(`Gap: permuted mean=${(result.gap.permutedMean * 100).toFixed(2)} pts, range=[${(result.gap.permutedRange[0] * 100).toFixed(2)}, ${(result.gap.permutedRange[1] * 100).toFixed(2)}]`);
  console.log(`  p=${result.gap.p.toFixed(4)} ${result.gap.p < 0.05 ? "(significant at 5%)" : "(NOT significant at 5%)"}`);

  const pR = result.correlation.p, pGap = result.gap.p;
  console.log(`\nVerdict: ${pR < 0.05 && pGap < 0.05 ? "Both statistics clear 5% -- cross-indicator confluence looks real, not a labeling artifact." : pR < 0.05 || pGap < 0.05 ? "Mixed -- one statistic clears 5%, the other doesn't. Treat as unresolved, not confirmed." : "Neither statistic clears 5% -- not distinguishable from randomly relabeling zones. Does NOT survive the test."}`);

  const RESULTS_DIR = new URL("results/", import.meta.url);
  mkdirSync(RESULTS_DIR, { recursive: true });
  const out = { ...result, git_commit: gitCommit(), generated_at: new Date().toISOString() };
  const fname = `cross_confluence_significance_${out.generated_at.replace(/[:.]/g, "-")}.json`;
  writeFileSync(new URL(fname, RESULTS_DIR), JSON.stringify(out, null, 2));
  console.log(`\nSaved: ${new URL(fname, RESULTS_DIR).pathname.replace(/^\/([A-Z]:)/, "$1")}`);
}

if (import.meta.url === `file://${process.argv[1].replace(/\\/g, "/")}` || import.meta.url === `file:///${process.argv[1].replace(/\\/g, "/")}`) {
  main();
}
