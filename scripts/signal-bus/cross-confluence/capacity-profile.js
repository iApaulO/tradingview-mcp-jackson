#!/usr/bin/env node
// PER-STRATEGY CAPACITY PROFILE -- replacing a borrowed assumption with a measurement.
//
// #182's allocation result rests on a capacity ceiling of ~90 trades/yr, taken from #142 and applied
// to all four strategies. That is the single load-bearing assumption under the only credible equity
// figure this project has, and it was never measured for three of the four.
//
// **THE REGISTER USES "CAPACITY" FOR TWO DIFFERENT THINGS AND THEY MUST BE SEPARATED.**
//   * FREQUENCY -- how many trades a construction generates per year. Exactly measurable.
//   * LIQUIDITY CAPACITY -- how much size can be pushed through without moving the market.
//     Requires L2 depth, which this project does not have (EEH-CITI-1.0 Priority 4).
// #142's "~30/year" is a FREQUENCY figure. Using it as a hard cap in the allocator was treating a
// frequency observation as a liquidity constraint, which is a category error.
//
// WHAT ACTUALLY BINDS CAPITAL is not trades per year at all -- it is CONCURRENCY (how many positions
// are open at once) and NOTIONAL (how large each must be to risk a fixed fraction). The allocator
// already models both. This measures them per strategy so the arbitrary trades/yr cap can be
// replaced by the constraints that are real.
//
// Reported per strategy: realised frequency, concurrency distribution, hold time, and the notional
// required to risk 0.5% of equity -- the last being where A and A2's stop geometry bites, since a
// tight stop demands a large position for the same risk.

import { loadCandles } from "../../backtest/lib/load-candles.js";
import { applyCosts } from "../../backtest/lib/costs.js";
import {
  buildStrategyG, buildStrategyH, buildStrategyAReclaim, buildStrategyA2Reclaim, PORTFOLIO_COST_PARAMS,
} from "./portfolio-backtest.js";

const RISK_PCT = 0.005;
const LADDER = ["1w", "1d", "4h", "3h", "2h", "1h", "15m", "5m"];
const BUILDERS = {
  H_cooccurrence_k3: buildStrategyH,
  A2_engulfment_reclaim: buildStrategyA2Reclaim,
  A_recurrence_reclaim: buildStrategyAReclaim,
  G_wt_anchor_ct_15m: buildStrategyG,
};

const pct = (xs, p) => { const s = [...xs].sort((a, b) => a - b); return s.length ? s[Math.min(s.length - 1, Math.floor(p * s.length))] : NaN; };
const mean = (xs) => (xs.length ? xs.reduce((s, x) => s + x, 0) / xs.length : NaN);

// Concurrency: sample the number of simultaneously-open positions at every entry event.
function concurrency(trades) {
  const evs = [];
  for (const t of trades) { evs.push({ t: t.entryTime, d: +1 }); evs.push({ t: t.exitTime ?? t.entryTime, d: -1 }); }
  evs.sort((a, b) => a.t - b.t || a.d - b.d);   // closes first at equal time
  let cur = 0, peak = 0;
  const samples = [];
  for (const e of evs) { cur += e.d; if (e.d > 0) { samples.push(cur); peak = Math.max(peak, cur); } }
  return { samples, peak };
}

async function main() {
  console.log("PER-STRATEGY CAPACITY PROFILE");
  console.log("#142's '~30/yr' is a FREQUENCY figure, not a liquidity capacity. Separating the two.");
  console.log(`Notional = the position size needed to risk ${(RISK_PCT * 100).toFixed(2)}% of equity, as a multiple of equity.\n`);

  const candlesByTf = {};
  for (const tf of LADDER) candlesByTf[tf] = await loadCandles(tf);

  console.log("strategy                trades   /yr    concurrent(mean/p95/max)   hold h (med/p95)   notional x equity (med/p95/max)");
  for (const [name, fn] of Object.entries(BUILDERS)) {
    const raw = await fn(candlesByTf);
    const tr = applyCosts(raw, PORTFOLIO_COST_PARAMS).filter((t) => Number.isFinite(t.riskPct) && t.riskPct > 0);
    if (!tr.length) { console.log(`${name.padEnd(24)} none`); continue; }
    const span = (Math.max(...tr.map((t) => t.entryTime)) - Math.min(...tr.map((t) => t.entryTime))) / (365.25 * 86400);
    const { samples, peak } = concurrency(tr);
    const holds = tr.map((t) => ((t.exitTime ?? t.entryTime) - t.entryTime) / 3600);
    const notion = tr.map((t) => RISK_PCT / t.riskPct);
    console.log(
      `${name.padEnd(24)}${String(tr.length).padStart(7)}${(tr.length / span).toFixed(0).padStart(7)}` +
      `${(mean(samples).toFixed(1) + "/" + pct(samples, 0.95) + "/" + peak).padStart(23)}` +
      `${(pct(holds, 0.5).toFixed(1) + "/" + pct(holds, 0.95).toFixed(0)).padStart(19)}` +
      `${(pct(notion, 0.5).toFixed(2) + "/" + pct(notion, 0.95).toFixed(1) + "/" + pct(notion, 1).toFixed(0)).padStart(33)}`,
    );
  }
  console.log("\nReading this:");
  console.log("  * trades/yr is FREQUENCY. It bounds how fast forward evidence accrues, not how much capital fits.");
  console.log("  * CONCURRENT x NOTIONAL is what actually consumes the book. A strategy with few trades but");
  console.log("    huge notional demand can be more capital-hungry than a frequent one with modest size.");
  console.log("  * notional > ~3x equity is not executable at retail leverage, so any strategy whose median");
  console.log("    sits there cannot be sized to its intended risk and will silently carry less.");
}

main().catch((e) => { console.error("Fatal:", e); process.exit(1); });
