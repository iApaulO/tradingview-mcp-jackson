#!/usr/bin/env node
// Formal significance test + full timeframe-ladder check on #123, closing the two next steps that
// row explicitly flagged as not done ("Not yet formally significance-tested (descriptive/cost-check
// only, matching #110's own first-pass convention before #113/#114 added the permutation test) or
// checked on other timeframes").
//
// #123 compared three structure filters on the same anchor+OB-confluence+q5-drop base population
// (15m only, descriptive only): D4M_ONLY (#110/G's shipped condition), SWINGLINE_ONLY, and BOTH
// (the full 3-way AND iapaulo originally described). BOTH had the best costed expectancy of the
// three (+0.4973%/trade at #125-corrected values vs +0.2834% D4M-only), which #123 read as the
// conditions concentrating edge rather than over-restricting. That read was never tested -- a
// smaller subset having a higher mean is exactly what sampling noise produces for free, and #123
// said so itself.
//
// THREE DIFFERENT NULLS, because "is this significant" is three different questions here and
// answering only the first (which is what #113/#114 did for #110/#114) would not actually address
// what #123 left open:
//
//   A. DIRECTION null (same methodology as #113/#114/#99): does the variant's actual long/short
//      call beat randomly assigning direction to the same entries? Establishes the construction
//      has real directional edge, and is directly comparable to the existing register chain.
//      Long/short stop+exit are asymmetric by side (natural exit is the next OPPOSITE-side OB's
//      origin bar, which differs per side), so both scenarios are precomputed per entry and the
//      permutation picks which one applies -- never a naive sign flip.
//
//   B. SELECTION null: does the filtered subset beat a random same-size subset of the base
//      population? Tests whether the filter selects better-than-average trades at all, holding n
//      fixed so a smaller sample can't flatter itself.
//
//   C. CONCENTRATION null (the actual #123 question): BOTH is a strict subset of D4M_ONLY and of
//      SWINGLINE_ONLY. Is BOTH's higher mean more than you'd get by drawing an equally-sized
//      random subset OF THAT PARENT? This is the only test that distinguishes "the second
//      condition adds real information" from "smaller sample, luckier mean." Run against both
//      parents separately.
//
// Independence is checked BEFORE any of that (house standing rule -- near-duplicate inputs fake
// confluence, cf. the r=0.9993 Cipher A/B wt2 pair discarded in #28): 2x2 contingency of
// hasD4m x hasSwingLine over the base population, reported as a phi coefficient. If the two
// conditions were near-redundant, a "3-way AND" would be a relabeled 2-way and the whole #123
// comparison would be malformed.
//
// Multiple-testing correction (scripts/backtest/lib/multiple-testing.js, Bonferroni/Holm/BH)
// applied across the ladder for the headline test C family -- 8 timeframes searched for one
// effect is exactly the setup that correction exists for.
//
// Costs: bitunix_futures_vip1 (0.050% taker), the confirmed venue as of 2026-08-15. Same fee tier
// #123 itself used, so the descriptive numbers here are directly comparable to that row.
//
// ── D4M ZONE SCOPE: an inconsistency found while building this test, reported not silently fixed ──
// `zones` has a `timeframe` column, but the entire Strategy G chain queries it WITHOUT filtering:
// wt-anchor-ob-d4m-q5-refinement.js (#110), wt-anchor-daily-regime-cascade.js (#113),
// wt-anchor-swingline-vs-d4m.js (#123), and portfolio-backtest.js (Strategy G in production) all
// do `SELECT ... FROM zones` and pool every timeframe together. Other scripts in this same
// directory DO filter (boom-full-sequence-at-below-structure, div-line-retest-double-ob,
// failed-bos-ob-d4m, ltf-counter-trend-dip-buy, ob-structure-divergence-enhancement).
//
// This is not a look-ahead bug -- `confirmed_time > atTime` is checked either way. But it does
// change what the condition MEANS: the zone pool is 66% 5m rows (3,617 of 5,466), so on a 15m
// anchor "has a same-side D4M line within 1.2%" is largely asking "is there any 5m divergence
// line near this price," a far denser and weaker condition than the 15m-line reading the register
// prose describes.
//
// Both readings are defensible -- a horizontal level found on 5m is still a real price level, and
// multi-timeframe level confluence is a legitimate concept. So this script runs BOTH scopes side
// by side rather than picking one: `pooled` reproduces #110/#123/Strategy G exactly (and is what
// makes these numbers comparable to that row), `own_tf` restricts to the analyzed timeframe's own
// lines. If the two disagree, that is itself the finding, and it reaches further than #123 --
// it would mean Strategy G's shipped D4M condition is not the condition its own documentation
// describes.
//
// Usage: node scripts/signal-bus/cross-confluence/wt-anchor-swingline-significance.js
//        [--tf=1w,1d,4h,3h,2h,1h,15m,5m] [--iterations=20000] [--seed=42]

