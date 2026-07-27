#!/usr/bin/env node
// Follow-up to confluence-backtest.js, mirroring smc/confluence-backtest-fixed-rr.js's method.
// These zones are LINES, not boxes, so there's no natural far-boundary stop the way an order
// block had one -- risk R is instead defined from the zone's OWN ATR-based tolerance
// (0.6 x ATR(14) at zone creation, the exact constant calc.js already uses to decide whether two
// nearby pivots count as "the same" zone) rather than an invented arbitrary distance. Same
// fixed-R:R race-to-target-or-stop simulation as SMC's version otherwise.
//
// Usage: node scripts/signal-bus/divergence-for-many/confluence-backtest-fixed-rr.js [--r=1,1.5,2,3]

import { DatabaseSync } from "node:sqlite";
import { writeFileSync, mkdirSync } from "fs";
import { execSync } from "child_process";
import { loadCandles } from "../../backtest/lib/load-candles.js";
import { computeMetrics } from "../../backtest/lib/metrics.js";
import { applyCosts, FEE_TIERS, REPRESENTATIVE_FUNDING_PCT_PER_HOUR } from "../../backtest/lib/costs.js";

const DB_PATH = new URL("../../../data/signal-bus/divergence-for-many.db", import.meta.url);
const args = Object.fromEntries(process.argv.slice(2).map((a) => a.replace(/^--/, "").split("=")));
const SINGLE_TF = args.tf || null;
const R_MULTIPLES = (args.r || "1,1.5,2,3").split(",").map(Number);
const MAX_HOLD_BARS = 200;
const ATR_MULT = 0.6; // same constant calc.js uses for zone dedup tolerance

function gitCommit() {
  try {
    return execSync("git rev-parse HEAD", { cwd: new URL("../../../", import.meta.url), encoding: "utf8" }).trim();
  } catch {
    return "unknown";
  }
}

async function buildEntries(tfFilter) {
  const db = new DatabaseSync(DB_PATH, { readOnly: true });
  const zoneRows = db.prepare(
    `SELECT id, timeframe, side, price, atr_at_creation, confluence_count FROM zones${tfFilter ? " WHERE timeframe = ?" : ""}`,
  ).all(...(tfFilter ? [tfFilter] : []));
  const touchRows = db.prepare(
    `SELECT zone_id, start_bar_idx, outcome, ongoing FROM touches WHERE zone_id IN (${zoneRows.map(() => "?").join(",") || "0"})`,
  ).all(...zoneRows.map((z) => z.id));
  db.close();

  const zoneById = new Map(zoneRows.map((z) => [z.id, z]));
  const entriesByTf = new Map();
  for (const t of touchRows) {
    const z = zoneById.get(t.zone_id);
    if (!entriesByTf.has(z.timeframe)) entriesByTf.set(z.timeframe, []);
    entriesByTf.get(z.timeframe).push({ startBarIdx: t.start_bar_idx, zone: z });
  }
  return entriesByTf;
}

function bucketOf(cc) {
  return cc >= 4 ? "4+ (top)" : cc === 3 ? "3" : cc === 2 ? "2" : "1 (isolated)";
}

function simulateFixedR(candles, entryIdx, side, stopPrice, targetPrice) {
  const endCheck = Math.min(candles.length - 1, entryIdx + MAX_HOLD_BARS);
  for (let j = entryIdx; j <= endCheck; j++) {
    const bar = candles[j];
    const hitStop = side === "long" ? bar.l <= stopPrice : bar.h >= stopPrice;
    const hitTarget = side === "long" ? bar.h >= targetPrice : bar.l <= targetPrice;
    if (hitStop) return { exitPrice: stopPrice, exitTime: bar.t, outcome: "stop" };
    if (hitTarget) return { exitPrice: targetPrice, exitTime: bar.t, outcome: "target" };
  }
  return null;
}

