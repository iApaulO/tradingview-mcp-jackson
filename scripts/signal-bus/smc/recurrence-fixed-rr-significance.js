#!/usr/bin/env node
// Formal permutation significance test on the recurrence-backtest-fixed-rr.js result -- that
// script found the high-recurrence bucket clearing real costs at every R multiple tested (the
// first such result in this project), verified diagnostically (side-split, distinct order block
// count, timeframe spread) but only 1R had gotten the same permutation-test rigor every hold-rate
// classification in this project received -- 1.5R/2R/3R were flagged as untested extrapolation
// in decision-policy.md's Tested Setup Alert. This formalizes all four: same order-block-level
// shuffle as confluence-significance.js/recurrence-significance.js, applied to each R-multiple's
// fixed-R win/loss outcome instead of touches.js's held/broken, run independently per R (not one
// test reused across R values -- each R multiple resolves a DIFFERENT set of trades, since a
// wider target changes which bar a trade resolves on).
//
// Usage: node scripts/signal-bus/smc/recurrence-fixed-rr-significance.js --iterations=50000 --r=1,1.5,2,3

import { DatabaseSync } from "node:sqlite";
import { writeFileSync, mkdirSync } from "fs";
import { execSync } from "child_process";
import { loadCandles } from "../../backtest/lib/load-candles.js";

const DB_PATH = new URL("../../../data/signal-bus/smc.db", import.meta.url);
const args = Object.fromEntries(process.argv.slice(2).map((a) => a.replace(/^--/, "").split("=")));
const ITERATIONS = parseInt(args.iterations || "5000", 10);
const SEED = parseInt(args.seed || "42", 10);
const R_MULTIPLES = (args.r || "1,1.5,2,3").split(",").map(Number);
const MAX_HOLD_BARS = 200;

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
function topVsBottomGap(xs, ys) {
  let heldTop = 0, nTop = 0, heldBottom = 0, nBottom = 0;
  const maxX = Math.max(...xs);
  for (let i = 0; i < xs.length; i++) {
    if (xs[i] === 1) { nBottom++; heldBottom += ys[i]; }
    else if (xs[i] === maxX) { nTop++; heldTop += ys[i]; }
  }
  if (nTop === 0 || nBottom === 0) return null;
  return { gap: heldTop / nTop - heldBottom / nBottom, nTop, nBottom, maxX };
}

async function buildFixedRWinsByOrderBlock(rMultiple) {
  const db = new DatabaseSync(DB_PATH, { readOnly: true });
  const obRows = db.prepare(`SELECT id, timeframe, side, bar_high, bar_low, recurrence_count FROM order_blocks`).all();
  const touchRows = db.prepare(
    `SELECT order_block_id, start_bar_idx, ongoing FROM order_block_touches WHERE order_block_id IN (${obRows.map(() => "?").join(",") || "0"})`,
  ).all(...obRows.map((o) => o.id));
  db.close();

  const obById = new Map(obRows.map((o) => [o.id, o]));
  const entriesByTf = new Map();
  for (const t of touchRows) {
    const ob = obById.get(t.order_block_id);
    if (!entriesByTf.has(ob.timeframe)) entriesByTf.set(ob.timeframe, []);
    entriesByTf.get(ob.timeframe).push({ startBarIdx: t.start_bar_idx, ob });
  }

  const obOutcomes = new Map(); // ob.id -> { recurrenceCount, wins: [0/1,...] }
  for (const [tf, entries] of entriesByTf) {
    const candles = await loadCandles(tf);
    for (const e of entries) {
      const entryIdx = e.startBarIdx + 1;
      if (entryIdx >= candles.length) continue;
      const entryPrice = candles[entryIdx].o;
      const side = e.ob.side === "bullish" ? "long" : "short";
      const stopPrice = e.ob.side === "bullish" ? e.ob.bar_low : e.ob.bar_high;
      const risk = Math.abs(entryPrice - stopPrice);
      if (risk <= 0) continue;
      const targetPrice = side === "long" ? entryPrice + rMultiple * risk : entryPrice - rMultiple * risk;
      let outcome = null;
      const endCheck = Math.min(candles.length - 1, entryIdx + MAX_HOLD_BARS);
      for (let j = entryIdx; j <= endCheck; j++) {
        const bar = candles[j];
        const hitStop = side === "long" ? bar.l <= stopPrice : bar.h >= stopPrice;
        const hitTarget = side === "long" ? bar.h >= targetPrice : bar.l <= targetPrice;
        if (hitStop) { outcome = 0; break; }
        if (hitTarget) { outcome = 1; break; }
      }
      if (outcome == null) continue;
      if (!obOutcomes.has(e.ob.id)) obOutcomes.set(e.ob.id, { recurrenceCount: e.ob.recurrence_count, wins: [] });
      obOutcomes.get(e.ob.id).wins.push(outcome);
    }
  }
  return [...obOutcomes.values()];
}

