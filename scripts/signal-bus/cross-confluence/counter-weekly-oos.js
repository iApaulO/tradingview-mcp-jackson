#!/usr/bin/env node
// Out-of-sample, walk-forward, and cross-instrument replication of #133's counter-WEEKLY gate on
// Strategy G.
//
// #133 found that G performs markedly better when the trade OPPOSES the weekly SuperTrend
// direction -- significant under both nulls in all three structure variants (+0.22 to +0.46pp),
// with a clean internal control (the same test on DAILY alignment is null everywhere). It
// deliberately did NOT wire the gate in, because #121 is this project's standing precedent that
// in-sample ranking is not forward persistence: that row is where a variant which looked WORSE
// in-sample tripled its walk-forward contribution. A filter that improves in-sample expectancy by
// ~60% on one binary condition is exactly the case that demands forward evidence first.
//
// WHAT "WALK-FORWARD" MEANS FOR A PARAMETER-FREE GATE. The gate has nothing to fit -- it is a
// single binary condition with no threshold, window or coefficient. So the risk is not parameter
// overfitting; it is that the effect is a period-specific artefact, or a survivor of the six
// splits tested in #133. The appropriate tests are therefore TEMPORAL STABILITY (does the gap hold
// sign across disjoint sequential windows?) and CROSS-INSTRUMENT REPLICATION (does it hold on data
// never used to find it?), not a train/fit/test loop that would have nothing to fit.
//
// THREE TESTS:
//   1. CHRONOLOGICAL OOS -- first 70% of trades by time are the discovery period, last 30% are
//      held out. #133's effect was found on the whole sample, so the last 30% is not a pure
//      holdout; it is reported as the weaker "did it persist late" check.
//   2. WALK-FORWARD FOLDS -- K disjoint sequential windows, gap reported per fold. Under the null
//      of no effect each fold is a coin flip on sign, so the count of positive folds has an exact
//      binomial p-value. This is the test that a period-specific artefact fails.
//   3. ETH REPLICATION -- a genuine holdout. ETH's corpus was built in #127/#130 and has never
//      been examined in any of #128-#133, so nothing about the gate was derived from it.
//
// Usage: node scripts/signal-bus/cross-confluence/counter-weekly-oos.js [--tf=15m] [--folds=6]
//        [--oos-frac=0.3] [--iterations=20000]

import { writeFileSync, mkdirSync } from "fs";
import { applyCosts, FEE_TIERS, REPRESENTATIVE_FUNDING_PCT_PER_HOUR } from "../../backtest/lib/costs.js";
import { buildGPopulation, G_VARIANTS } from "./lib/strategy-g-population.js";

const args = Object.fromEntries(process.argv.slice(2).filter((a) => a.includes("=")).map((a) => a.replace(/^--/, "").split("=")));
const TF = args.tf || "15m";
const FOLDS = parseInt(args.folds || "6", 10);
const OOS_FRAC = parseFloat(args["oos-frac"] || "0.3");
const ITERATIONS = parseInt(args.iterations || "20000", 10);
const SEED = parseInt(args.seed || "42", 10);

const costParams = { takerFeePct: FEE_TIERS.bitunix_futures_vip1.takerFeePct, fundingPctPerHour: REPRESENTATIVE_FUNDING_PCT_PER_HOUR };
const mean = (xs) => (xs.length ? xs.reduce((s, x) => s + x, 0) / xs.length : null);

