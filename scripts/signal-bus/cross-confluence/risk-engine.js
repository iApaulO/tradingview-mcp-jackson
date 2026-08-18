#!/usr/bin/env node
// ALLOCATION AND RISK ENGINE -- EEH-CITI-1.0 section 36, unimplemented until now.
//
// WHY THIS IS THE HIGHEST-LEVERAGE THING AVAILABLE, on this project's own evidence. #145 ran the
// same strategies over the same data under three budgeting policies and got $559.97, $1,165.10 and
// $1,631.54 from a $500 bank -- a 3x spread produced ENTIRELY by how budget was apportioned, with
// max drawdown moving only 6.1-7.9%. Per-strategy contribution swung 20x on policy alone (G: +4.8pts
// prioritized, +102.2pts floored). **That means allocation policy dominates strategy selection, and
// every per-strategy contribution figure in this register is an artefact of an arbitrary budgeting
// choice rather than a measure of intrinsic worth.**
//
// WHAT #145 DIAGNOSED BUT DID NOT ANSWER. It found 27,087 of 27,177 signals skipped (99.7%) for lack
// of budget and up to 87 concurrent positions -- but it never broke down WHY a signal was skipped,
// never bounded concurrency, and never computed the book's NET DIRECTIONAL EXPOSURE. #167 then
// showed the ingredients are not symmetric: A and A2 lean long significantly (+0.0894pp p=0.0282,
// +0.0723pp p=0.0027) and carry 64,763 trades between them, G's population is 3:1 long, and only
// K>=3 leans short. **So the realised book is more long-tilted than any per-strategy figure suggests,
// and nobody has ever computed by how much.** This file computes it.
//
// THE DESIGN COMMITMENT THAT KEEPS THIS HONEST: policies are NAMED and DECLARED, and they are
// COMPARED rather than tuned. #145's spread is the warning -- with a free hand over sizing, cap and
// priority one can produce almost any equity curve from the same signals, which is curve-fitting
// wearing a risk-management costume. The policies below are fixed in this file; a new policy is a
// new named entry, not an adjusted constant.
//
// Every signal that is REFUSED is recorded with a REASON. That breakdown is the actual product of
// this engine: knowing the book is budget-bound is useless without knowing which constraint bound it.
//
// COMPOUNDED is the headline: profit from a closed trade returns to the bank and is available to
// the next one. Nothing more elaborate than that. A flat-sizing figure is printed beside it for
// reference only.
//
// WHEN THE COMPOUNDED NUMBER IS ABSURD, THAT IS A RESULT, NOT A DISPLAY PROBLEM. An earlier version
// of this file invented an "additive" headline to make an implausible output look reasonable, which
// is dressing up a bad input as a reporting choice. The correct reading is the reductio: a nine-year
// backtest returning 1e14x is telling you an INPUT is wrong. Here the input was trade count -- the
// unconstrained engine took 771 trades/yr against the ~90/yr #142 measured as realistic capacity,
// and 9x the tradeable capacity makes every downstream figure meaningless however correct the
// arithmetic. The capacity-limited policy is the only one whose compounded figure can be read.
//
// Usage:
//   node scripts/signal-bus/cross-confluence/risk-engine.js
//   node scripts/signal-bus/cross-confluence/risk-engine.js --strategies=H_cooccurrence_k3,A2_engulfment_only

import { loadCandles } from "../../backtest/lib/load-candles.js";
import { applyCosts } from "../../backtest/lib/costs.js";
import {
  buildStrategyG, buildStrategyH, buildStrategyAReclaim, buildStrategyA2Reclaim, PORTFOLIO_COST_PARAMS,
} from "./portfolio-backtest.js";

const args = Object.fromEntries(process.argv.slice(2).filter((a) => a.includes("=")).map((a) => a.replace(/^--/, "").split("=")));
const STARTING_BANK = 500;

// The RECLAIM construction, not the blind one. #174 showed the blind entry's stop degenerates to
// riskPct = 1e-7 with realised R of -9,881; the population mean R across all four blind strategies
// is -0.5056, i.e. the thing the old engine was allocating over LOSES MONEY per unit risk and only
// looked positive because the leverage cap happened to bound the degenerate trades. #180's
// pre-registered entry removes that defect at source (degeneracy 1.03% -> 0.01%), and it is what
// paper trades, so it is what the allocation policy has to be chosen against.
const BUILDERS = {
  H_cooccurrence_k3: buildStrategyH,
  A2_engulfment_reclaim: buildStrategyA2Reclaim,
  A_recurrence_reclaim: buildStrategyAReclaim,
  G_wt_anchor_ct_15m: buildStrategyG,
};
const WANTED = (args.strategies || Object.keys(BUILDERS).join(",")).split(",").map((s) => s.trim());

