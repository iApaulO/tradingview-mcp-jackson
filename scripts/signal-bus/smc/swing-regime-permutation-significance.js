#!/usr/bin/env node
// Formal significance test on #94 (swing-bias-flip regime-following, swing-high/low stop) per
// iapaulo's request to run this before the portfolio-capacity check. Tests whether the FLIP's
// direction carries real information, not just "being in a long-term-uptrending market helps" --
// null: randomly assigning long/short to each regime segment (independent of what the swing
// structure actually signaled) does just as well on average.
//
// Correctly handles the asymmetry #94 introduced: exit mechanics differ by side (a long's stop is
// the swing LOW, a short's stop is the swing HIGH -- not a simple sign flip of the same exit).
// Precomputes BOTH the "as if long" and "as if short" outcome for every segment ONCE (two
// simulations per segment, not per permutation), then the permutation just samples which label
// applies -- correct and fast, instead of naively negating a single fixed exit.
//
// Usage: node scripts/signal-bus/smc/swing-regime-permutation-significance.js [--tf=1h,2h,3h,4h] [--iterations=20000]

import { DatabaseSync } from "node:sqlite";
import { writeFileSync, mkdirSync } from "fs";
import { execSync } from "child_process";
import { loadCandles } from "../../backtest/lib/load-candles.js";
import { applyCosts, FEE_TIERS, REPRESENTATIVE_FUNDING_PCT_PER_HOUR } from "../../backtest/lib/costs.js";
import { computeSwingPivotSeries } from "./calc.js";

const SMC_DB_PATH = new URL("../../../data/signal-bus/smc.db", import.meta.url);
const args = Object.fromEntries(process.argv.slice(2).map((a) => a.replace(/^--/, "").split("=")));
const TFS = args.tf ? args.tf.split(",") : ["4h", "3h", "2h", "1h", "15m", "5m"];
const ITERATIONS = parseInt(args.iterations || "20000", 10);
const SEED = 42;

function gitCommit() {
  try { return execSync("git rev-parse HEAD", { cwd: new URL("../../../", import.meta.url), encoding: "utf8" }).trim(); }
  catch { return "unknown"; }
}
function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
// Simulate one side's outcome for a fixed segment window (no target -- exits at naturalExitIdx
// unless the side-specific structural stop fires first).
function simulateSide(candles, entryIdx, naturalExitIdx, side, stopPrice) {
  if (Number.isFinite(stopPrice) && (side === "long" ? stopPrice < candles[entryIdx].o : stopPrice > candles[entryIdx].o)) {
    for (let j = entryIdx; j < naturalExitIdx; j++) {
      const bar = candles[j];
      const hitStop = side === "long" ? bar.l <= stopPrice : bar.h >= stopPrice;
      if (hitStop) return { exitPrice: stopPrice, exitTime: bar.t };
    }
  }
  return { exitPrice: candles[naturalExitIdx].o, exitTime: candles[naturalExitIdx].t };
}

async function main() {
  const db = new DatabaseSync(SMC_DB_PATH, { readOnly: true });
  const confirmedParams = { takerFeePct: FEE_TIERS.bitunix_futures_vip1.takerFeePct, fundingPctPerHour: REPRESENTATIVE_FUNDING_PCT_PER_HOUR };

  for (const tf of TFS) {
    const flips = db.prepare("SELECT side, bar_idx, time FROM structure_events WHERE scope = 'swing' AND type = 'CHOCH' AND timeframe = ? ORDER BY bar_idx ASC").all(tf);
    const candles = await loadCandles(tf);
    const pivots = computeSwingPivotSeries(candles);

    // Precompute both scenarios per segment.
    const longRaw = [], shortRaw = [], trueIsLong = [];
    for (let i = 0; i < flips.length - 1; i++) {
      const entryIdx = flips[i].bar_idx + 1, naturalExitIdx = flips[i + 1].bar_idx + 1;
      if (entryIdx >= candles.length || naturalExitIdx >= candles.length || naturalExitIdx <= entryIdx) continue;
      const entryPrice = candles[entryIdx].o, entryTime = candles[entryIdx].t;

      const longStop = pivots.swingLowLevel[flips[i].bar_idx];
      const longExit = simulateSide(candles, entryIdx, naturalExitIdx, "long", longStop);
      const longPnl = (longExit.exitPrice - entryPrice) / entryPrice;
      longRaw.push({ side: "long", entryTime, entryPrice, exitTime: longExit.exitTime, exitPrice: longExit.exitPrice, pnlPct: longPnl });

      const shortStop = pivots.swingHighLevel[flips[i].bar_idx];
      const shortExit = simulateSide(candles, entryIdx, naturalExitIdx, "short", shortStop);
      const shortPnl = (entryPrice - shortExit.exitPrice) / entryPrice;
      shortRaw.push({ side: "short", entryTime, entryPrice, exitTime: shortExit.exitTime, exitPrice: shortExit.exitPrice, pnlPct: shortPnl });

      trueIsLong.push(flips[i].side === "bullish");
    }
    const n = trueIsLong.length;
    if (n < 30) { console.log(`${tf}: n=${n}, too thin`); continue; }

    // Cost each scenario array once (funding is side-symmetric under the default pessimistic mode
    // used everywhere else in this project, so this is a fair, consistent per-trade cost).
    const longCosted = applyCosts(longRaw, confirmedParams).map((t) => t.pnlPct);
    const shortCosted = applyCosts(shortRaw, confirmedParams).map((t) => t.pnlPct);

    const trueVals = new Float64Array(n);
    for (let i = 0; i < n; i++) trueVals[i] = trueIsLong[i] ? longCosted[i] : shortCosted[i];
    const realMean = trueVals.reduce((s, x) => s + x, 0) / n;

    const rng = mulberry32(SEED);
    let geq = 0;
    for (let it = 0; it < ITERATIONS; it++) {
      let sum = 0;
      for (let i = 0; i < n; i++) sum += rng() < 0.5 ? longCosted[i] : shortCosted[i];
      if (sum / n >= realMean) geq++;
    }
    const p = geq / ITERATIONS;
    console.log(`${tf.padEnd(4)} n=${n}  real costed mean=${(realMean * 100).toFixed(4)}%/trade  vs random-direction null: p=${p.toFixed(4)}${p < 0.05 ? "*" : ""}`);
  }
  db.close();
}

main().catch((err) => { console.error("Fatal:", err); process.exit(1); });
