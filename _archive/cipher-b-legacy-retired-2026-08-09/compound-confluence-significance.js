#!/usr/bin/env node
// Tests the actual pattern iapaulo pointed at: NOT a divergence's own line getting crossed/recrossed
// (cross-recross-significance.js, tested null on both sides), but whether a NEW divergence forming
// while an OLDER divergence's still-projected line is on its favorable side ("reinforcing") predicts
// a bigger move than one forming after that older line has already been breached ("post-break").
//
// Verified worked example this is modeled on (real data, not the live chart alone): bear WT/WT2nd
// divergence id 453372 (10/29/25 -> 12/12/25). The next same-source bear divergence (453374/453375,
// confirmed 1/18/26) formed ABOVE that still-active line -- "reinforcing". Price then fell from
// 93,633 to a 200-bar low of 58,524 -- **-37.5% over 163 bars**. My first pass at this only measured
// fixed N5/N10/N20/N40 horizons and reported -26% at N20 -- a real understatement of the actual
// multi-month move iapaulo was looking at on the chart. Fixed here: MFE (max favorable excursion)
// over a long window is measured alongside the short fixed horizons, specifically so a real
// regime-scale continuation isn't truncated by an arbitrarily short measurement window.
//
// Reference line = the immediately preceding same-source, same-side, same-timeframe divergence.
// "Reinforcing" = new divergence's own pivot sits on the reference line's FAVORABLE side (matching
// the reference's own slope sign, same convention as angle-significance.js). "Post-break" = it sits
// on the adverse side (the older line was already breached by the time the new one formed).
//
// Two comparisons reported per cell, both against a real baseline (not against zero -- MFE over a
// long window is trivially "significant" vs zero purely from volatility, so that's the wrong null):
//   1. reinforcing vs post-break (Welch two-sample t-test, unequal variance)
//   2. each group vs unconditional MFE (same window, same direction, ALL bars -- "what you'd get from
//      BTC's volatility alone with zero signal")
//
// Usage: node scripts/signal-bus/cipher-b/compound-confluence-significance.js [--window=160] [--source=wt,wt2nd]

import { DatabaseSync } from "node:sqlite";
import { writeFileSync, mkdirSync } from "fs";
import { execSync } from "child_process";
import { loadCandles } from "../../backtest/lib/load-candles.js";

const DB_PATH = new URL("../../../data/signal-bus/cipher-b.db", import.meta.url);
const LADDER_KEYS = ["1w", "1d", "4h", "3h", "2h", "1h", "15m", "5m"];
const HORIZONS = [5, 10, 20, 40];

const args = Object.fromEntries(process.argv.slice(2).map((a) => a.replace(/^--/, "").split("=")));
const WINDOW = parseInt(args.window || "160", 10);
const SOURCES = (args.source || "wt,wt2nd").split(",");

function gitCommit() {
  try {
    return execSync("git rev-parse HEAD", { cwd: new URL("../../../", import.meta.url), encoding: "utf8" }).trim();
  } catch { return "unknown"; }
}
function mean(vals) { return vals.reduce((s, x) => s + x, 0) / vals.length; }
function variance(vals, m) { return vals.reduce((s, x) => s + (x - m) ** 2, 0) / (vals.length - 1); }
function normalCdf(z) {
  const b1 = 0.319381530, b2 = -0.356563782, b3 = 1.781477937, b4 = -1.821255978, b5 = 1.330274429;
  const p = 0.2316419, c = 0.39894228;
  if (z >= 0) {
    const t = 1 / (1 + p * z);
    return 1 - c * Math.exp((-z * z) / 2) * t * (t * (t * (t * (t * b5 + b4) + b3) + b2) + b1);
  }
  return 1 - normalCdf(-z);
}
function tTestOneSample(vals) {
  const n = vals.length, m = mean(vals);
  const se = Math.sqrt(variance(vals, m) / n);
  const t = se === 0 ? 0 : m / se;
  return { n, mean: m, t, p: 2 * (1 - normalCdf(Math.abs(t))) };
}
// Welch's t-test -- unequal variance, unequal n, the correct two-sample test here since the
// reinforcing/post-break groups differ a lot in both size and spread.
function welchTTest(a, b) {
  const na = a.length, nb = b.length;
  const ma = mean(a), mb = mean(b);
  const va = variance(a, ma), vb = variance(b, mb);
  const se = Math.sqrt(va / na + vb / nb);
  const t = se === 0 ? 0 : (ma - mb) / se;
  const p = 2 * (1 - normalCdf(Math.abs(t)));
  return { na, nb, meanA: ma, meanB: mb, t, p };
}