// CAPACITY. #142 measured roughly 30 trades/yr/instrument as the realistic ceiling before market
// impact stops being ignorable. The uncapped engine took 771/yr -- 9x over -- and a compounded
// figure built on 9x the tradeable capacity is meaningless regardless of how correct the
// arithmetic is. This is a real constraint the engine was missing, not a display problem.
const CAPACITY_TRADES_PER_YEAR = 90;   // ~30/yr x 3 instruments (#142)

// ---- DECLARED POLICIES. Named, fixed, compared -- never tuned. ----
const POLICIES = {
  // #145's flat mode, reproduced as the reference point. No concurrency or exposure control at all.
  flat_uncapped: {
    label: "flat, uncapped (#145 reference)",
    riskPctPerTrade: 0.005, maxRiskDeployed: 0.02,
    maxConcurrent: Infinity, maxPerStrategy: Infinity, maxNetExposureR: Infinity, maxLeverage: 3, maxGrossNotional: Infinity, capacityPerYear: Infinity,
  },
  // Adds the two controls #145 never had: a hard concurrency ceiling and a net-directional cap.
  capped_balanced: {
    label: "capped concurrency + net-exposure cap",
    riskPctPerTrade: 0.005, maxRiskDeployed: 0.02,
    maxConcurrent: 10, maxPerStrategy: 4, maxNetExposureR: 4, maxLeverage: 3, maxGrossNotional: 1.0, capacityPerYear: Infinity,
  },
  // Reserves room for low-frequency strategies so the fast ones cannot monopolise the budget --
  // the specific failure #145 identified, where H (31/yr) never traded at all under flat.
  capped_reserved: {
    label: "capped + per-strategy reservation",
    riskPctPerTrade: 0.005, maxRiskDeployed: 0.02,
    maxConcurrent: 10, maxPerStrategy: 3, maxNetExposureR: 4, maxLeverage: 3, maxGrossNotional: 1.0, capacityPerYear: Infinity,
  },
  // The only policy that respects the measured capacity ceiling. Everything above it is arithmetic
  // about a book that could not have been traded.
  capacity_respecting: {
    label: "capped + CAPACITY-limited (#142's ~90 trades/yr)",
    riskPctPerTrade: 0.005, maxRiskDeployed: 0.02,
    maxConcurrent: 10, maxPerStrategy: 3, maxNetExposureR: 4, maxLeverage: 3, maxGrossNotional: 1.0,
    capacityPerYear: CAPACITY_TRADES_PER_YEAR,
  },
};

const mean = (xs) => (xs.length ? xs.reduce((s, x) => s + x, 0) / xs.length : 0);

