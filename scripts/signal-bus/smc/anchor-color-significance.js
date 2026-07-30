#!/usr/bin/env node
// Anchor-candle-color significance test (2026-07-30) -- motivated directly by the specific 4H
// order block identified earlier this session (bullish/demand order block anchored to a RED
// candle, origin 2026-07-06T08:00, box $62,421.85-63,177.93, mitigated 2026-07-08). Every order
// block's anchor bar is whichever bar had the most extreme parsed-low/high in its pivot-to-break
// window (calc.js) -- that bar's color is incidental to the algorithm, not chosen for it, so
// whether anchor color carries any real information is a genuinely open, testable question, not
// an assumption.
//
// Classic ICT/SMC convention (external lore, not house-tested -- see PRIOR_ART.md 2a) expects a
// BULLISH order block's anchor to be the "last down candle before the up move" (a RED anchor) and
// a BEARISH order block's anchor to be a GREEN one -- i.e. anchor color OPPOSITE the block's own
// side is the "textbook" case. LuxAlgo's actual anchoring rule has no such preference built in, so
// this tests whether blocks that happen to match that textbook convention perform differently
// from ones that don't, rather than assuming the lore is right or wrong.
//
// Three things tested, in order:
//   1. Per-side: does anchor color (red/green) predict hold rate, separately for bullish and
//      bearish order blocks (pooling all 8 timeframes -- same discipline as every other test here).
//   2. Per-timeframe breakdown of (1), since a pooled result can hide a real per-timeframe split.
//   3. Interaction with recurrence_count ("nested conditions") -- does the anchor-color effect (if
//      real) differ between low- and high-recurrence order blocks, or hold independently of it.
//
// Same permutation discipline as every other significance test in this project: order-block-level
// shuffle (not touch-level), since a block's touches are not independent observations of it.
//
// Usage: node scripts/signal-bus/smc/anchor-color-significance.js --iterations=50000

import { DatabaseSync } from "node:sqlite";
import { writeFileSync, mkdirSync } from "fs";
import { execSync } from "child_process";
import { loadCandles } from "../../backtest/lib/load-candles.js";

const DB_PATH = new URL("../../../data/signal-bus/smc.db", import.meta.url);
const args = Object.fromEntries(process.argv.slice(2).map((a) => a.replace(/^--/, "").split("=")));
const ITERATIONS = parseInt(args.iterations || "5000", 10);
const SEED = parseInt(args.seed || "42", 10);

function gitCommit() {
  try {
    return execSync("git rev-parse HEAD", { cwd: new URL("../../../", import.meta.url), encoding: "utf8" }).trim();
  } catch {
    return "unknown";
  }
}
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

// Permutation test on a binary label (0/1) vs binary outcome (0/1), order-block-level shuffle.
function permutationTest(obs, iterations, seed) {
  const realLabels = obs.map((o) => o.label);
  const realX = [], realY = [];
  for (const o of obs) for (const y of o.outcomes) { realX.push(o.label); realY.push(y); }
  const realR = pointBiserial(realX, realY);

  const n1 = obs.filter((o) => o.label === 1).flatMap((o) => o.outcomes);
  const n0 = obs.filter((o) => o.label === 0).flatMap((o) => o.outcomes);
  const rate1 = n1.length ? n1.reduce((s, y) => s + y, 0) / n1.length : null;
  const rate0 = n0.length ? n0.reduce((s, y) => s + y, 0) / n0.length : null;
  const realGap = rate1 != null && rate0 != null ? rate1 - rate0 : null;

  const rng = mulberry32(seed);
  const permutedR = [], permutedGaps = [];
  for (let iter = 0; iter < iterations; iter++) {
    const shuffled = shuffle(realLabels, rng);
    const px = [], py = [];
    let held1 = 0, cnt1 = 0, held0 = 0, cnt0 = 0;
    for (let i = 0; i < obs.length; i++) {
      for (const y of obs[i].outcomes) {
        px.push(shuffled[i]); py.push(y);
        if (shuffled[i] === 1) { held1 += y; cnt1++; } else { held0 += y; cnt0++; }
      }
    }
    permutedR.push(pointBiserial(px, py));
    if (cnt1 > 0 && cnt0 > 0) permutedGaps.push(held1 / cnt1 - held0 / cnt0);
  }
  permutedR.sort((a, b) => a - b);
  permutedGaps.sort((a, b) => a - b);
  const pR = permutedR.filter((r) => r >= realR).length / permutedR.length;
  const pGap = realGap == null ? null : permutedGaps.filter((g) => g >= realGap).length / permutedGaps.length;

  return {
    obCount: obs.length,
    touchCount: realX.length,
    rateRedOrLabel1: rate1,
    rateGreenOrLabel0: rate0,
    realGap,
    realR,
    pR,
    pGap,
    permutedRRange: [permutedR[0], permutedR[permutedR.length - 1]],
    permutedGapRange: permutedGaps.length ? [permutedGaps[0], permutedGaps[permutedGaps.length - 1]] : null,
  };
}