import { DatabaseSync } from "node:sqlite";
import { writeFileSync, mkdirSync } from "fs";
import { loadCandles } from "../../backtest/lib/load-candles.js";
import { computeMetrics } from "../../backtest/lib/metrics.js";
import { applyCosts, FEE_TIERS, REPRESENTATIVE_FUNDING_PCT_PER_HOUR } from "../../backtest/lib/costs.js";
import { bonferroniCorrection, holmBonferroniCorrection, benjaminiHochbergCorrection } from "../../backtest/lib/multiple-testing.js";
import { computeWtExtremeFractals } from "../vmc-cipher-b/calc.js";
import { computeBoomHunter } from "../boom-hunter/calc.js";
import { computeSwingPivotSeries } from "../smc/calc.js";

const SMC_DB_PATH = new URL("../../../data/signal-bus/smc.db", import.meta.url);
const D4M_DB_PATH = new URL("../../../data/signal-bus/divergence-for-many.db", import.meta.url);
const args = Object.fromEntries(process.argv.slice(2).map((a) => a.replace(/^--/, "").split("=")));
const TFS = args.tf ? args.tf.split(",") : ["1w", "1d", "4h", "3h", "2h", "1h", "15m", "5m"];
const ITERATIONS = parseInt(args.iterations || "20000", 10);
const SEED = parseInt(args.seed || "42", 10);
const MIN_N = 30; // same thinness floor as wt-anchor-permutation-significance.js

// Construction constants -- identical to wt-anchor-swingline-vs-d4m.js (#123). Any change here
// would make these numbers non-comparable to that row, which is the whole point of this test.
const D4M_TOL_PCT = 0.012;
const ATR_LEN = 14, ATR_MULT = 0.6, MAX_HOLD_BARS = 200;

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