async function main() {
  console.log(SINGLE_TF ? `Building entries for ${SINGLE_TF} only ...` : "Building entries across all timeframes (combined) ...");
  const entriesByTf = await buildEntries(SINGLE_TF);

  const confirmedParams = { takerFeePct: FEE_TIERS.confirmed_derivatives.takerFeePct, fundingPctPerHour: REPRESENTATIVE_FUNDING_PCT_PER_HOUR };
  const allResults = {};

  for (const rMult of R_MULTIPLES) {
    console.log(`\n=== R-multiple target: ${rMult}R (risk = ${ATR_MULT}x ATR(14) at zone creation, target = entry +/- ${rMult}x that) ===`);
    const buckets = { "1 (isolated)": [], "2": [], "3": [], "4+ (top)": [] };
    let inconclusive = 0, skippedNoAtr = 0;

    for (const [tf, entries] of entriesByTf) {
      const candles = await loadCandles(tf);
      for (const e of entries) {
        const entryIdx = e.startBarIdx + 1;
        if (entryIdx >= candles.length) continue;
        if (e.zone.atr_at_creation == null || e.zone.atr_at_creation <= 0) {
          skippedNoAtr++;
          continue;
        }
        const entryPrice = candles[entryIdx].o;
        const entryTime = candles[entryIdx].t;
        const side = e.zone.side === "bullish" ? "long" : "short";
        const risk = ATR_MULT * e.zone.atr_at_creation;
        const stopPrice = side === "long" ? entryPrice - risk : entryPrice + risk;
        const targetPrice = side === "long" ? entryPrice + rMult * risk : entryPrice - rMult * risk;

        const result = simulateFixedR(candles, entryIdx, side, stopPrice, targetPrice);
        if (!result) {
          inconclusive++;
          continue;
        }
        const pnlPct = side === "long" ? (result.exitPrice - entryPrice) / entryPrice : (entryPrice - result.exitPrice) / entryPrice;
        buckets[bucketOf(e.zone.confluence_count)].push({ side, entryTime, entryPrice, exitTime: result.exitTime, exitPrice: result.exitPrice, pnlPct, resolvedAs: result.outcome });
      }
    }

    const rResult = {};
    for (const [name, bucketTrades] of Object.entries(buckets)) {
      const gross = computeMetrics(bucketTrades);
      const costed = computeMetrics(applyCosts(bucketTrades, confirmedParams));
      console.log(
        `  ${name.padEnd(14)} n=${gross.trade_count}  win_rate=${(gross.win_rate * 100).toFixed(1)}%  gross_net=${gross.net_return_pct?.toFixed(2)}x  costed_net=${costed.net_return_pct?.toFixed(2)}x  PF=${gross.profit_factor?.toFixed(2)}`,
      );
      rResult[name] = {
        trade_count: gross.trade_count,
        win_rate: gross.win_rate,
        avg_win_pct: gross.avg_win_pct,
        avg_loss_pct: gross.avg_loss_pct,
        gross_net_return_pct: gross.net_return_pct,
        costed_net_return_pct: costed.net_return_pct,
        profit_factor: gross.profit_factor,
      };
    }
    console.log(`  (${inconclusive} inconclusive within ${MAX_HOLD_BARS} bars, ${skippedNoAtr} skipped for missing ATR -- excluded)`);
    allResults[`${rMult}R`] = { buckets: rResult, inconclusive, skippedNoAtr };
  }

  const result = {
    scope: SINGLE_TF || "all_timeframes_combined",
    trade_construction: `entry = next-bar-open after touch start; risk R = ${ATR_MULT}x ATR(14) at zone creation (the zone's own dedup-tolerance constant, not an invented number); stop = entry -/+ R; target = entry +/- R-multiple x R; first of stop/target hit wins, same-bar ambiguity scored conservatively as the stop`,
    r_multiples_tested: R_MULTIPLES,
    max_hold_bars: MAX_HOLD_BARS,
    results: allResults,
    git_commit: gitCommit(),
    generated_at: new Date().toISOString(),
  };
  const RESULTS_DIR = new URL("results/", import.meta.url);
  mkdirSync(RESULTS_DIR, { recursive: true });
  const fname = `confluence_backtest_fixed_rr_${SINGLE_TF || "combined"}_${result.generated_at.replace(/[:.]/g, "-")}.json`;
  writeFileSync(new URL(fname, RESULTS_DIR), JSON.stringify(result, null, 2));
  console.log(`\nSaved: ${new URL(fname, RESULTS_DIR).pathname.replace(/^\/([A-Z]:)/, "$1")}`);
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