async function loadObsWithAnchorColor() {
  const db = new DatabaseSync(DB_PATH, { readOnly: true });
  const obRows = db.prepare(`SELECT id, timeframe, side, origin_bar_idx, recurrence_count FROM order_blocks`).all();
  const touchRows = db.prepare(
    `SELECT order_block_id, outcome, ongoing FROM order_block_touches WHERE order_block_id IN (${obRows.map(() => "?").join(",") || "0"})`,
  ).all(...obRows.map((o) => o.id));
  db.close();

  const touchesByOb = new Map();
  for (const t of touchRows) {
    if (t.ongoing) continue;
    if (!touchesByOb.has(t.order_block_id)) touchesByOb.set(t.order_block_id, []);
    touchesByOb.get(t.order_block_id).push(t.outcome === "held" ? 1 : 0);
  }

  const byTf = new Map();
  for (const ob of obRows) {
    if (!touchesByOb.has(ob.id)) continue;
    if (!byTf.has(ob.timeframe)) byTf.set(ob.timeframe, []);
    byTf.get(ob.timeframe).push(ob);
  }

  const results = [];
  for (const [tf, obsInTf] of byTf) {
    const candles = await loadCandles(tf);
    for (const ob of obsInTf) {
      const bar = candles[ob.origin_bar_idx];
      if (!bar) continue;
      const anchorColor = bar.c < bar.o ? "red" : "green";
      results.push({
        id: ob.id, timeframe: ob.timeframe, side: ob.side, recurrenceCount: ob.recurrence_count,
        anchorColor, outcomes: touchesByOb.get(ob.id),
      });
    }
  }
  return results;
}