function mulberry32(seed) {
  let a = seed >>> 0;
  return function () { a |= 0; a = (a + 0x6d2b79f5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
// Exact two-sided-ish binomial tail: P(X >= k) with p=0.5. Used for the fold-sign test, where the
// null really is a fair coin per fold.
function binomTailAtLeast(k, n) {
  const c = (n, r) => { let v = 1; for (let i = 0; i < r; i++) v = (v * (n - i)) / (i + 1); return v; };
  let s = 0;
  for (let i = k; i <= n; i++) s += c(n, i);
  return s / Math.pow(2, n);
}

// costed gap between "opposes weekly" and "agrees weekly" for a slice of trades
function gapFor(slice) {
  if (slice.length < 20) return null;
  const costed = applyCosts(slice, costParams).map((t) => t.pnlPct);
  const opp = [], agr = [];
  for (let i = 0; i < slice.length; i++) (slice[i].agreesWeekly ? agr : opp).push(costed[i]);
  if (opp.length < 10 || agr.length < 10) return null;
  return { n: slice.length, nOpp: opp.length, nAgr: agr.length, mOpp: mean(opp), mAgr: mean(agr), gap: mean(opp) - mean(agr) };
}

function permP(slice, realGap, rng) {
  const costed = applyCosts(slice, costParams).map((t) => t.pnlPct);
  const lab = slice.map((t) => (t.agreesWeekly ? 0 : 1));
  const gapFromLabels = (arr) => {
    let sA = 0, nA = 0, sB = 0, nB = 0;
    for (let i = 0; i < arr.length; i++) { if (arr[i]) { sA += costed[i]; nA++; } else { sB += costed[i]; nB++; } }
    return nA && nB ? sA / nA - sB / nB : null;
  };
  let geq = 0;
  for (let k = 0; k < ITERATIONS; k++) {
    const off = 1 + Math.floor(rng() * (lab.length - 2));
    const cs = lab.map((_, i) => lab[(i + off) % lab.length]); // circular shift, per #129
    const g = gapFromLabels(cs);
    if (g != null && g >= realGap) geq++;
  }
  return geq / ITERATIONS;
}

const fmt = (x) => (x == null ? "  n/a  " : `${(x * 100).toFixed(4)}%`);

async function runInstrument(instrument, out) {
  const rng = mulberry32(SEED);
  const all = await buildGPopulation(instrument, TF);
  console.log(`\n${"#".repeat(104)}`);
  console.log(`## ${instrument} -- ${all.length.toLocaleString()} G-population trades (${TF})`);
  console.log(`${"#".repeat(104)}`);

  out[instrument] = {};
  for (const [vname, pred] of Object.entries(G_VARIANTS)) {
    const sub = all.filter(pred);
    if (sub.length < 100) { console.log(`\n${vname}: n=${sub.length}, too thin`); continue; }

    const full = gapFor(sub);
    console.log(`\n--- ${vname} (n=${sub.length}) ---`);
    console.log(`  FULL SAMPLE   opposes ${fmt(full.mOpp)} (n=${full.nOpp})  agrees ${fmt(full.mAgr)} (n=${full.nAgr})  gap=${(full.gap * 100).toFixed(4)}pp`);

    // 1. chronological OOS
    const cut = Math.floor(sub.length * (1 - OOS_FRAC));
    const tr = gapFor(sub.slice(0, cut)), te = gapFor(sub.slice(cut));
    let pOOS = null;
    if (te) pOOS = permP(sub.slice(cut), te.gap, rng);
    console.log(`  IN-SAMPLE 70% gap=${tr ? (tr.gap * 100).toFixed(4) : "n/a"}pp   OUT-OF-SAMPLE 30% gap=${te ? (te.gap * 100).toFixed(4) : "n/a"}pp  p(circ)=${pOOS != null ? pOOS.toFixed(4) + (pOOS < 0.05 ? "*" : "") : "n/a"}  (oos n=${te ? te.n : 0})`);

    // 2. walk-forward folds
    const foldSize = Math.floor(sub.length / FOLDS);
    const foldGaps = [];
    for (let f = 0; f < FOLDS; f++) {
      const slice = sub.slice(f * foldSize, f === FOLDS - 1 ? sub.length : (f + 1) * foldSize);
      const g = gapFor(slice);
      foldGaps.push(g ? g.gap : null);
    }
    const usable = foldGaps.filter((g) => g != null);
    const pos = usable.filter((g) => g > 0).length;
    const pBinom = usable.length ? binomTailAtLeast(pos, usable.length) : null;
    console.log(`  WALK-FORWARD ${usable.length} folds: ${foldGaps.map((g) => (g == null ? " n/a " : `${g > 0 ? "+" : ""}${(g * 100).toFixed(2)}`)).join("  ")}`);
    console.log(`               ${pos}/${usable.length} folds positive   binomial p=${pBinom != null ? pBinom.toFixed(4) + (pBinom < 0.05 ? "*" : "") : "n/a"}`);

    out[instrument][vname] = {
      n: sub.length,
      full_gap_pp: full.gap * 100, full_opp_pct: full.mOpp * 100, full_agr_pct: full.mAgr * 100,
      in_sample_gap_pp: tr ? tr.gap * 100 : null,
      oos_gap_pp: te ? te.gap * 100 : null, oos_n: te ? te.n : 0, oos_p: pOOS,
      fold_gaps_pp: foldGaps.map((g) => (g == null ? null : g * 100)),
      folds_positive: pos, folds_usable: usable.length, fold_binomial_p: pBinom,
    };
  }
}

async function main() {
  const out = {};
  console.log(`Counter-WEEKLY gate on Strategy G -- OOS, walk-forward, and ETH replication`);
  console.log(`${FOLDS} folds, ${(OOS_FRAC * 100).toFixed(0)}% holdout, ${ITERATIONS} circular-shift draws, costed at bitunix_futures_vip1`);
  for (const inst of ["BTC", "ETH"]) await runInstrument(inst, out);

  const RESULTS_DIR = new URL("results/", import.meta.url);
  mkdirSync(RESULTS_DIR, { recursive: true });
  const fname = `counter_weekly_oos_${new Date().toISOString().replace(/[:.]/g, "-")}.json`;
  writeFileSync(new URL(fname, RESULTS_DIR), JSON.stringify({ generated_at: new Date().toISOString(), tf: TF, folds: FOLDS, oos_frac: OOS_FRAC, iterations: ITERATIONS, seed: SEED, results: out }, null, 2));
  console.log(`\nSaved: ${new URL(fname, RESULTS_DIR).pathname.replace(/^\/([A-Z]:)/, "$1")}`);
}

main().catch((err) => { console.error("Fatal:", err); process.exit(1); });
