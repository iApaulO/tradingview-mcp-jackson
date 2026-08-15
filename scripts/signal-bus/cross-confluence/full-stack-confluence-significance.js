#!/usr/bin/env node
// Isolates every SMC signal type (order block, structure BOS/CHoCH, EQH/EQL liquidity) and every
// combination of them against Divergence-for-Many zones, each tested against "none" ON ITS OWN --
// not lumped into a single "any confluence" binary the way cross-confluence-significance.js did.
// That lumping is a real risk: a weak OB-only effect and a weak liquidity-only effect can dilute a
// real "both together" effect into a null when they're all pooled as label=1 vs label=0.
//
// 2026-08-05: built after iapaulo asked what the merit difference is between OB/structure/EQH-EQL
// individually -- turns out that specific comparison was never actually run; only "any" (OB or
// liquidity) and "structure alone" had been tested. This closes that gap.
//
// Definitions match the existing tests exactly (same DBs, same 0.2% tolerance, same "active/
// unmitigated as of confirmed_time" rule for OB/EQH-EQL, same "most recent structure event, any
// age" rule for BOS/CHoCH -- see cross-confluence-significance.js and
// structure-confluence-significance.js for the individual rationale on each).
//
// Usage: node scripts/signal-bus/cross-confluence/full-stack-confluence-significance.js --iterations=20000

import { DatabaseSync } from "node:sqlite";
import { writeFileSync, mkdirSync } from "fs";
import { execSync } from "child_process";

const DIV_DB_PATH = new URL("../../../data/signal-bus/divergence-for-many.db", import.meta.url);
const SMC_DB_PATH = new URL("../../../data/signal-bus/smc.db", import.meta.url);
const PRICE_TOLERANCE_PCT = 0.002;

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
  } catch { return "unknown"; }
}
function sideMatch(divergenceSide, obOrEqSide) {
  if (divergenceSide === "bullish") return obOrEqSide === "bullish" || obOrEqSide === "EQL";
  return obOrEqSide === "bearish" || obOrEqSide === "EQH";
}
function mostRecentStructureEvent(sortedEvents, t) {
  let lo = 0, hi = sortedEvents.length - 1, ans = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (sortedEvents[mid].time <= t) { ans = mid; lo = mid + 1; } else { hi = mid - 1; }
  }
  return ans === -1 ? null : sortedEvents[ans];
}

function classifyZone(zone, orderBlocks, eqhEql, structBySide) {
  const t = zone.confirmed_time;
  let ob = false;
  for (const b of orderBlocks) {
    if (!sideMatch(zone.side, b.side)) continue;
    if (b.created_time > t) continue;
    if (b.mitigated_time != null && b.mitigated_time <= t) continue;
    if (zone.price >= b.bar_low && zone.price <= b.bar_high) { ob = true; break; }
  }
  let liq = false;
  for (const eq of eqhEql) {
    if (!sideMatch(zone.side, eq.side)) continue;
    if (eq.confirm_time > t) continue;
    if (eq.sweep_time != null && eq.sweep_time <= t) continue;
    if (Math.abs(eq.level - zone.price) / zone.price <= PRICE_TOLERANCE_PCT) { liq = true; break; }
  }
  const recent = mostRecentStructureEvent(structBySide[zone.side], t);
  const struct = recent != null && Math.abs(recent.price - zone.price) / zone.price <= PRICE_TOLERANCE_PCT;
  return { ob, liq, struct };
}

function pointBiserialForLabels(labels, enriched) {
  const conf = [], out = [];
  for (let i = 0; i < enriched.length; i++) for (const o of enriched[i].outcomes) { conf.push(labels[i]); out.push(o); }
  return pointBiserial(conf, out);
}
function gapForLabels(labels, enriched) {
  let held1 = 0, n1 = 0, held0 = 0, n0 = 0;
  for (let i = 0; i < enriched.length; i++) for (const o of enriched[i].outcomes) {
    if (labels[i] === 1) { n1++; held1 += o; } else { n0++; held0 += o; }
  }
  if (n1 === 0 || n0 === 0) return null;
  return held1 / n1 - held0 / n0;
}

function testCategory(name, matchFn, enriched, iterations, seed) {
  const labels = enriched.map((z) => (matchFn(z) ? 1 : 0));
  const n1 = labels.filter((l) => l === 1).length;
  const touches1 = enriched.reduce((s, z, i) => s + (labels[i] === 1 ? z.outcomes.length : 0), 0);
  const holdRate1 = enriched.reduce((s, z, i) => labels[i] === 1 ? s + z.outcomes.reduce((a, o) => a + o, 0) : s, 0) / (touches1 || 1);
  const touches0 = enriched.reduce((s, z, i) => s + (labels[i] === 0 ? z.outcomes.length : 0), 0);
  const holdRate0 = enriched.reduce((s, z, i) => labels[i] === 0 ? s + z.outcomes.reduce((a, o) => a + o, 0) : s, 0) / (touches0 || 1);

  const realR = pointBiserialForLabels(labels, enriched);
  const realGap = gapForLabels(labels, enriched);

  const rng = mulberry32(seed);
  const permutedR = [], permutedGaps = [];
  for (let iter = 0; iter < iterations; iter++) {
    const shuffled = shuffle(labels, rng);
    permutedR.push(pointBiserialForLabels(shuffled, enriched));
    const g = gapForLabels(shuffled, enriched);
    if (g != null) permutedGaps.push(g);
  }
  permutedR.sort((a, b) => a - b);
  permutedGaps.sort((a, b) => a - b);
  const pR = permutedR.filter((r) => r >= realR).length / permutedR.length;
  const pGap = realGap == null ? null : permutedGaps.filter((g) => g >= realGap).length / permutedGaps.length;

  return { name, n: n1, touches: touches1, holdRate1, holdRate0, r: realR, pR, gap: realGap, pGap };
}