function main() {
  loadObsWithAnchorColor().then((all) => {
    console.log(`Loaded ${all.length} order blocks with resolved touches and known anchor color.\n`);

    const output = { git_commit: gitCommit(), generated_at: new Date().toISOString() };

    // --- Test 1: per-side, anchor color vs hold rate, all timeframes pooled ---
    console.log("=== Test 1: anchor color vs hold rate, per side (all 8 timeframes pooled) ===");
    output.perSide = {};
    for (const side of ["bullish", "bearish"]) {
      const obsSide = all.filter((o) => o.side === side).map((o) => ({ label: o.anchorColor === "red" ? 1 : 0, outcomes: o.outcomes }));
      const r = permutationTest(obsSide, ITERATIONS, SEED);
      console.log(`  ${side.padEnd(8)} n_obs=${r.obCount}  n_touches=${r.touchCount}  red_hold=${(r.rateRedOrLabel1 * 100).toFixed(1)}%  green_hold=${(r.rateGreenOrLabel0 * 100).toFixed(1)}%  gap=${(r.realGap * 100).toFixed(2)}pts  r=${r.realR.toFixed(4)}  p(r)=${r.pR.toFixed(4)}  p(gap)=${r.pGap.toFixed(4)}`);
      output.perSide[side] = r;
    }

    // --- Test 1b: "matches classic ICT convention" (bullish+red OR bearish+green) vs not ---
    console.log("\n=== Test 1b: anchor matches classic-ICT convention (bullish+red / bearish+green) vs not, pooled ===");
    const obsConvention = all.map((o) => ({
      label: (o.side === "bullish" && o.anchorColor === "red") || (o.side === "bearish" && o.anchorColor === "green") ? 1 : 0,
      outcomes: o.outcomes,
    }));
    const rConv = permutationTest(obsConvention, ITERATIONS, SEED);
    console.log(`  matches_convention n_obs=${rConv.obCount}  hold=${(rConv.rateRedOrLabel1 * 100).toFixed(1)}%  vs non-matching hold=${(rConv.rateGreenOrLabel0 * 100).toFixed(1)}%  gap=${(rConv.realGap * 100).toFixed(2)}pts  r=${rConv.realR.toFixed(4)}  p(r)=${rConv.pR.toFixed(4)}  p(gap)=${rConv.pGap.toFixed(4)}`);
    output.conventionMatch = rConv;

    // --- Test 2: per-timeframe breakdown, bullish side only (the side that motivated this) ---
    console.log("\n=== Test 2: bullish-only, anchor color vs hold rate, per timeframe ===");
    output.perTimeframeBullish = {};
    const tfOrder = ["1w", "1d", "4h", "3h", "2h", "1h", "15m", "5m"];
    for (const tf of tfOrder) {
      const obsTf = all.filter((o) => o.side === "bullish" && o.timeframe === tf).map((o) => ({ label: o.anchorColor === "red" ? 1 : 0, outcomes: o.outcomes }));
      if (obsTf.length < 5) { console.log(`  ${tf.padEnd(5)} too few order blocks (n=${obsTf.length}), skipped`); continue; }
      const r = permutationTest(obsTf, Math.min(ITERATIONS, 20000), SEED);
      console.log(`  ${tf.padEnd(5)} n_obs=${r.obCount}  n_touches=${r.touchCount}  red_hold=${(r.rateRedOrLabel1 * 100).toFixed(1)}%  green_hold=${(r.rateGreenOrLabel0 * 100).toFixed(1)}%  gap=${(r.realGap * 100).toFixed(2)}pts  p(gap)=${r.pGap != null ? r.pGap.toFixed(4) : "n/a"}`);
      output.perTimeframeBullish[tf] = r;
    }

    // --- Test 3: interaction with recurrence_count ("nested conditions") ---
    console.log("\n=== Test 3: bullish-only, anchor color effect stratified by recurrence_count ===");
    output.byRecurrence = {};
    for (const bucket of [{ name: "isolated (1)", test: (r) => r === 1 }, { name: "some (2)", test: (r) => r === 2 }, { name: "high (3+)", test: (r) => r >= 3 }]) {
      const obsBucket = all.filter((o) => o.side === "bullish" && bucket.test(o.recurrenceCount)).map((o) => ({ label: o.anchorColor === "red" ? 1 : 0, outcomes: o.outcomes }));
      if (obsBucket.length < 5) { console.log(`  ${bucket.name.padEnd(14)} too few (n=${obsBucket.length}), skipped`); continue; }
      const r = permutationTest(obsBucket, Math.min(ITERATIONS, 20000), SEED);
      console.log(`  ${bucket.name.padEnd(14)} n_obs=${r.obCount}  red_hold=${(r.rateRedOrLabel1 * 100).toFixed(1)}%  green_hold=${(r.rateGreenOrLabel0 * 100).toFixed(1)}%  gap=${(r.realGap * 100).toFixed(2)}pts  p(gap)=${r.pGap != null ? r.pGap.toFixed(4) : "n/a"}`);
      output.byRecurrence[bucket.name] = r;
    }

    const RESULTS_DIR = new URL("results/", import.meta.url);
    mkdirSync(RESULTS_DIR, { recursive: true });
    const fname = `anchor_color_significance_${output.generated_at.replace(/[:.]/g, "-")}.json`;
    writeFileSync(new URL(fname, RESULTS_DIR), JSON.stringify(output, null, 2));
    console.log(`\nSaved: ${new URL(fname, RESULTS_DIR).pathname.replace(/^\/([A-Z]:)/, "$1")}`);
  });
}

main();
