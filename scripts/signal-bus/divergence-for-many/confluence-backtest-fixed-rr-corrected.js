#!/usr/bin/env node
// Corrected re-test of #4/#4a (D4M confluence_count -- number of DISTINCT TIMEFRAMES a zone prints
// on simultaneously, verified directly against confluence.js) per iapaulo's direct request to
// investigate "the impact of a D4M line printing on 3 or more timeframes." #4a's original
// trade-construction-blocked verdict (2026-07-27) has two real problems, fixed here:
//   1. Hardcoded FEE_TIERS.confirmed_derivatives (stale Coinbase tier, 0.14% round-trip) --
//      #75 confirmed the real venue is Bitunix VIP1 (0.10% round-trip), cheaper.
//   2. Used computeMetrics's net_return_pct, a COMPOUNDING metric -- metrics.js's own header
//      explicitly warns this "breaks down hard when trades genuinely overlap in time (e.g.
//      entries drawn from multiple timeframes at once)" and to "prefer a non-compounding
//      arithmetic-mean per-trade expectancy" for exactly this case (pooled across 8 timeframes,
//      the same bug class #82 was built to fix for the portfolio work this session). This uses
//      the arithmetic-mean costed_exp convention standardized on since, not net_return_pct.
// Same trade construction as the original otherwise (0.6xATR(14)-at-zone-creation fixed-R,
// unchanged -- not the part in question here).
//
// Usage: node scripts/signal-bus/divergence-for-many/confluence-backtest-fixed-rr-corrected.js [--r=1,1.5,2,3] [--fee-tier=bitunix_futures_vip1]

import { DatabaseSync } from "node:sqlite";
import { writeFileSync, mkdirSync } from "fs";
import { execSync } from "child_process";
import { loadCandles } from "../../backtest/lib/load-candles.js";
import { computeMetrics } from "../../backtest/lib/metrics.js";
import { applyCosts, FEE_TIERS, REPRESENTATIVE_FUNDING_PCT_PER_HOUR } from "../../backtest/lib/costs.js";

const DB_PATH = new URL("../../../data/signal-bus/divergence-for-many.db", import.meta.url);
const args = Object.fromEntries(process.argv.slice(2).map((a) => a.replace(/^--/, "").split("=")));
const R_MULTIPLES = (args.r || "1,1.5,2,3").split(",").map(Number);
const FEE_TIER = args["fee-tier"] || "bitunix_futures_vip1";
const MAX_HOLD_BARS = 200;
const ATR_MULT = 0.6;

function gitCommit() {
  try { return execSync("git rev-parse HEAD", { cwd: new URL("../../../", import.meta.url), encoding: "utf8" }).trim(); }
  catch { return "unknown"; }
}
function bucketOf(cc) { return cc >= 4 ? "4+ (top)" : cc === 3 ? "3" : cc === 2 ? "2" : "1 (isolated)"; }
function simulateFixedR(candles, entryIdx, side, stopPrice, targetPrice) {
  const endCheck = Math.min(candles.length - 1, entryIdx + MAX_HOLD_BARS);
  for (let j = entryIdx; j <= endCheck; j++) {
    const bar = candles[j];
    const hitStop = side === "long" ? bar.l <= stopPrice : bar.h >= stopPrice;
    const hitTarget = side === "long" ? bar.h >= targetPrice : bar.l <= targetPrice;
    if (hitStop) return { exitPrice: stopPrice, exitTime: bar.t };
    if (hitTarget) return { exitPrice: targetPrice, exitTime: bar.t };
  }
  return null;
}
function expectancy(trades) { return trades.length ? trades.reduce((s, t) => s + t.pnlPct, 0) / trades.length : null; }

async function main() {
  const db = new DatabaseSync(DB_PATH, { readOnly: true });
  const zoneRows = db.prepare("SELECT id, timeframe, side, price, atr_at_creation, confluence_count FROM zones").all();
  const touchRows = db.prepare(
    `SELECT zone_id, start_bar_idx FROM touches WHERE zone_id IN (${zoneRows.map(() => "?").join(",") || "0"})`,
  ).all(...zoneRows.map((z) => z.id));
  db.close();

  const zoneById = new Map(zoneRows.map((z) => [z.id, z]));
  const entriesByTf = new Map();
  for (const t of touchRows) {
    const z = zoneById.get(t.zone_id);
    if (!entriesByTf.has(z.timeframe)) entriesByTf.set(z.timeframe, []);
    entriesByTf.get(z.timeframe).push({ startBarIdx: t.start_bar_idx, zone: z });
  }

  const confirmedParams = { takerFeePct: FEE_TIERS[FEE_TIER].takerFeePct, fundingPctPerHour: REPRESENTATIVE_FUNDING_PCT_PER_HOUR };
  console.log(`Fee tier: ${FEE_TIER} (round-trip=${(FEE_TIERS[FEE_TIER].takerFeePct * 200).toFixed(3)}%)`);

  for (const rMult of R_MULTIPLES) {
    console.log(`\n=== ${rMult}R ===`);
    const buckets = { "1 (isolated)": [], "2": [], "3": [], "4+ (top)": [] };
    for (const [tf, entries] of entriesByTf) {
      const candles = await loadCandles(tf);
      for (const e of entries) {
        const entryIdx = e.startBarIdx + 1;
        if (entryIdx >= candles.length) continue;
        if (e.zone.atr_at_creation == null || e.zone.atr_at_creation <= 0) continue;
        const entryPrice = candles[entryIdx].o, entryTime = candles[entryIdx].t;
        const side = e.zone.side === "bullish" ? "long" : "short";
        const risk = ATR_MULT * e.zone.atr_at_creation;
        const stopPrice = side === "long" ? entryPrice - risk : entryPrice + risk;
        const targetPrice = side === "long" ? entryPrice + rMult * risk : entryPrice - rMult * risk;
        const result = simulateFixedR(candles, entryIdx, side, stopPrice, targetPrice);
        if (!result) continue;
        const pnlPct = side === "long" ? (result.exitPrice - entryPrice) / entryPrice : (entryPrice - result.exitPrice) / entryPrice;
        buckets[bucketOf(e.zone.confluence_count)].push({ side, entryTime, entryPrice, exitTime: result.exitTime, exitPrice: result.exitPrice, pnlPct });
      }
    }
    for (const [name, bucketTrades] of Object.entries(buckets)) {
      if (bucketTrades.length < 30) { console.log(`  ${name.padEnd(14)} n=${bucketTrades.length} (too thin)`); continue; }
      const gross = computeMetrics(bucketTrades);
      const costed = applyCosts(bucketTrades, confirmedParams);
      const grossExp = expectancy(bucketTrades), costedExp = expectancy(costed);
      console.log(`  ${name.padEnd(14)} n=${gross.trade_count} win=${(gross.win_rate * 100).toFixed(1)}% PF=${gross.profit_factor?.toFixed(2)} gross_exp=${(grossExp * 100).toFixed(4)}%/trade costed_exp=${(costedExp * 100).toFixed(4)}%/trade ${costedExp > 0 ? "(CLEARS COSTS)" : ""}`);
    }
  }

  const RESULTS_DIR = new URL("results/", import.meta.url);
  mkdirSync(RESULTS_DIR, { recursive: true });
}

main().catch((err) => { console.error("Fatal:", err); process.exit(1); });