async function loadAllCandles() {
  const out = {};
  for (const key of LADDER_KEYS) out[key] = await loadCandles(key);
  return out;
}

// Unconditional MFE baseline: for a random anchor bar, the max favorable excursion (in the given
// direction) over the next WINDOW bars, sampled across ALL bars in the timeframe. This is the
// "you'd get this from volatility alone" comparison -- same reasoning as computeBaseline() in
// price-outcome-significance.js, generalized from mean-return to max-favorable-excursion.
function computeMfeBaseline(candles, window, direction) {
  const vals = [];
  for (let i = 0; i + window < candles.length; i += 5) { // stride 5 for speed -- baseline is a distribution, not per-event
    const anchor = candles[i].c;
    let best = direction === "up" ? -Infinity : Infinity;
    for (let j = i + 1; j <= i + window; j++) {
      const c = candles[j].c;
      if (direction === "up" ? c > best : c < best) best = c;
    }
    const mfe = direction === "up" ? best / anchor - 1 : 1 - best / anchor;
    vals.push(mfe);
  }
  return vals;
}

function mfeForEvent(candles, anchorBarIdx, window, direction) {
  const anchor = candles[anchorBarIdx]?.c;
  if (anchor == null) return null;
  let best = direction === "up" ? -Infinity : Infinity;
  let bestIdx = anchorBarIdx;
  for (let j = anchorBarIdx + 1; j <= Math.min(anchorBarIdx + window, candles.length - 1); j++) {
    const c = candles[j].c;
    if (direction === "up" ? c > best : c < best) { best = c; bestIdx = j; }
  }
  if (best === -Infinity || best === Infinity) return null;
  const mfe = direction === "up" ? best / anchor - 1 : 1 - best / anchor;
  return { mfe, bars: bestIdx - anchorBarIdx };
}

function loadClassified(db, timeframe, side, source) {
  const divs = db.prepare(
    "SELECT id, slope, bar_idx as barIdx, osc_val as oscVal, confirm_bar_idx as confirmBarIdx FROM divergences " +
    "WHERE timeframe = ? AND side = ? AND source = ? ORDER BY confirm_bar_idx ASC",
  ).all(timeframe, side, source);

  const out = [];
  for (let i = 1; i < divs.length; i++) {
    const ref = divs[i - 1];
    const cur = divs[i];
    const m = ref.slope;
    const b = ref.oscVal - m * ref.barIdx;
    const projected = m * cur.barIdx + b;
    const refFavorableIsAbove = ref.slope > 0;
    const curIsAbove = cur.oscVal > projected;
    const reinforcing = curIsAbove === refFavorableIsAbove;
    out.push({ confirmBarIdx: cur.confirmBarIdx, reinforcing });
  }
  return out;
}

