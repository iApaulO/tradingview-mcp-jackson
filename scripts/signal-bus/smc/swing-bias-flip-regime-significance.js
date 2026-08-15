#!/usr/bin/env node
// Different angle per iapaulo's direct request, after 5 confluence-definition attempts on OB-vs-
// swing-line (#86-#90): what's the impact of simply "playing the bullish till a bear appears and
// playing a bear till a bull appears"? No order block, no D4M, no discretionary trigger -- pure
// regime-following on the SWING structure's own bias flips. A flip = a swing-scope CHOCH event
// (verified in calc.js: CHOCH is tagged specifically when the break's side differs from the prior
// bias, BOS reconfirms the same bias -- CHOCH is the correct, and only, flip signal).
//
// Construction: enter in the NEW bias direction at next-bar-open after each swing CHOCH; hold
// continuously (no stop, no target -- this directly answers "what's the impact of just staying in
// until reversed") until the NEXT swing CHOCH flips it, exit at that next-bar-open. One "trade" per
// regime segment. Real costs (entry+exit round-trip + funding for the full holding duration,
// bitunix_futures_vip1, confirmed real tier) applied same as every other test in this register.
//
// Usage: node scripts/signal-bus/smc/swing-bias-flip-regime-significance.js [--tf=5m,15m,1h,...]

import { DatabaseSync } from "node:sqlite";
import { writeFileSync, mkdirSync } from "fs";
import { execSync } from "child_process";
import { loadCandles } from "../../backtest/lib/load-candles.js";
import { computeMetrics } from "../../backtest/lib/metrics.js";
import { applyCosts, FEE_TIERS, REPRESENTATIVE_FUNDING_PCT_PER_HOUR } from "../../backtest/lib/costs.js";
import { computeSwingPivotSeries } from "./calc.js";

const SMC_DB_PATH = new URL("../../../data/signal-bus/smc.db", import.meta.url);
const LADDER_KEYS = ["1w", "1d", "4h", "3h", "2h", "1h", "15m", "5m"];
const args = Object.fromEntries(process.argv.slice(2).map((a) => a.replace(/^--/, "").split("=")));
const TFS = args.tf ? args.tf.split(",") : LADDER_KEYS;
// Stop-loss overlay per iapaulo's request to "flesh this out till truly validated or disproven":
// #91 had unbounded per-trade risk (pure hold-until-reversed). --stop-mode=atr uses the house's
// standard 0.6xATR(14)-at-entry convention (found in #92 to be badly miscalibrated for a multi-day
// hold). --stop-mode=swing uses iapaulo's own correction: stop at the previous swing LOW for a
// long, previous swing HIGH for a short -- a structurally-motivated stop (below/above the level
// that, if broken, invalidates the very swing bias the trade is riding), not an arbitrary volatility
// band. Still no fixed target either way -- winners run to the next flip.
const STOP_MODE = args["stop-mode"] || (args["use-stop"] === "true" || args["use-stop"] === "1" ? "atr" : "none");
const USE_STOP = STOP_MODE !== "none";
const ATR_LEN = 14, ATR_MULT = 0.6;
function atr(candles, length) {
  const tr = candles.map((c, i) => {
    if (i === 0) return c.h - c.l;
    const pc = candles[i - 1].c;
    return Math.max(c.h - c.l, Math.abs(c.h - pc), Math.abs(c.l - pc));
  });
  const out = new Array(candles.length).fill(NaN);
  if (candles.length < length) return out;
  let seed = 0;
  for (let i = 0; i < length; i++) seed += tr[i];
  out[length - 1] = seed / length;
  for (let i = length; i < candles.length; i++) out[i] = (out[i - 1] * (length - 1) + tr[i]) / length;
  return out;
}

function gitCommit() {
  try { return execSync("git rev-parse HEAD", { cwd: new URL("../../../", import.meta.url), encoding: "utf8" }).trim(); }
  catch { return "unknown"; }
}
function expectancy(trades) { return trades.length ? trades.reduce((s, t) => s + t.pnlPct, 0) / trades.length : null; }