export function runFullStackTest({ iterations = ITERATIONS, seed = SEED } = {}) {
  const dbDiv = new DatabaseSync(DIV_DB_PATH, { readOnly: true });
  const zones = dbDiv.prepare(`SELECT id, timeframe, side, price, confirmed_time FROM zones`).all();
  const touches = dbDiv.prepare(`SELECT zone_id, outcome FROM touches`).all();
  dbDiv.close();

  const dbSmc = new DatabaseSync(SMC_DB_PATH, { readOnly: true });
  const orderBlocks = dbSmc.prepare(`SELECT side, bar_high, bar_low, created_time, mitigated_time FROM order_blocks`).all();
  const eqhEql = dbSmc.prepare(`SELECT side, level, confirm_time, sweep_time FROM eqh_eql_events`).all();
  const allEvents = dbSmc.prepare(`SELECT side, time, price FROM structure_events ORDER BY time ASC`).all();
  dbSmc.close();
  const structBySide = { bullish: allEvents.filter((e) => e.side === "bullish"), bearish: allEvents.filter((e) => e.side === "bearish") };

  const touchesByZone = new Map();
  for (const t of touches) {
    if (!touchesByZone.has(t.zone_id)) touchesByZone.set(t.zone_id, []);
    touchesByZone.get(t.zone_id).push(t.outcome === "held" ? 1 : 0);
  }

  const enriched = zones.filter((z) => touchesByZone.has(z.id)).map((z) => {
    const cls = classifyZone(z, orderBlocks, eqhEql, structBySide);
    return { ...z, ...cls, outcomes: touchesByZone.get(z.id) };
  });

  const categories = [
    ["OB-only", (z) => z.ob && !z.liq && !z.struct],
    ["liquidity-only", (z) => z.liq && !z.ob && !z.struct],
    ["structure-only", (z) => z.struct && !z.ob && !z.liq],
    ["OB+liquidity", (z) => z.ob && z.liq && !z.struct],
    ["OB+structure", (z) => z.ob && z.struct && !z.liq],
    ["liquidity+structure", (z) => z.liq && z.struct && !z.ob],
    ["all-three", (z) => z.ob && z.liq && z.struct],
    ["any", (z) => z.ob || z.liq || z.struct],
  ];

  const results = categories.map(([name, fn]) => testCategory(name, fn, enriched, iterations, seed));
  return { zoneCount: enriched.length, touchCount: enriched.reduce((s, z) => s + z.outcomes.length, 0), iterations, seed, results };
}

function main() {
  const out = runFullStackTest({ iterations: ITERATIONS, seed: SEED });
  console.log(`Loaded ${out.zoneCount} divergence zones (${out.touchCount} touches). Each category tested in isolation against its own complement.\n`);
  console.log("category".padEnd(20) + "n_zones".padEnd(9) + "n_touch".padEnd(9) + "hold%(in)".padEnd(11) + "hold%(out)".padEnd(11) + "gap_pts".padEnd(9) + "r".padEnd(9) + "p(r)".padEnd(8) + "p(gap)".padEnd(8) + "verdict");
  for (const r of out.results) {
    const sig = r.pR < 0.05 && r.pGap < 0.05 ? "SIGNIFICANT" : r.pR < 0.05 || r.pGap < 0.05 ? "mixed" : "null";
    console.log(
      r.name.padEnd(20) + String(r.n).padEnd(9) + String(r.touches).padEnd(9) +
      (r.holdRate1 * 100).toFixed(1).padEnd(11) + (r.holdRate0 * 100).toFixed(1).padEnd(11) +
      (r.gap * 100).toFixed(2).padEnd(9) + r.r.toFixed(4).padEnd(9) + r.pR.toFixed(4).padEnd(8) + r.pGap.toFixed(4).padEnd(8) + sig
    );
  }

  const RESULTS_DIR = new URL("results/", import.meta.url);
  mkdirSync(RESULTS_DIR, { recursive: true });
  const payload = { ...out, git_commit: gitCommit(), generated_at: new Date().toISOString() };
  const fname = `full_stack_confluence_significance_${payload.generated_at.replace(/[:.]/g, "-")}.json`;
  writeFileSync(new URL(fname, RESULTS_DIR), JSON.stringify(payload, null, 2));
  console.log(`\nSaved: ${new URL(fname, RESULTS_DIR).pathname.replace(/^\/([A-Z]:)/, "$1")}`);
}

if (import.meta.url === `file://${process.argv[1].replace(/\\/g, "/")}` || import.meta.url === `file:///${process.argv[1].replace(/\\/g, "/")}`) {
  main();
}
