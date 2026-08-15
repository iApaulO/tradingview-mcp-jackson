#!/usr/bin/env node
// Re-tests #102 with a WIDER, realistic price tolerance, per iapaulo's direct challenge and live
// verification: pulled the actual connected chart (5m/15m/1h) and found D4M lines currently
// spanning $63,222-$63,956 (~1.16% of price, BTC~$63,657) that #102's underlying confluence_count
// (0.2% tolerance, ~$127 band) would mostly fail to count as confluent -- the algorithm's tolerance
// is likely far tighter than what actually reads as "the same zone" across timeframes. Recomputes
// confluence_count IN MEMORY at wider tolerances (does not touch the stored DB values or #4/#4a's
// original 0.2%-based finding) and reruns the same corrected (VIP1 fees, arithmetic-mean expectancy)
// cost/capacity test from #102 at each.
//
// Usage: node scripts/signal-bus/divergence-for-many/confluence-backtest-wide-tolerance.js [--r=2] [--tolerances=0.005,0.01,0.015,0.02]

import { DatabaseSync } from "node:sqlite";
import { loadCandles } from "../../backtest/lib/load-candles.js";
import { computeMetrics } from "../../backtest/lib/metrics.js";
import { applyCosts, FEE_TIERS, REPRESENTATIVE_FUNDING_PCT_PER_HOUR } from "../../backtest/lib/costs.js";
import { computeConfluence } from "./confluence.js";

const DB_PATH = new URL("../../../data/signal-bus/divergence-for-many.db", import.meta.url);
const args = Object.fromEntries(process.argv.slice(2).map((a) => a.replace(/^--/, "").split("=")));
const R_MULTIPLES = (args.r || "2").split(",").map(Number);
const TOLERANCES = (args.tolerances || "0.002,0.005,0.01,0.015,0.02").split(",").map(Number);
const MAX_HOLD_BARS = 200;
const ATR_MULT = 0.6;

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
  const zoneRows = db.prepare("SELECT id, timeframe, side, price, atr_at_creation, confirmed_time, expires_time FROM zones").all();
  const touchRows = db.prepare(
    `SELECT zone_id, start_bar_idx FROM touches WHERE zone_id IN (${zoneRows.map(() => "?").join(",") || "0"})`,
  ).all(...zoneRows.map((z) => z.id));
  db.close();

  const allZones = zoneRows.map((z) => ({
    id: z.id, timeframe: z.timeframe, side: z.side, price: z.price,
    atrAtCreation: z.atr_at_creation, confirmedTime: z.confirmed_time, expiresTime: z.expires_time,
  }));
  const zoneById = new Map(allZones.map((z) => [z.id, z]));
  const touchesByZone = new Map();
  for (const t of touchRows) {
    if (!touchesByZone.has(t.zone_id)) touchesByZone.set(t.zone_id, []);
    touchesByZone.get(t.zone_id).push(t.start_bar_idx);
  }

  const candlesByTf = {};
  for (const tf of new Set(allZones.map((z) => z.timeframe))) candlesByTf[tf] = await loadCandles(tf);

  const confirmedParams = { takerFeePct: FEE_TIERS.bitunix_futures_vip1.takerFeePct, fundingPctPerHour: REPRESENTATIVE_FUNDING_PCT_PER_HOUR };

  for (const tolPct of TOLERANCES) {
    // Fresh copy each time -- computeConfluence mutates in place.
    const zonesCopy = allZones.map((z) => ({ ...z }));
    computeConfluence(zonesCopy, tolPct);
    const zoneByIdFresh = new Map(zonesCopy.map((z) => [z.id, z]));

    console.log(`\n========== tolerance=${(tolPct * 100).toFixed(2)}% of price ==========`);
    const dist = {};
    for (const z of zonesCopy) dist[bucketOf(z.confluenceCount)] = (dist[bucketOf(z.confluenceCount)] || 0) + 1;
    console.log(`  zone distribution: ${JSON.stringify(dist)}`);

    for (const rMult of R_MULTIPLES) {
      const buckets = { "1 (isolated)": [], "2": [], "3": [], "4+ (top)": [] };
      for (const [zoneId, starts] of touchesByZone) {
        const z = zoneByIdFresh.get(zoneId);
        if (!z || z.atrAtCreation == null || z.atrAtCreation <= 0) continue;
        const candles = candlesByTf[z.timeframe];
        for (const startBarIdx of starts) {
          const entryIdx = startBarIdx + 1;
          if (entryIdx >= candles.length) continue;
          const entryPrice = candles[entryIdx].o, entryTime = candles[entryIdx].t;
          const side = z.side === "bullish" ? "long" : "short";
          const risk = ATR_MULT * z.atrAtCreation;
          const stopPrice = side === "long" ? entryPrice - risk : entryPrice + risk;
          const targetPrice = side === "long" ? entryPrice + rMult * risk : entryPrice - rMult * risk;
          const result = simulateFixedR(candles, entryIdx, side, stopPrice, targetPrice);
          if (!result) continue;
          const pnlPct = side === "long" ? (result.exitPrice - entryPrice) / entryPrice : (entryPrice - result.exitPrice) / entryPrice;
          buckets[bucketOf(z.confluenceCount)].push({ side, entryTime, entryPrice, exitTime: result.exitTime, exitPrice: result.exitPrice, pnlPct });
        }
      }
      console.log(`  --- ${rMult}R ---`);
      for (const [name, bucketTrades] of Object.entries(buckets)) {
        if (bucketTrades.length < 30) { console.log(`    ${name.padEnd(14)} n=${bucketTrades.length} (too thin)`); continue; }
        const gross = computeMetrics(bucketTrades);
        const costed = applyCosts(bucketTrades, confirmedParams);
        const grossExp = expectancy(bucketTrades), costedExp = expectancy(costed);
        console.log(`    ${name.padEnd(14)} n=${gross.trade_count} win=${(gross.win_rate * 100).toFixed(1)}% PF=${gross.profit_factor?.toFixed(2)} gross_exp=${(grossExp * 100).toFixed(4)}%/trade costed_exp=${(costedExp * 100).toFixed(4)}%/trade ${costedExp > 0 ? "(CLEARS COSTS)" : ""}`);
      }
    }
  }
}

main().catch((err) => { console.error("Fatal:", err); process.exit(1); });