async function main() {
  const db = new DatabaseSync(SMC_DB_PATH, { readOnly: true });
  const confirmedParams = { takerFeePct: FEE_TIERS.bitunix_futures_vip1.takerFeePct, fundingPctPerHour: REPRESENTATIVE_FUNDING_PCT_PER_HOUR };
  const allResults = {};

  for (const tf of TFS) {
    const flips = db.prepare("SELECT side, bar_idx, time FROM structure_events WHERE scope = 'swing' AND type = 'CHOCH' AND timeframe = ? ORDER BY bar_idx ASC").all(tf);
    const candles = await loadCandles(tf);
    const atr14 = STOP_MODE === "atr" ? atr(candles, ATR_LEN) : null;
    const pivots = STOP_MODE === "swing" ? computeSwingPivotSeries(candles) : null;

    const trades = [];
    let stoppedCount = 0;
    for (let i = 0; i < flips.length - 1; i++) {
      const entryIdx = flips[i].bar_idx + 1;
      const naturalExitIdx = flips[i + 1].bar_idx + 1;
      if (entryIdx >= candles.length || naturalExitIdx >= candles.length || naturalExitIdx <= entryIdx) continue;
      const entryPrice = candles[entryIdx].o, entryTime = candles[entryIdx].t;
      const side = flips[i].side === "bullish" ? "long" : "short";

      let exitIdx = naturalExitIdx, exitPrice = candles[naturalExitIdx].o, exitTime = candles[naturalExitIdx].t, stopped = false;
      if (STOP_MODE === "atr") {
        const riskAtEntry = ATR_MULT * atr14[flips[i].bar_idx];
        if (Number.isFinite(riskAtEntry) && riskAtEntry > 0) {
          const stopPrice = side === "long" ? entryPrice - riskAtEntry : entryPrice + riskAtEntry;
          for (let j = entryIdx; j < naturalExitIdx; j++) {
            const bar = candles[j];
            const hitStop = side === "long" ? bar.l <= stopPrice : bar.h >= stopPrice;
            if (hitStop) { exitIdx = j; exitPrice = stopPrice; exitTime = bar.t; stopped = true; break; }
          }
        }
      } else if (STOP_MODE === "swing") {
        // Previous swing LOW for a long, previous swing HIGH for a short -- the level that, if
        // broken, invalidates the swing bias this trade is riding. Read at the flip's own bar
        // (the pivot still standing at entry, not the one just broken to trigger this flip).
        const stopPrice = side === "long" ? pivots.swingLowLevel[flips[i].bar_idx] : pivots.swingHighLevel[flips[i].bar_idx];
        if (Number.isFinite(stopPrice) && (side === "long" ? stopPrice < entryPrice : stopPrice > entryPrice)) {
          for (let j = entryIdx; j < naturalExitIdx; j++) {
            const bar = candles[j];
            const hitStop = side === "long" ? bar.l <= stopPrice : bar.h >= stopPrice;
            if (hitStop) { exitIdx = j; exitPrice = stopPrice; exitTime = bar.t; stopped = true; break; }
          }
        }
      }
      if (stopped) stoppedCount++;
      const pnlPct = side === "long" ? (exitPrice - entryPrice) / entryPrice : (entryPrice - exitPrice) / entryPrice;
      trades.push({ side, entryTime, entryPrice, exitTime, exitPrice, pnlPct, holdBars: exitIdx - entryIdx, stopped });
    }

    if (trades.length < 10) { console.log(`${tf}: only ${trades.length} regime segments, too thin to report`); continue; }
    const gross = computeMetrics(trades);
    const costed = applyCosts(trades, confirmedParams);
    const grossExp = expectancy(trades), costedExp = expectancy(costed);
    const avgHoldBars = trades.reduce((s, t) => s + t.holdBars, 0) / trades.length;
    const spanYears = (trades[trades.length - 1].exitTime - trades[0].entryTime) / (365.25 * 86400);
    console.log(
      `${tf.padEnd(4)} n=${String(trades.length).padEnd(5)} (${(trades.length / spanYears).toFixed(1)}/yr) win=${(gross.win_rate * 100).toFixed(1)}% PF=${gross.profit_factor?.toFixed(2)} ` +
      `avg_hold=${avgHoldBars.toFixed(0)}bars stopped=${stoppedCount}/${trades.length} gross_exp=${(grossExp * 100).toFixed(3)}%/trade costed_exp=${(costedExp * 100).toFixed(3)}%/trade ${costedExp > 0 ? "(CLEARS COSTS)" : ""}`,
    );
    allResults[tf] = {
      trade_count: trades.length, trades_per_year: trades.length / spanYears, win_rate: gross.win_rate,
      profit_factor: gross.profit_factor, avg_hold_bars: avgHoldBars,
      gross_expectancy_pct_per_trade: grossExp, costed_expectancy_pct_per_trade: costedExp,
    };
  }
  db.close();

  const RESULTS_DIR = new URL("results/", import.meta.url);
  mkdirSync(RESULTS_DIR, { recursive: true });
  const payload = { results: allResults, git_commit: gitCommit(), generated_at: new Date().toISOString() };
  const fname = `swing_bias_flip_regime_significance_${payload.generated_at.replace(/[:.]/g, "-")}.json`;
  writeFileSync(new URL(fname, RESULTS_DIR), JSON.stringify(payload, null, 2));
  console.log(`\nSaved: ${new URL(fname, RESULTS_DIR).pathname.replace(/^\/([A-Z]:)/, "$1")}`);
}

main().catch((err) => { console.error("Fatal:", err); process.exit(1); });