// Walk entries in chronological order, sweeping completed positions before each decision.
//
// BUG FIX 2026-08-17: the first implementation built an interleaved open/close event list sorted
// with closes first at equal timestamps, so capital would free before being re-allocated. That is
// right ACROSS trades and catastrophically wrong WITHIN one: a trade exiting on the bar it enters
// -- routine on 5m -- had its close processed BEFORE its open, the close found nothing to close,
// and the position then stayed open forever consuming budget. The symptom was unmistakable once
// looked at: 15 trades taken out of 65,722 with 100% budget refusal, against #145's 90. Sweeping
// from a sorted pending-close list removes the ordering trap entirely, and a same-bar trade is
// closed immediately after opening rather than relying on sort order to be interpreted correctly.
// Chronological walk with a pending-close sweep. Rewritten 2026-08-17 to fix the defect #174
// recorded as outstanding.
//
// WHAT WAS WRONG. The budget test compared the INTENDED risk fraction against the ceiling while
// deployment accrued the EFFECTIVE (leverage-capped) risk. For A and A2 the effective risk is often
// a tiny fraction of the intended one -- their stop is the order block's own edge, so a thin block
// caps the position on leverage and the risk actually carried collapses -- and the two quantities
// then drift apart until the 2% ceiling stops binding entirely. Symptom: 25,487 trades taken with
// peak concurrency of 8 at up to 3x leverage each, and equity compounding to a nonsensical figure.
//
// WHAT A CORRECT ENGINE NEEDS, and the previous one had neither properly:
//   * a RISK budget -- the sum of effective risk carried must respect the ceiling, so the test and
//     the accrual must use the SAME quantity;
//   * a GROSS NOTIONAL cap -- risk alone does not bound exposure. A position sized to risk 0.5%
//     against a 0.05% stop is 10x equity; ten such positions are 100x gross even though the risk
//     budget reads 5%. Risk and notional are different constraints and both must be enforced.
//
// ORDER OF OPERATIONS IS LOAD-BEARING: size FIRST, then test the budget against what that size
// actually costs. Testing before sizing is precisely the bug being fixed.
function simulate(trades, pol) {
  let equity = 1, peak = 1, maxDD = 0;
  // Compounding is exactly what it sounds like: profit from a closed trade returns to the bank and
  // is available to the next one. equity *= 1 + pnl, nothing more. An earlier version of this file
  // wrapped that in an "additive" alternative to make an absurd output look reasonable -- that was
  // dressing up a bad input as a reporting choice, and it is removed.
  let additive = 0, addPeak = 0, addRun = 0, addMaxDD = 0;
  let deployedRisk = 0, grossNotional = 0, netR = 0, taken = 0, maxConcurrentSeen = 0;
  const perStrat = new Map();
  const refused = { budget: 0, gross_notional: 0, concurrency: 0, per_strategy: 0, net_exposure: 0, capacity: 0 };
  const takenBy = new Map();
  const netSamples = [];
  let openCount = 0, sizeCapped = 0;

  const pending = [];
  const insertPending = (p) => {
    let lo = 0, hi = pending.length;
    while (lo < hi) { const m = (lo + hi) >> 1; if (pending[m].exitT <= p.exitT) lo = m + 1; else hi = m; }
    pending.splice(lo, 0, p);
  };
  const closePos = (p) => {
    deployedRisk -= p.effRisk;
    grossNotional -= p.notional;
    netR -= p.side === "long" ? p.effRisk : -p.effRisk;
    perStrat.set(p.strategy, (perStrat.get(p.strategy) || 1) - 1);
    openCount--;
    equity *= 1 + p.pnl;
    if (equity > peak) peak = equity;
    maxDD = Math.max(maxDD, (peak - equity) / peak);
    additive += p.pnl;
    addRun += p.pnl;
    if (addRun > addPeak) addPeak = addRun;
    addMaxDD = Math.max(addMaxDD, addPeak - addRun);

  };
  const sweep = (upTo) => { while (pending.length && pending[0].exitT <= upTo) closePos(pending.shift()); };

  const t0 = trades.length ? trades[0].entryTime : 0;
  for (const tr of trades) {
    sweep(tr.entryTime);

    // capacity: refuse anything beyond the measured tradeable rate for the elapsed span
    if (pol.capacityPerYear !== Infinity) {
      const yearsElapsed = Math.max(1 / 365, (tr.entryTime - t0) / (365.25 * 86400));
      if (taken >= pol.capacityPerYear * yearsElapsed) { refused.capacity++; continue; }
    }

    // ---- SIZE FIRST ----
    const desiredNotional = pol.riskPctPerTrade / tr.riskPct;
    const notional = Math.min(desiredNotional, pol.maxLeverage);
    const effRisk = notional * tr.riskPct;          // what this position actually risks

    // ---- THEN TEST, against the quantities actually incurred ----
    if (deployedRisk + effRisk > pol.maxRiskDeployed + 1e-12) { refused.budget++; continue; }
    if (grossNotional + notional > pol.maxGrossNotional + 1e-12) { refused.gross_notional++; continue; }
    if (openCount >= pol.maxConcurrent) { refused.concurrency++; continue; }
    const nStrat = perStrat.get(tr.strategy) || 0;
    if (nStrat >= pol.maxPerStrategy) { refused.per_strategy++; continue; }
    const signed = tr.side === "long" ? effRisk : -effRisk;
    if (Math.abs((netR + signed) / pol.riskPctPerTrade) > pol.maxNetExposureR + 1e-9) { refused.net_exposure++; continue; }

    if (notional < desiredNotional) sizeCapped++;
    deployedRisk += effRisk;
    grossNotional += notional;
    netR += signed;
    perStrat.set(tr.strategy, nStrat + 1);
    takenBy.set(tr.strategy, (takenBy.get(tr.strategy) || 0) + 1);
    taken++; openCount++;
    maxConcurrentSeen = Math.max(maxConcurrentSeen, openCount);
    netSamples.push(netR / pol.riskPctPerTrade);

    const exitT = tr.exitTime ?? tr.entryTime;
    const pnl = notional * (tr.costedPnlPct ?? tr.pnlPct);
    const pos = { exitT, effRisk, notional, side: tr.side, strategy: tr.strategy, pnl };
    if (exitT <= tr.entryTime) closePos(pos); else insertPending(pos);
  }
  sweep(Infinity);
  return { equity, maxDD, additive, addMaxDD, taken, refused, takenBy, maxConcurrentSeen, netSamples, sizeCapped };
}

