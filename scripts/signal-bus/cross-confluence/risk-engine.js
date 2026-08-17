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
// Usage:
//   node scripts/signal-bus/cross-confluence/risk-engine.js
//   node scripts/signal-bus/cross-confluence/risk-engine.js --strategies=H_cooccurrence_k3,A2_engulfment_only

import { loadCandles } from "../../backtest/lib/load-candles.js";
import { applyCosts } from "../../backtest/lib/costs.js";
import {
  buildStrategyA, buildStrategyA2, buildStrategyG, buildStrategyH, PORTFOLIO_COST_PARAMS,
} from "./portfolio-backtest.js";

const args = Object.fromEntries(process.argv.slice(2).filter((a) => a.includes("=")).map((a) => a.replace(/^--/, "").split("=")));
const STARTING_BANK = 500;

const BUILDERS = {
  H_cooccurrence_k3: buildStrategyH,
  A2_engulfment_only: buildStrategyA2,
  A_recurrence: buildStrategyA,
  G_wt_anchor_ct_15m: buildStrategyG,
};
const WANTED = (args.strategies || Object.keys(BUILDERS).join(",")).split(",").map((s) => s.trim());

// ---- DECLARED POLICIES. Named, fixed, compared -- never tuned. ----
const POLICIES = {
  // #145's flat mode, reproduced as the reference point. No concurrency or exposure control at all.
  flat_uncapped: {
    label: "flat, uncapped (#145 reference)",
    riskPctPerTrade: 0.005, maxRiskDeployed: 0.02,
    maxConcurrent: Infinity, maxPerStrategy: Infinity, maxNetExposureR: Infinity, maxLeverage: 3,
  },
  // Adds the two controls #145 never had: a hard concurrency ceiling and a net-directional cap.
  capped_balanced: {
    label: "capped concurrency + net-exposure cap",
    riskPctPerTrade: 0.005, maxRiskDeployed: 0.02,
    maxConcurrent: 10, maxPerStrategy: 4, maxNetExposureR: 4, maxLeverage: 3,
  },
  // Reserves room for low-frequency strategies so the fast ones cannot monopolise the budget --
  // the specific failure #145 identified, where H (31/yr) never traded at all under flat.
  capped_reserved: {
    label: "capped + per-strategy reservation",
    riskPctPerTrade: 0.005, maxRiskDeployed: 0.02,
    maxConcurrent: 10, maxPerStrategy: 3, maxNetExposureR: 4, maxLeverage: 3,
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
function simulate(trades, pol) {
  let equity = 1, peak = 1, maxDD = 0;
  let deployed = 0, netR = 0, taken = 0, maxConcurrentSeen = 0;
  const perStrat = new Map();
  const refused = { budget: 0, concurrency: 0, per_strategy: 0, net_exposure: 0 };
  const takenBy = new Map();
  const netSamples = [];
  let openCount = 0, sizeCapped = 0;

  // pending closes, kept sorted by exit time
  const pending = [];
  const insertPending = (p) => {
    let lo = 0, hi = pending.length;
    while (lo < hi) { const m = (lo + hi) >> 1; if (pending[m].exitT <= p.exitT) lo = m + 1; else hi = m; }
    pending.splice(lo, 0, p);
  };
  const closePos = (p) => {
    deployed -= p.riskFrac;
    netR -= p.side === "long" ? p.riskFrac : -p.riskFrac;
    perStrat.set(p.strategy, (perStrat.get(p.strategy) || 1) - 1);
    openCount--;
    equity *= 1 + p.pnl;
    if (equity > peak) peak = equity;
    maxDD = Math.max(maxDD, (peak - equity) / peak);
  };
  const sweep = (upTo) => { while (pending.length && pending[0].exitT <= upTo) closePos(pending.shift()); };

  for (const tr of trades) {
    sweep(tr.entryTime);                       // free capital from anything already resolved

    const riskFrac = pol.riskPctPerTrade;
    if (deployed + riskFrac > pol.maxRiskDeployed + 1e-12) { refused.budget++; continue; }
    if (openCount >= pol.maxConcurrent) { refused.concurrency++; continue; }
    const nStrat = perStrat.get(tr.strategy) || 0;
    if (nStrat >= pol.maxPerStrategy) { refused.per_strategy++; continue; }
    const signed = tr.side === "long" ? riskFrac : -riskFrac;
    if (Math.abs((netR + signed) / pol.riskPctPerTrade) > pol.maxNetExposureR + 1e-9) { refused.net_exposure++; continue; }

    // ---- POSITION SIZING, and the leverage cap that makes it executable ----
    // Desired notional to risk `riskFrac` of equity given a stop `tr.riskPct` away is
    // riskFrac / tr.riskPct, expressed as a multiple of equity. For A and A2 the stop is the ORDER
    // BLOCK'S OWN HEIGHT, which can be arbitrarily thin -- riskPct reaches 1.0e-7, implying a
    // position ~5,000x equity. That is not a modelling nuisance, it is a real constraint: **those
    // strategies are not sizeable by a fixed-risk rule, and any framework that pretends otherwise
    // is reporting returns on positions nobody could take.** The cap is what a real desk applies:
    // size = min(risk-implied, leverage ceiling). When the ceiling binds, the position carries LESS
    // than the intended risk, which is the honest outcome rather than an error.
    const desiredNotional = riskFrac / tr.riskPct;
    const notional = Math.min(desiredNotional, pol.maxLeverage);
    const cappedBy = notional < desiredNotional;
    if (cappedBy) sizeCapped++;
    const effRisk = notional * tr.riskPct;      // risk actually carried, <= riskFrac

    deployed += effRisk;
    netR += tr.side === "long" ? effRisk : -effRisk;
    perStrat.set(tr.strategy, nStrat + 1);
    takenBy.set(tr.strategy, (takenBy.get(tr.strategy) || 0) + 1);
    taken++; openCount++;
    maxConcurrentSeen = Math.max(maxConcurrentSeen, openCount);
    netSamples.push(netR / pol.riskPctPerTrade);

    const exitT = tr.exitTime ?? tr.entryTime;
    const pnl = notional * (tr.costedPnlPct ?? tr.pnlPct);   // P&L on the size actually held
    const pos = { exitT, riskFrac: effRisk, side: tr.side, strategy: tr.strategy, pnl };
    if (exitT <= tr.entryTime) closePos(pos);   // same-bar resolution: free it now
    else insertPending(pos);
  }
  sweep(Infinity);
  return { equity, maxDD, taken, refused, takenBy, maxConcurrentSeen, netSamples, sizeCapped };
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
    const finalUsd = STARTING_BANK * r.equity;
    const cagr = (Math.pow(r.equity, 1 / spanYears) - 1) * 100;
    const totalRefused = Object.values(r.refused).reduce((a, b) => a + b, 0);
    console.log(`  ${pol.label}`);
    console.log(`    final $${finalUsd.toFixed(2)}   return ${((r.equity - 1) * 100).toFixed(1)}%   CAGR ${cagr.toFixed(1)}%   maxDD ${(r.maxDD * 100).toFixed(1)}%`);
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
