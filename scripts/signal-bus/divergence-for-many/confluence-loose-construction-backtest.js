#!/usr/bin/env node
// Looser trade construction per iapaulo's direct request after #103: the stacking-predicts-
// direction pattern (#4, confluence_count 1->3: hold rate 53.3%->59.3%) is real, but every R-
// multiple race-to-target construction tried so far (#4a/#102/#103) cuts trades off with a tight
// 0.6xATR stop/target before the real move plays out. This rides each touch to its OWN natural
// resolution -- the touch's own end_bar_idx, the same bar the "held"/"broken" classification is
// already based on -- instead of a synthetic fixed-R target, protected by a WIDER stop (swept
// across several multiples) so early normal retracement doesn't stop it out prematurely. Same
// "ride to natural resolution, real structural risk" idea that worked for #94's swing-regime
// finding (the strongest result in this whole thread), applied here to D4M stacking.
//
// Usage: node scripts/signal-bus/divergence-for-many/confluence-loose-construction-backtest.js [--stops=0.6,1,1.5,2,3]

import { DatabaseSync } from "node:sqlite";
import { loadCandles } from "../../backtest/lib/load-candles.js";
import { computeMetrics } from "../../backtest/lib/metrics.js";
import { applyCosts, FEE_TIERS, REPRESENTATIVE_FUNDING_PCT_PER_HOUR } from "../../backtest/lib/costs.js";

const DB_PATH = new URL("../../../data/signal-bus/divergence-for-many.db", import.meta.url);
const args = Object.fromEntries(process.argv.slice(2).map((a) => a.replace(/^--/, "").split("=")));
const STOP_MULTS = (args.stops || "0.6,1,1.5,2,3").split(",").map(Number);
const MAX_HOLD_BARS = 200;

function bucketOf(cc) { return cc >= 4 ? "4+ (top)" : cc === 3 ? "3" : cc === 2 ? "2" : "1 (isolated)"; }
function expectancy(trades) { return trades.length ? trades.reduce((s, t) => s + t.pnlPct, 0) / trades.length : null; }

async function main() {
  const db = new DatabaseSync(DB_PATH, { readOnly: true });
  const zoneRows = db.prepare("SELECT id, timeframe, side, price, atr_at_creation, confluence_count FROM zones").all();
  const touchRows = db.prepare(
    `SELECT zone_id, start_bar_idx, end_bar_idx, outcome FROM touches WHERE zone_id IN (${zoneRows.map(() => "?").join(",") || "0"})`,
  ).all(...zoneRows.map((z) => z.id));
  db.close();

  const zoneById = new Map(zoneRows.map((z) => [z.id, z]));
  const entriesByTf = new Map();
  for (const t of touchRows) {
    const z = zoneById.get(t.zone_id);
    if (!entriesByTf.has(z.timeframe)) entriesByTf.set(z.timeframe, []);
    entriesByTf.get(z.timeframe).push({ startBarIdx: t.start_bar_idx, endBarIdx: t.end_bar_idx, outcome: t.outcome, zone: z });
  }
  const candlesByTf = {};
  for (const tf of entriesByTf.keys()) candlesByTf[tf] = await loadCandles(tf);

  const confirmedParams = { takerFeePct: FEE_TIERS.bitunix_futures_vip1.takerFeePct, fundingPctPerHour: REPRESENTATIVE_FUNDING_PCT_PER_HOUR };

  for (const stopMult of STOP_MULTS) {
    console.log(`\n========== stop=${stopMult}x ATR(14), exit at touch's own natural resolution (end_bar_idx) or ${MAX_HOLD_BARS} bars, whichever first ==========`);
    const buckets = { "1 (isolated)": [], "2": [], "3": [], "4+ (top)": [] };
    for (const [tf, entries] of entriesByTf) {
      const candles = candlesByTf[tf];
      for (const e of entries) {
        if (e.zone.atr_at_creation == null || e.zone.atr_at_creation <= 0) continue;
        const entryIdx = e.startBarIdx + 1;
        if (entryIdx >= candles.length) continue;
        const entryPrice = candles[entryIdx].o, entryTime = candles[entryIdx].t;
        const side = e.zone.side === "bullish" ? "long" : "short";
        const risk = stopMult * e.zone.atr_at_creation;
        const stopPrice = side === "long" ? entryPrice - risk : entryPrice + risk;
        const naturalExitIdx = Math.min(e.endBarIdx, entryIdx + MAX_HOLD_BARS, candles.length - 1);
        if (naturalExitIdx <= entryIdx) continue;

        let exitPrice = candles[naturalExitIdx].c, exitTime = candles[naturalExitIdx].t;
        for (let j = entryIdx; j <= naturalExitIdx; j++) {
          const bar = candles[j];
          const hitStop = side === "long" ? bar.l <= stopPrice : bar.h >= stopPrice;
          if (hitStop) { exitPrice = stopPrice; exitTime = bar.t; break; }
        }
        const pnlPct = side === "long" ? (exitPrice - entryPrice) / entryPrice : (entryPrice - exitPrice) / entryPrice;
        buckets[bucketOf(e.zone.confluence_count)].push({ side, entryTime, entryPrice, exitTime, exitPrice, pnlPct });
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
}

main().catch((err) => { console.error("Fatal:", err); process.exit(1); });