async function main() {
  console.log("=".repeat(84));
  console.log("  ALLOCATION AND RISK ENGINE -- EEH-CITI-1.0 s36");
  console.log("=".repeat(84));
  console.log("  Policies are NAMED, DECLARED and COMPARED -- never tuned. #145 showed the same signals");
  console.log("  yield a 3x equity spread on budgeting alone, so a free hand here is curve-fitting.");
  console.log(`  Bank $${STARTING_BANK}. Risk 0.50%/trade, 2.00% max deployed, identical across policies.\n`);

  const LADDER = ["1w", "1d", "4h", "3h", "2h", "1h", "15m", "5m"];
  const candlesByTf = {};
  for (const tf of LADDER) candlesByTf[tf] = await loadCandles(tf);

  let all = [];
  for (const name of WANTED) {
    const raw = await BUILDERS[name](candlesByTf);
    all = all.concat(applyCosts(raw, PORTFOLIO_COST_PARAMS));
  }
  all = all.filter((t) => Number.isFinite(t.riskPct) && t.riskPct > 0).sort((a, b) => a.entryTime - b.entryTime);
  const spanYears = (all[all.length - 1].entryTime - all[0].entryTime) / (365.25 * 86400);
  console.log(`  population: ${all.length.toLocaleString()} signals across ${WANTED.length} strategies, ${spanYears.toFixed(2)} years\n`);

  for (const [key, pol] of Object.entries(POLICIES)) {
    const r = simulate(all, pol);
    const addUsd = STARTING_BANK * (1 + r.additive);
    const addCagr = (Math.pow(1 + r.additive, 1 / spanYears) - 1) * 100;
    const totalRefused = Object.values(r.refused).reduce((a, b) => a + b, 0);
    console.log(`  ${pol.label}`);
    const compUsd = STARTING_BANK * r.equity;
    const compCagr = (Math.pow(r.equity, 1 / spanYears) - 1) * 100;
    const compStr = r.equity > 1e6 ? `${r.equity.toExponential(2)}x  [NOT CREDIBLE -- see capacity]` : `$${compUsd.toFixed(2)}  CAGR ${compCagr.toFixed(1)}%  maxDD ${(r.maxDD * 100).toFixed(1)}%`;
    console.log(`    COMPOUNDED (profit returns to the bank): ${compStr}`);
    console.log(`    flat sizing, for reference:              $${addUsd.toFixed(2)}   CAGR ${addCagr.toFixed(1)}%   maxDD ${(r.addMaxDD * 100).toFixed(1)}%`);
    console.log(`    peak gross notional constraint: ${pol.maxGrossNotional === Infinity ? "none" : pol.maxGrossNotional + "x equity"}`);
    console.log(`    taken ${r.taken.toLocaleString()} of ${all.length.toLocaleString()} (${((r.taken / all.length) * 100).toFixed(2)}%)   peak concurrent ${r.maxConcurrentSeen}`);
    console.log(`    REFUSED BY REASON: ${Object.entries(r.refused).map(([k, v]) => `${k} ${v.toLocaleString()} (${((v / totalRefused) * 100 || 0).toFixed(1)}%)`).join("   ")}`);
    console.log(`    size-capped by leverage ceiling: ${r.sizeCapped.toLocaleString()} of ${r.taken.toLocaleString()} taken (${((r.sizeCapped/Math.max(1,r.taken))*100).toFixed(1)}%) -- these carried LESS than the intended risk`);
    console.log(`    taken by strategy: ${[...r.takenBy.entries()].map(([k, v]) => `${k.split("_")[0]}=${v}`).join("  ")}`);
    if (r.netSamples.length) {
      const s = r.netSamples.slice().sort((a, b) => a - b);
      const q = (p) => s[Math.floor(p * (s.length - 1))].toFixed(2);
      console.log(`    NET DIRECTIONAL EXPOSURE (in R, + = net long): p5 ${q(0.05)}  p50 ${q(0.5)}  p95 ${q(0.95)}  mean ${mean(r.netSamples).toFixed(2)}`);
    }
    console.log("");
  }
  console.log("  The refusal breakdown is the product here. #145 established the book is budget-bound;");
  console.log("  it never showed WHICH constraint binds, and that is what a policy has to be chosen against.");
}

main().catch((e) => { console.error("Fatal:", e); process.exit(1); });