async function runForRMultiple(rMultiple) {
  console.log(`\n=== R-multiple: ${rMultiple}R ===`);
  const obs = await buildFixedRWinsByOrderBlock(rMultiple);
  const touchCount = obs.reduce((s, o) => s + o.wins.length, 0);
  console.log(`${obs.length} order blocks, ${touchCount} resolved ${rMultiple}R trades.`);

  const realLabels = obs.map((o) => o.recurrenceCount);
  const realX = [], realY = [];
  for (const o of obs) for (const w of o.wins) { realX.push(o.recurrenceCount); realY.push(w); }

  const realR = pointBiserial(realX, realY);
  const realGapInfo = topVsBottomGap(realX, realY);
  const realGap = realGapInfo?.gap;

  console.log(`Real point-biserial correlation (recurrenceCount vs. ${rMultiple}R win/loss): r = ${realR.toFixed(4)}`);
  if (realGapInfo) console.log(`Real top(${realGapInfo.maxX})-vs-bottom(1) win-rate gap: ${(realGap * 100).toFixed(2)} points (n_top=${realGapInfo.nTop}, n_bottom=${realGapInfo.nBottom})`);

  const rng = mulberry32(SEED);
  const permutedR = [], permutedGaps = [];
  for (let iter = 0; iter < ITERATIONS; iter++) {
    const shuffled = shuffle(realLabels, rng);
    const px = [], py = [];
    for (let i = 0; i < obs.length; i++) for (const w of obs[i].wins) { px.push(shuffled[i]); py.push(w); }
    permutedR.push(pointBiserial(px, py));
    const g = topVsBottomGap(px, py);
    if (g != null) permutedGaps.push(g.gap);
  }
  permutedR.sort((a, b) => a - b);
  permutedGaps.sort((a, b) => a - b);
  const pR = permutedR.filter((r) => r >= realR).length / permutedR.length;
  const pGap = realGap == null ? null : permutedGaps.filter((g) => g >= realGap).length / permutedGaps.length;

  console.log(`--- Permutation test (${ITERATIONS} iterations, order-block-level shuffle, seed=${SEED}) ---`);
  console.log(`Correlation: permuted mean=${(permutedR.reduce((s, x) => s + x, 0) / permutedR.length).toFixed(4)}, range=[${permutedR[0].toFixed(4)}, ${permutedR[permutedR.length - 1].toFixed(4)}]`);
  console.log(`  p = ${pR.toFixed(4)} ${pR < 0.05 ? "(significant at 5%)" : "(NOT significant)"}`);
  if (realGap != null) {
    console.log(`Gap: permuted mean=${(permutedGaps.reduce((s, x) => s + x, 0) / permutedGaps.length * 100).toFixed(2)}pts, range=[${(permutedGaps[0] * 100).toFixed(2)}, ${(permutedGaps[permutedGaps.length - 1] * 100).toFixed(2)}]`);
    console.log(`  p = ${pGap.toFixed(4)} ${pGap < 0.05 ? "(significant at 5%)" : "(NOT significant)"}`);
  }
  const verdict = pGap != null && pR < 0.05 && pGap < 0.05 ? "Both statistics clear 5% -- real, not a labeling artifact." : (pR < 0.05 || (pGap != null && pGap < 0.05)) ? "Mixed -- unresolved." : "Neither clears 5% -- does NOT survive the test.";
  console.log(`Verdict: ${verdict}`);

  return {
    rMultiple, obCount: obs.length, tradeCount: touchCount,
    correlation: { real: realR, p: pR, permutedRange: [permutedR[0], permutedR[permutedR.length - 1]] },
    gap: realGap == null ? null : { real: realGap, p: pGap, nTop: realGapInfo.nTop, nBottom: realGapInfo.nBottom, permutedRange: [permutedGaps[0], permutedGaps[permutedGaps.length - 1]] },
    verdict,
  };
}

async function main() {
  const results = {};
  for (const r of R_MULTIPLES) {
    results[`${r}R`] = await runForRMultiple(r);
  }

  console.log("\n\n=== Summary across all R multiples ===");
  for (const [label, r] of Object.entries(results)) {
    console.log(`  ${label.padEnd(5)} n=${r.tradeCount}  correlation r=${r.correlation.real.toFixed(4)} p=${r.correlation.p.toFixed(4)}  gap=${r.gap ? (r.gap.real * 100).toFixed(1) + "pts p=" + r.gap.p.toFixed(4) : "n/a"}  -- ${r.verdict}`);
  }

  const out = { results, git_commit: gitCommit(), generated_at: new Date().toISOString() };
  const RESULTS_DIR = new URL("results/", import.meta.url);
  mkdirSync(RESULTS_DIR, { recursive: true });
  const fname = `recurrence_fixed_rr_significance_${out.generated_at.replace(/[:.]/g, "-")}.json`;
  writeFileSync(new URL(fname, RESULTS_DIR), JSON.stringify(out, null, 2));
  console.log(`\nSaved: ${new URL(fname, RESULTS_DIR).pathname.replace(/^\/([A-Z]:)/, "$1")}`);
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