function mulberry32(seed) {
  let a = seed >>> 0;
  return function () { a |= 0; a = (a + 0x6d2b79f5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

function mean(xs) { return xs.length ? xs.reduce((s, x) => s + x, 0) / xs.length : null; }

// Phi coefficient on a 2x2 contingency table -- the correlation measure appropriate for two
// binary flags (Pearson r computed on 0/1 vectors reduces to exactly this).
function phiCoefficient(n11, n10, n01, n00) {
  const num = n11 * n00 - n10 * n01;
  const den = Math.sqrt((n11 + n10) * (n01 + n00) * (n11 + n01) * (n10 + n00));
  return den === 0 ? null : num / den;
}

// Draws a random subset of size k from `pool` (array of costed pnl values) WITHOUT replacement,
// via partial Fisher-Yates -- returns the subset mean. Sampling without replacement is the right
// null here: the real subset is itself a without-replacement draw from the parent, so a
// with-replacement bootstrap would have the wrong variance.
function randomSubsetMean(pool, k, rng, scratch) {
  const n = pool.length;
  for (let i = 0; i < n; i++) scratch[i] = pool[i];
  let sum = 0;
  for (let i = 0; i < k; i++) {
    const j = i + Math.floor(rng() * (n - i));
    const tmp = scratch[i]; scratch[i] = scratch[j]; scratch[j] = tmp;
    sum += scratch[i];
  }
  return sum / k;
}

// One-sided permutation p: proportion of null draws whose mean >= the real mean.
function subsetPermutationP(parentVals, k, realMean, rng, iterations) {
  if (k >= parentVals.length) return null; // subset IS the parent, nothing to permute
  const scratch = new Float64Array(parentVals.length);
  let geq = 0;
  for (let it = 0; it < iterations; it++) {
    if (randomSubsetMean(parentVals, k, rng, scratch) >= realMean) geq++;
  }
  return geq / iterations;
}

async function analyzeTimeframe(tf, smcDb, d4mDb, costParams) {
  const candles = await loadCandles(tf);
  const atr14 = atr(candles, ATR_LEN);
  const { events: anchors } = computeWtExtremeFractals(candles);
  const { series } = computeBoomHunter(candles);
  const q5 = series.q5;
  const { swingHighLevel, swingLowLevel } = computeSwingPivotSeries(candles);

  const obRows = smcDb.prepare("SELECT side, bar_high, bar_low, created_bar_idx, origin_bar_idx FROM order_blocks WHERE timeframe = ? AND scope = ?").all(tf, "swing");
  const swingObsBySide = {
    bullish: obRows.filter((o) => o.side === "bullish").sort((a, b) => a.origin_bar_idx - b.origin_bar_idx),
    bearish: obRows.filter((o) => o.side === "bearish").sort((a, b) => a.origin_bar_idx - b.origin_bar_idx),
  };
  // Pooled = every timeframe's zones (what #110/#123/Strategy G actually do). own_tf = this
  // timeframe's zones only. Both computed per row; neither is treated as the default truth.
  const d4mZonesPooled = d4mDb.prepare("SELECT side, price, confirmed_time, expires_time FROM zones").all();
  const d4mZonesOwnTf = d4mDb.prepare("SELECT side, price, confirmed_time, expires_time FROM zones WHERE timeframe = ?").all(tf);

  function hasD4mConfluence(zones, side, obPrice, atTime) {
    const tol = obPrice * D4M_TOL_PCT;
    for (const z of zones) {
      if (z.side !== side) continue;
      if (z.confirmed_time > atTime) continue;
      if (z.expires_time != null && z.expires_time < atTime) continue;
      if (Math.abs(z.price - obPrice) <= tol) return true;
    }
    return false;
  }
  function beyondSwingLine(side, obPrice, barIdx) {
    if (side === "bullish") { const lvl = swingLowLevel[barIdx]; return Number.isFinite(lvl) && obPrice < lvl; }
    const lvl = swingHighLevel[barIdx]; return Number.isFinite(lvl) && obPrice > lvl;
  }

  // Identical exit logic to #123's simulate(), parameterized by side so the direction null can
  // precompute both branches for the same entry.
  function simulate(entryIdx, side, atrAtAnchor, afterBarIdx) {
    const entryPrice = candles[entryIdx].o;
    const risk = ATR_MULT * atrAtAnchor;
    const stopPrice = side === "long" ? entryPrice - risk : entryPrice + risk;
    const oppositeSide = side === "long" ? "bearish" : "bullish";
    const nextOppositeOB = swingObsBySide[oppositeSide].find((ob) => ob.origin_bar_idx > afterBarIdx);
    const naturalExitIdx = Math.min(candles.length - 1, nextOppositeOB ? nextOppositeOB.origin_bar_idx : entryIdx + MAX_HOLD_BARS, entryIdx + MAX_HOLD_BARS);
    if (naturalExitIdx <= entryIdx) return null;
    let exitPrice = candles[naturalExitIdx].c, exitTime = candles[naturalExitIdx].t;
    for (let j = entryIdx; j <= naturalExitIdx; j++) {
      const bar = candles[j];
      const hitStop = side === "long" ? bar.l <= stopPrice : bar.h >= stopPrice;
      if (hitStop) { exitPrice = stopPrice; exitTime = bar.t; break; }
    }
    const pnlPct = side === "long" ? (exitPrice - entryPrice) / entryPrice : (entryPrice - exitPrice) / entryPrice;
    return { side, entryTime: candles[entryIdx].t, entryPrice, exitTime, exitPrice, pnlPct };
  }

  const rows = [];
  for (const a of anchors) {
    const entryIdx = a.barIdx + 1;
    if (entryIdx >= candles.length) continue;
    const atrAtAnchor = atr14[a.barIdx];
    if (!Number.isFinite(atrAtAnchor) || atrAtAnchor <= 0) continue;
    const ob = obRows.find((o) => o.side === a.side && o.created_bar_idx <= a.barIdx + 2 && a.price >= o.bar_low && a.price <= o.bar_high);
    if (!ob) continue;
    if (a.barIdx - 1 < 0) continue;
    const q5Now = q5[a.barIdx], q5Then = q5[a.barIdx - 1];
    if (!Number.isFinite(q5Now) || !Number.isFinite(q5Then) || !(q5Now < q5Then)) continue;

    const trueSide = a.side === "bullish" ? "long" : "short";
    const realTrade = simulate(entryIdx, trueSide, atrAtAnchor, a.barIdx);
    if (!realTrade) continue;
    // The direction null needs BOTH branches to resolve (otherwise its null and its real set come
    // from different populations), but tests B/C and the descriptive table do not -- they never
    // touch the opposite branch. Excluding those entries everywhere would silently shift the
    // population away from #123's and break comparability with that row, so the flag is recorded
    // per row and only test A filters on it. Verified: keeping the full population reproduces
    // #123's n=1441/843/557 and costed 0.2834/0.4205/0.4973 exactly.
    const longTrade = trueSide === "long" ? realTrade : simulate(entryIdx, "long", atrAtAnchor, a.barIdx);
    const shortTrade = trueSide === "short" ? realTrade : simulate(entryIdx, "short", atrAtAnchor, a.barIdx);

    const obMidPrice = (ob.bar_high + ob.bar_low) / 2;
    const entryTime = candles[entryIdx].t;
    rows.push({
      hasD4mPooled: hasD4mConfluence(d4mZonesPooled, a.side, obMidPrice, entryTime),
      hasD4mOwnTf: hasD4mConfluence(d4mZonesOwnTf, a.side, obMidPrice, entryTime),
      hasSwingLine: beyondSwingLine(a.side, obMidPrice, a.barIdx),
      dualOk: Boolean(longTrade && shortTrade),
      realTrade,
      longTrade: longTrade || realTrade,
      shortTrade: shortTrade || realTrade,
    });
  }

  if (rows.length === 0) return { tf, baseN: 0, tooThin: true };

  // Cost everything once; every downstream permutation reuses these per-trade values.
  const realCosted = applyCosts(rows.map((r) => r.realTrade), costParams).map((t) => t.pnlPct);
  const longCosted = applyCosts(rows.map((r) => r.longTrade), costParams).map((t) => t.pnlPct);
  const shortCosted = applyCosts(rows.map((r) => r.shortTrade), costParams).map((t) => t.pnlPct);

  const byScope = {};
  for (const scope of ["pooled", "own_tf"]) {
    byScope[scope] = runBattery(rows, scope, realCosted, longCosted, shortCosted);
  }

  return { tf, baseN: rows.length, base_costed_exp_pct: mean(realCosted) * 100, scopes: byScope };
}

// Runs the full independence + descriptive + A/B/C battery for one D4M scope.
function runBattery(rows, scope, realCosted, longCosted, shortCosted) {
  const d4mKey = scope === "pooled" ? "hasD4mPooled" : "hasD4mOwnTf";

  // ── Independence check ────────────────────────────────────────────────────────────────────
  let n11 = 0, n10 = 0, n01 = 0, n00 = 0;
  for (const r of rows) {
    if (r[d4mKey] && r.hasSwingLine) n11++;
    else if (r[d4mKey] && !r.hasSwingLine) n10++;
    else if (!r[d4mKey] && r.hasSwingLine) n01++;
    else n00++;
  }
  const phi = phiCoefficient(n11, n10, n01, n00);

  const idx = {
    BASE: rows.map((_, i) => i),
    D4M_ONLY: rows.map((r, i) => (r[d4mKey] ? i : -1)).filter((i) => i >= 0),
    SWINGLINE_ONLY: rows.map((r, i) => (r.hasSwingLine ? i : -1)).filter((i) => i >= 0),
    BOTH: rows.map((r, i) => (r[d4mKey] && r.hasSwingLine ? i : -1)).filter((i) => i >= 0),
  };

  const descriptive = {};
  for (const [name, ids] of Object.entries(idx)) {
    if (ids.length === 0) { descriptive[name] = { n: 0 }; continue; }
    const gross = computeMetrics(ids.map((i) => rows[i].realTrade));
    descriptive[name] = {
      n: ids.length,
      win_rate: gross.win_rate,
      profit_factor: gross.profit_factor,
      gross_exp_pct: mean(ids.map((i) => rows[i].realTrade.pnlPct)) * 100,
      costed_exp_pct: mean(ids.map((i) => realCosted[i])) * 100,
    };
  }

  // ── Test A: direction null, per variant ───────────────────────────────────────────────────
  // Only rows where both side-branches resolved are eligible here -- see the note at row build.
  const rngA = mulberry32(SEED);
  const testA = {};
  for (const [name, allIds] of Object.entries(idx)) {
    const ids = allIds.filter((i) => rows[i].dualOk);
    const excluded = allIds.length - ids.length;
    if (ids.length < MIN_N) { testA[name] = { n: ids.length, excluded_no_dual_branch: excluded, tooThin: true }; continue; }
    const realMean = mean(ids.map((i) => realCosted[i]));
    let geq = 0;
    for (let it = 0; it < ITERATIONS; it++) {
      let sum = 0;
      for (const i of ids) sum += rngA() < 0.5 ? longCosted[i] : shortCosted[i];
      if (sum / ids.length >= realMean) geq++;
    }
    testA[name] = { n: ids.length, excluded_no_dual_branch: excluded, real_costed_mean_pct: realMean * 100, p: geq / ITERATIONS };
  }

  // ── Test B: selection null vs random same-size subset of BASE ─────────────────────────────
  const rngB = mulberry32(SEED + 1);
  const baseVals = Float64Array.from(realCosted);
  const testB = {};
  for (const name of ["D4M_ONLY", "SWINGLINE_ONLY", "BOTH"]) {
    const ids = idx[name];
    if (ids.length < MIN_N) { testB[name] = { n: ids.length, tooThin: true }; continue; }
    const realMean = mean(ids.map((i) => realCosted[i]));
    testB[name] = {
      n: ids.length,
      real_costed_mean_pct: realMean * 100,
      base_mean_pct: mean(realCosted) * 100,
      p: subsetPermutationP(baseVals, ids.length, realMean, rngB, ITERATIONS),
    };
  }

  // ── Test C: concentration null -- BOTH vs random same-size subset of each parent ──────────
  const rngC = mulberry32(SEED + 2);
  const testC = {};
  const bothIds = idx.BOTH;
  if (bothIds.length >= MIN_N) {
    const bothMean = mean(bothIds.map((i) => realCosted[i]));
    for (const parent of ["D4M_ONLY", "SWINGLINE_ONLY"]) {
      const parentIds = idx[parent];
      const parentVals = Float64Array.from(parentIds.map((i) => realCosted[i]));
      testC[parent] = {
        both_n: bothIds.length,
        parent_n: parentIds.length,
        both_costed_mean_pct: bothMean * 100,
        parent_costed_mean_pct: mean(parentIds.map((i) => realCosted[i])) * 100,
        p: subsetPermutationP(parentVals, bothIds.length, bothMean, rngC, ITERATIONS),
      };
    }
  } else {
    testC.tooThin = true;
    testC.both_n = bothIds.length;
  }

  return {
    independence: { n11_both: n11, n10_d4m_only: n10, n01_swing_only: n01, n00_neither: n00, phi },
    descriptive, testA, testB, testC,
  };
}

async function main() {
  const costParams = { takerFeePct: FEE_TIERS.bitunix_futures_vip1.takerFeePct, fundingPctPerHour: REPRESENTATIVE_FUNDING_PCT_PER_HOUR };
  const smcDb = new DatabaseSync(SMC_DB_PATH, { readOnly: true });
  const d4mDb = new DatabaseSync(D4M_DB_PATH, { readOnly: true });

  const results = [];
  for (const tf of TFS) {
    process.stderr.write(`  computing ${tf}...\n`);
    results.push(await analyzeTimeframe(tf, smcDb, d4mDb, costParams));
  }
  smcDb.close();
  d4mDb.close();

  const fmtP = (p) => (p == null ? "  n/a " : `${p.toFixed(4)}${p < 0.05 ? "*" : " "}`);
  const fmtN = (x) => (x == null ? "n/a" : x.toFixed(4));

  console.log(`\n${"=".repeat(100)}`);
  console.log(`#123 FORMAL SIGNIFICANCE + LADDER CHECK -- swing-line vs D4M vs BOTH`);
  console.log(`${ITERATIONS} iterations, seed ${SEED}, fees ${FEE_TIERS.bitunix_futures_vip1.takerFeePct * 100}% taker (bitunix_futures_vip1)`);
  console.log(`${"=".repeat(100)}`);

  for (const scope of ["pooled", "own_tf"]) {
    const label = scope === "pooled"
      ? "POOLED D4M zones -- reproduces #110/#123/Strategy G exactly (all timeframes' lines)"
      : "OWN-TF D4M zones -- restricted to the analyzed timeframe's own lines";
    console.log(`\n${"#".repeat(100)}`);
    console.log(`## SCOPE: ${label}`);
    console.log(`${"#".repeat(100)}`);

    const S = (r) => (r.scopes ? r.scopes[scope] : null);

    console.log(`\n--- INDEPENDENCE: hasD4m x hasSwingLine over base population (checked BEFORE trusting any 3-way AND) ---`);
    console.log(`tf    baseN   both  d4m_only  swing_only  neither     phi`);
    for (const r of results) {
      const s = S(r);
      if (!s) { console.log(`${r.tf.padEnd(5)} ${String(r.baseN).padStart(5)}   (no base population)`); continue; }
      const i = s.independence;
      console.log(`${r.tf.padEnd(5)} ${String(r.baseN).padStart(5)} ${String(i.n11_both).padStart(6)} ${String(i.n10_d4m_only).padStart(9)} ${String(i.n01_swing_only).padStart(11)} ${String(i.n00_neither).padStart(8)} ${(i.phi == null ? "n/a" : i.phi.toFixed(4)).padStart(8)}`);
    }

    console.log(`\n--- DESCRIPTIVE (real side, costed) ---`);
    console.log(`tf     variant           n     win%     PF    gross%/tr  costed%/tr`);
    for (const r of results) {
      const s = S(r);
      if (!s) continue;
      for (const name of ["BASE", "D4M_ONLY", "SWINGLINE_ONLY", "BOTH"]) {
        const d = s.descriptive[name];
        if (!d || d.n === 0) continue;
        console.log(`${r.tf.padEnd(5)}  ${name.padEnd(15)} ${String(d.n).padStart(5)} ${(d.win_rate * 100).toFixed(1).padStart(7)} ${(d.profit_factor == null ? "n/a" : d.profit_factor.toFixed(2)).padStart(7)} ${fmtN(d.gross_exp_pct).padStart(11)} ${fmtN(d.costed_exp_pct).padStart(11)}${d.costed_exp_pct > 0 ? "  CLEARS" : ""}`);
      }
    }

    console.log(`\n--- TEST A: direction null (does the side call beat random? same method as #113/#114) ---`);
    console.log(`tf     variant              n   costed%/tr        p`);
    for (const r of results) {
      const s = S(r);
      if (!s) continue;
      for (const name of ["BASE", "D4M_ONLY", "SWINGLINE_ONLY", "BOTH"]) {
        const t = s.testA[name];
        if (!t) continue;
        if (t.tooThin) { console.log(`${r.tf.padEnd(5)}  ${name.padEnd(15)} ${String(t.n).padStart(6)}   (thin, <${MIN_N})`); continue; }
        console.log(`${r.tf.padEnd(5)}  ${name.padEnd(15)} ${String(t.n).padStart(6)} ${fmtN(t.real_costed_mean_pct).padStart(12)}   ${fmtP(t.p)}`);
      }
    }

    console.log(`\n--- TEST B: selection null (does the filter beat a random same-size subset of BASE?) ---`);
    console.log(`tf     variant              n   subset%/tr    base%/tr        p`);
    for (const r of results) {
      const s = S(r);
      if (!s) continue;
      for (const name of ["D4M_ONLY", "SWINGLINE_ONLY", "BOTH"]) {
        const t = s.testB[name];
        if (!t) continue;
        if (t.tooThin) { console.log(`${r.tf.padEnd(5)}  ${name.padEnd(15)} ${String(t.n).padStart(6)}   (thin, <${MIN_N})`); continue; }
        console.log(`${r.tf.padEnd(5)}  ${name.padEnd(15)} ${String(t.n).padStart(6)} ${fmtN(t.real_costed_mean_pct).padStart(12)} ${fmtN(t.base_mean_pct).padStart(11)}   ${fmtP(t.p)}`);
      }
    }

    console.log(`\n--- TEST C: CONCENTRATION null -- THE #123 QUESTION ---`);
    console.log(`Is BOTH better than an equally-sized RANDOM subset of its parent? If p is not small,`);
    console.log(`BOTH's higher mean is what shrinking the sample buys you for free, not added information.`);
    console.log(`tf     parent            both_n  parent_n   both%/tr  parent%/tr        p`);
    for (const r of results) {
      const s = S(r);
      if (!s) continue;
      if (s.testC.tooThin) { console.log(`${r.tf.padEnd(5)}  BOTH n=${s.testC.both_n} (thin, <${MIN_N})`); continue; }
      for (const parent of ["D4M_ONLY", "SWINGLINE_ONLY"]) {
        const t = s.testC[parent];
        if (!t) continue;
        console.log(`${r.tf.padEnd(5)}  ${parent.padEnd(15)} ${String(t.both_n).padStart(7)} ${String(t.parent_n).padStart(9)} ${fmtN(t.both_costed_mean_pct).padStart(10)} ${fmtN(t.parent_costed_mean_pct).padStart(11)}   ${fmtP(t.p)}`);
      }
    }
  }

  // ── Multiple-testing correction across the ladder, on test C vs D4M_ONLY (the headline) ────
  // Family = the POOLED scope, since that is the construction #123/Strategy G actually shipped.
  const family = results
    .filter((r) => r.scopes && !r.scopes.pooled.testC.tooThin && r.scopes.pooled.testC.D4M_ONLY && r.scopes.pooled.testC.D4M_ONLY.p != null)
    .map((r) => ({ tf: r.tf, p: r.scopes.pooled.testC.D4M_ONLY.p }));
  let correction = null;
  if (family.length > 0) {
    const ps = family.map((f) => f.p);
    const bonf = bonferroniCorrection(ps), holm = holmBonferroniCorrection(ps), bh = benjaminiHochbergCorrection(ps);
    correction = family.map((f, i) => ({ tf: f.tf, p: f.p, bonferroni: bonf[i].significant, holm: holm[i].significant, benjamini_hochberg: bh[i].significant }));
    console.log(`\n--- MULTIPLE-TESTING CORRECTION (test C vs D4M_ONLY, ${family.length} timeframes tested) ---`);
    console.log(`tf         raw p   Bonferroni    Holm     BH`);
    for (const c of correction) {
      console.log(`${c.tf.padEnd(6)} ${c.p.toFixed(4)}  ${(c.bonferroni ? "PASS" : "fail").padStart(10)} ${(c.holm ? "PASS" : "fail").padStart(7)} ${(c.benjamini_hochberg ? "PASS" : "fail").padStart(6)}`);
    }
  } else {
    console.log(`\n--- MULTIPLE-TESTING CORRECTION: no timeframe produced a testable test-C p-value ---`);
  }

  const RESULTS_DIR = new URL("results/", import.meta.url);
  mkdirSync(RESULTS_DIR, { recursive: true });
  const fname = `wt_anchor_swingline_significance_${new Date().toISOString().replace(/[:.]/g, "-")}.json`;
  const payload = {
    generated_at: new Date().toISOString(),
    register_row: "#126 (formal significance + ladder check on #123)",
    iterations: ITERATIONS, seed: SEED,
    fee_tier: "bitunix_futures_vip1",
    construction: { d4m_tol_pct: D4M_TOL_PCT, atr_len: ATR_LEN, atr_mult: ATR_MULT, max_hold_bars: MAX_HOLD_BARS, min_n: MIN_N },
    timeframes: results,
    multiple_testing_family_testC_vs_d4m_only: correction,
  };
  writeFileSync(new URL(fname, RESULTS_DIR), JSON.stringify(payload, null, 2));
  console.log(`\nSaved: ${new URL(fname, RESULTS_DIR).pathname.replace(/^\/([A-Z]:)/, "$1")}`);
}

main().catch((err) => { console.error("Fatal:", err); process.exit(1); });
