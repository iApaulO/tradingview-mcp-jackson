#!/usr/bin/env node
// ARE A2 AND G BI-DIRECTIONAL? -- the gap #167 identified.
//
// #144 split the K>=3 co-occurrence construction by long versus short and found it genuinely
// bidirectional, with shorts OUTPERFORMING longs on all three instruments -- which is what refuted
// the drift confound, since all three assets rose across the sample.
//
// **That treatment was never applied to A2 or G. Zero of 176 register rows split either by
// direction.** That is a material hole: #145 established that A2 is the highest-frequency
// contributor in the portfolio (1,951 signals/yr) and monopolises the shared risk budget before
// low-frequency strategies ever reach it, so if A2's edge turns out to be one-sided then the
// PORTFOLIO's directional exposure is one-sided too -- and no row has ever measured that.
//
// The builders are IMPORTED from portfolio-backtest.js rather than reimplemented. A second
// hand-written copy of a population definition is how two copies silently diverge, which is the
// reasoning that produced lib/strategy-g-population.js. Costs are the portfolio harness's own
// parameters, so these numbers sit directly alongside #145's.
//
// WHAT COUNTS AS BI-DIRECTIONAL, declared before reading the output so the bar cannot move:
//   1. both sides costed-positive, and
//   2. neither side is a trivial slice of the population (>=20% of trades and n>=60), and
//   3. the long-minus-short difference is not significant -- i.e. there is no evidence the edge
//      lives on one side only.
// A construction failing (1) is one-sided. Failing (2) is effectively one-sided regardless of what
// the thin side's expectancy reads. Failing (3) alone is a lean, not a disqualification, and is
// reported as such.
//
// Null for the long-vs-short difference: circular-shift permutation of the side label against the
// costed-return series, preserving the autocorrelation of both, 20,000 iterations, two-sided.

import { loadCandles } from "../../backtest/lib/load-candles.js";
import { applyCosts } from "../../backtest/lib/costs.js";
import {
  buildStrategyA, buildStrategyA2, buildStrategyG, buildStrategyH, PORTFOLIO_COST_PARAMS,
} from "./portfolio-backtest.js";

const ITERATIONS = 20000, SEED = 42, MIN_N = 60, MIN_SHARE = 0.20;

function mulberry32(seed) {
  let a = seed >>> 0;
  return function () { a |= 0; a = (a + 0x6d2b79f5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
const mean = (xs) => (xs.length ? xs.reduce((s, x) => s + x, 0) / xs.length : NaN);

function sideTest(trades) {
  const sorted = [...trades].sort((a, b) => a.entryTime - b.entryTime);
  const vals = sorted.map((t) => t.pnlPct);
  const lab = sorted.map((t) => (t.side === "long" ? 1 : 0));
  const L = [], S = [];
  for (let i = 0; i < sorted.length; i++) (lab[i] ? L : S).push(vals[i]);
  if (!L.length || !S.length) return null;
  const obs = mean(L) - mean(S);
  const rnd = mulberry32(SEED);
  let ge = 0;
  for (let k = 0; k < ITERATIONS; k++) {
    const off = 1 + Math.floor(rnd() * (lab.length - 2));
    let sa = 0, na = 0, sb = 0, nb = 0;
    for (let i = 0; i < lab.length; i++) {
      if (lab[(i + off) % lab.length]) { sa += vals[i]; na++; } else { sb += vals[i]; nb++; }
    }
    if (na && nb && Math.abs(sa / na - sb / nb) >= Math.abs(obs)) ge++;
  }
  return { obs, p: ge / ITERATIONS, L, S };
}

async function main() {
  console.log("DIRECTIONAL SPLIT -- A2 and G, the treatment #144 applied to K>=3 and nobody applied here.");
  console.log("Builders imported from portfolio-backtest.js; costs are the portfolio harness's own.");
  console.log(`Bi-directional requires: both sides costed-positive, each >=${MIN_SHARE * 100}% of trades and n>=${MIN_N}.\n`);

  const LADDER = ["1w", "1d", "4h", "3h", "2h", "1h", "15m", "5m"];
  const candlesByTf = {};
  for (const tf of LADDER) candlesByTf[tf] = await loadCandles(tf);

  const builders = [
    ["A2_engulfment_only", buildStrategyA2],
    ["G_wt_anchor_ct_15m", buildStrategyG],
    ["A_recurrence", buildStrategyA],       // context: the pooled variant A2 was derived from
    ["H_cooccurrence_k3", buildStrategyH],  // control: #144 already established this is bidirectional
  ];

  for (const [name, fn] of builders) {
    const raw = await fn(candlesByTf);
    const costed = applyCosts(raw, PORTFOLIO_COST_PARAMS);
    const L = costed.filter((t) => t.side === "long");
    const S = costed.filter((t) => t.side === "short");
    const shareL = L.length / costed.length, shareS = S.length / costed.length;

    console.log(`===== ${name}   n=${costed.length.toLocaleString()}`);
    for (const [lbl, g] of [["long", L], ["short", S]]) {
      if (!g.length) { console.log(`   ${lbl.padEnd(6)} n=0`); continue; }
      const win = g.filter((t) => t.pnlPct > 0).length / g.length;
      console.log(
        `   ${lbl.padEnd(6)} n=${String(g.length).padStart(6)}  ${(g.length / costed.length * 100).toFixed(1).padStart(5)}% of trades` +
        `  win ${(win * 100).toFixed(1).padStart(5)}%  costed exp ${(mean(g.map((t) => t.pnlPct)) * 100).toFixed(4).padStart(9)}%/trade`,
      );
    }
    const r = sideTest(costed);
    if (r) console.log(`   long minus short: ${(r.obs * 100).toFixed(4)}pp   p=${r.p.toFixed(4)}${r.p < 0.05 ? " *" : ""}`);

    const bothPos = L.length && S.length && mean(L.map((t) => t.pnlPct)) > 0 && mean(S.map((t) => t.pnlPct)) > 0;
    const bothFat = L.length >= MIN_N && S.length >= MIN_N && shareL >= MIN_SHARE && shareS >= MIN_SHARE;
    const verdict = !bothFat ? "ONE-SIDED (population)" : !bothPos ? "ONE-SIDED (expectancy)" : "BI-DIRECTIONAL";
    console.log(`   VERDICT: ${verdict}${r && r.p < 0.05 && verdict === "BI-DIRECTIONAL" ? "  (with a significant lean)" : ""}\n`);
  }
}

main().catch((e) => { console.error("Fatal:", e); process.exit(1); });