export async function runCompoundConfluenceTest({ window = WINDOW, sources = SOURCES } = {}) {
  const candlesByTf = await loadAllCandles();
  const db = new DatabaseSync(DB_PATH, { readOnly: true });

  const results = [];
  for (const side of ["bull", "bear"]) {
    const direction = side === "bull" ? "up" : "down";
    for (const timeframe of LADDER_KEYS) {
      const candles = candlesByTf[timeframe];
      const mfeBaseline = computeMfeBaseline(candles, window, direction);
      const baselineStats = tTestOneSample(mfeBaseline); // just for baseline mean, p not meaningful here

      let all = [];
      for (const source of sources) all = all.concat(loadClassified(db, timeframe, side, source));

      const reinforcing = [], postBreak = [];
      for (const e of all) {
        const r = mfeForEvent(candles, e.confirmBarIdx, window, direction);
        if (!r) continue;
        const fixed = {};
        for (const h of HORIZONS) {
          const anchor = candles[e.confirmBarIdx]?.c;
          const fut = candles[e.confirmBarIdx + h]?.c;
          if (anchor != null && fut != null) {
            const raw = fut / anchor - 1;
            fixed[h] = side === "bull" ? raw : -raw;
          }
        }
        (e.reinforcing ? reinforcing : postBreak).push({ mfe: r.mfe, bars: r.bars, fixed });
      }

      const cell = {
        side, timeframe, window,
        baselineMfeMean: baselineStats.mean, baselineN: mfeBaseline.length,
        nReinforcing: reinforcing.length, nPostBreak: postBreak.length,
      };
      if (reinforcing.length >= 10 && postBreak.length >= 10) {
        const comparison = welchTTest(reinforcing.map((r) => r.mfe), postBreak.map((r) => r.mfe));
        cell.reinforcingMeanMfe = comparison.meanA;
        cell.postBreakMeanMfe = comparison.meanB;
        cell.reinforcingVsPostBreak_t = comparison.t;
        cell.reinforcingVsPostBreak_p = comparison.p;
        cell.reinforcingMeanBarsToExtreme = mean(reinforcing.map((r) => r.bars));
        cell.postBreakMeanBarsToExtreme = mean(postBreak.map((r) => r.bars));
        for (const h of HORIZONS) {
          const rv = reinforcing.map((r) => r.fixed[h]).filter((v) => v != null);
          const pv = postBreak.map((r) => r.fixed[h]).filter((v) => v != null);
          if (rv.length >= 10 && pv.length >= 10) {
            const c = welchTTest(rv, pv);
            cell[`n${h}`] = { meanReinforcing: c.meanA, meanPostBreak: c.meanB, t: c.t, p: c.p };
          }
        }
      } else {
        cell.tooThin = true;
      }
      results.push(cell);
    }
  }
  db.close();
  return { window, sources, results };
}

function main() {
  runCompoundConfluenceTest({ window: WINDOW, sources: SOURCES }).then((out) => {
    console.log(`Compound confluence test -- window=${out.window} bars, sources=${out.sources.join(",")}\n`);
    for (const r of out.results) {
      console.log(`=== ${r.side} / ${r.timeframe} ===`);
      console.log(`  unconditional MFE baseline (n=${r.baselineN}, window=${r.window}): ${(r.baselineMfeMean * 100).toFixed(2)}%`);
      if (r.tooThin) {
        console.log(`  too thin: nReinforcing=${r.nReinforcing} nPostBreak=${r.nPostBreak}\n`);
        continue;
      }
      const star = r.reinforcingVsPostBreak_p < 0.05 ? "*" : "";
      console.log(
        `  reinforcing (n=${r.nReinforcing}): MFE=${(r.reinforcingMeanMfe * 100).toFixed(2)}% (bars to extreme ~${r.reinforcingMeanBarsToExtreme.toFixed(0)})`,
      );
      console.log(
        `  post-break  (n=${r.nPostBreak}): MFE=${(r.postBreakMeanMfe * 100).toFixed(2)}% (bars to extreme ~${r.postBreakMeanBarsToExtreme.toFixed(0)})`,
      );
      console.log(`  reinforcing vs post-break MFE: t=${r.reinforcingVsPostBreak_t.toFixed(3)} p=${r.reinforcingVsPostBreak_p.toFixed(3)}${star}`);
      for (const h of HORIZONS) {
        const c = r[`n${h}`];
        if (!c) continue;
        const s = c.p < 0.05 ? "*" : "";
        console.log(`    N${h}: reinforcing=${(c.meanReinforcing * 100).toFixed(2)}% postBreak=${(c.meanPostBreak * 100).toFixed(2)}% (p=${c.p.toFixed(3)}${s})`);
      }
      console.log("");
    }

    const RESULTS_DIR = new URL("results/", import.meta.url);
    mkdirSync(RESULTS_DIR, { recursive: true });
    const payload = { ...out, git_commit: gitCommit(), generated_at: new Date().toISOString() };
    const fname = `compound_confluence_significance_${payload.generated_at.replace(/[:.]/g, "-")}.json`;
    writeFileSync(new URL(fname, RESULTS_DIR), JSON.stringify(payload, null, 2));
    console.log(`Saved: ${new URL(fname, RESULTS_DIR).pathname.replace(/^\/([A-Z]:)/, "$1")}`);
  });
}

main();
