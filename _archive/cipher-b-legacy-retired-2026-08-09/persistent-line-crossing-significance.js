#!/usr/bin/env node
// Third attempt at the pattern iapaulo pointed at, this time actually matching the description: "wt2
// crossing IT [the same, single, persistent line] numerous times" -- not the next divergence's
// relationship to it (compound-confluence-significance.js, tested null on daily) and not a single
// divergence's own first-adverse-crossing capped at a 40-bar window (angle/cross-recross-
// significance.js). Every crossing along a divergence's full projected life is already stored
// (divergence_crossings -- crossings.js records ALL of them, not just the first, specifically
// because a line can be broken/retested many times, which is exactly what the real 453372 example
// does: 10 crossings, 1/3/26 through 7/25/26). This tests EVERY crossing as its own anchor, split by
// direction, using the MFE-over-long-window metric (not a 40-bar cap) since that's what it took to
// see the real -37.5% move in the verified worked example.
//
// Scoped to daily, bear, wt+wt2nd by default -- exactly the population the real example lives in --
// but left configurable since this is the third framing of the same idea and shouldn't be
// hand-tuned to only reproduce the one anecdote.
//
// Usage: node scripts/signal-bus/cipher-b/persistent-line-crossing-significance.js [--timeframe=1d] [--side=bear] [--source=wt,wt2nd] [--window=160]

import { DatabaseSync } from "node:sqlite";
import { writeFileSync, mkdirSync } from "fs";
import { execSync } from "child_process";
import { loadCandles } from "../../backtest/lib/load-candles.js";

const DB_PATH = new URL("../../../data/signal-bus/cipher-b.db", import.meta.url);
const HORIZONS = [5, 10, 20, 40];

const args = Object.fromEntries(process.argv.slice(2).map((a) => a.replace(/^--/, "").split("=")));
const TIMEFRAME = args.timeframe || "1d";
const SIDE = args.side || "bear";
const SOURCES = (args.source || "wt,wt2nd").split(",");
const WINDOW = parseInt(args.window || "160", 10);

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
function welchTTest(a, b) {
  const na = a.length, nb = b.length;
  const ma = mean(a), mb = mean(b);
  const va = variance(a, ma), vb = variance(b, mb);
  const se = Math.sqrt(va / na + vb / nb);
  const t = se === 0 ? 0 : (ma - mb) / se;
  return { na, nb, meanA: ma, meanB: mb, t, p: 2 * (1 - normalCdf(Math.abs(t))) };
}

function computeMfeBaseline(candles, window, direction) {
  const vals = [];
  for (let i = 0; i + window < candles.length; i += 5) {
    const anchor = candles[i].c;
    let best = direction === "up" ? -Infinity : Infinity;
    for (let j = i + 1; j <= i + window; j++) {
      const c = candles[j].c;
      if (direction === "up" ? c > best : c < best) best = c;
    }
    vals.push(direction === "up" ? best / anchor - 1 : 1 - best / anchor);
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
  return { mfe: direction === "up" ? best / anchor - 1 : 1 - best / anchor, bars: bestIdx - anchorBarIdx };
}

function loadCrossingEvents(db, timeframe, side, sources) {
  const placeholders = sources.map(() => "?").join(",");
  const rows = db.prepare(`
    SELECT d.id as divId, d.slope as slope, c.crossing_num as crossingNum, c.bar_idx as barIdx, c.direction as direction
    FROM divergence_crossings c
    JOIN divergences d ON d.id = c.divergence_id
    WHERE d.timeframe = ? AND d.side = ? AND d.source IN (${placeholders})
    ORDER BY c.bar_idx ASC
  `).all(timeframe, side, ...sources);

  return rows.map((r) => {
    const favorableDirection = r.slope > 0 ? "below_to_above" : "above_to_below";
    return {
      divId: r.divId, crossingNum: r.crossingNum, barIdx: r.barIdx,
      isFavorable: r.direction === favorableDirection,
    };
  });
}

export async function runPersistentLineCrossingTest({ timeframe = TIMEFRAME, side = SIDE, sources = SOURCES, window = WINDOW } = {}) {
  const direction = side === "bull" ? "up" : "down";
  const candles = await loadCandles(timeframe);
  const db = new DatabaseSync(DB_PATH, { readOnly: true });
  const crossings = loadCrossingEvents(db, timeframe, side, sources);
  db.close();

  const mfeBaseline = computeMfeBaseline(candles, window, direction);
  const baselineStats = tTestOneSample(mfeBaseline);

  const adverse = [], favorable = [];
  for (const c of crossings) {
    const r = mfeForEvent(candles, c.barIdx, window, direction);
    if (!r) continue;
    const fixed = {};
    for (const h of HORIZONS) {
      const anchor = candles[c.barIdx]?.c;
      const fut = candles[c.barIdx + h]?.c;
      if (anchor != null && fut != null) {
        const raw = fut / anchor - 1;
        fixed[h] = side === "bull" ? raw : -raw;
      }
    }
    (c.isFavorable ? favorable : adverse).push({ mfe: r.mfe, bars: r.bars, fixed, crossingNum: c.crossingNum });
  }

  const result = {
    timeframe, side, sources, window,
    baselineMfeMean: baselineStats.mean, baselineN: mfeBaseline.length,
    nAdverse: adverse.length, nFavorable: favorable.length,
  };

  if (adverse.length >= 10 && favorable.length >= 10) {
    const comparison = welchTTest(adverse.map((r) => r.mfe), favorable.map((r) => r.mfe));
    result.adverseMeanMfe = comparison.meanA;
    result.favorableMeanMfe = comparison.meanB;
    result.adverseVsFavorable_t = comparison.t;
    result.adverseVsFavorable_p = comparison.p;
    result.adverseMeanBarsToExtreme = mean(adverse.map((r) => r.bars));
    result.favorableMeanBarsToExtreme = mean(favorable.map((r) => r.bars));
    result.horizons = {};
    for (const h of HORIZONS) {
      const av = adverse.map((r) => r.fixed[h]).filter((v) => v != null);
      const fv = favorable.map((r) => r.fixed[h]).filter((v) => v != null);
      if (av.length >= 10 && fv.length >= 10) {
        const c = welchTTest(av, fv);
        result.horizons[h] = { meanAdverse: c.meanA, meanFavorable: c.meanB, t: c.t, p: c.p };
      }
    }
    // Also: does it matter how deep into the line's life the crossing is? Early crossings
    // (crossingNum 1-2) vs later ones (3+), adverse-only (that's where the real example's big move sat).
    const adverseEarly = adverse.filter((r) => r.crossingNum <= 2);
    const adverseLate = adverse.filter((r) => r.crossingNum > 2);
    if (adverseEarly.length >= 10 && adverseLate.length >= 10) {
      const c = welchTTest(adverseEarly.map((r) => r.mfe), adverseLate.map((r) => r.mfe));
      result.adverseEarlyVsLate = { nEarly: adverseEarly.length, nLate: adverseLate.length, meanEarly: c.meanA, meanLate: c.meanB, t: c.t, p: c.p };
    }
  } else {
    result.tooThin = true;
  }

  return result;
}

function main() {
  runPersistentLineCrossingTest({ timeframe: TIMEFRAME, side: SIDE, sources: SOURCES, window: WINDOW }).then((r) => {
    console.log(`Persistent-line crossing test -- ${r.side} / ${r.timeframe} / sources=${r.sources.join(",")} / window=${r.window}\n`);
    console.log(`Unconditional MFE baseline (n=${r.baselineN}): ${(r.baselineMfeMean * 100).toFixed(2)}%\n`);
    if (r.tooThin) {
      console.log(`Too thin: nAdverse=${r.nAdverse} nFavorable=${r.nFavorable}`);
    } else {
      const star = r.adverseVsFavorable_p < 0.05 ? "*" : "";
      console.log(`Adverse crossings   (n=${r.nAdverse}): MFE=${(r.adverseMeanMfe * 100).toFixed(2)}% (bars to extreme ~${r.adverseMeanBarsToExtreme.toFixed(0)})`);
      console.log(`Favorable crossings (n=${r.nFavorable}): MFE=${(r.favorableMeanMfe * 100).toFixed(2)}% (bars to extreme ~${r.favorableMeanBarsToExtreme.toFixed(0)})`);
      console.log(`Adverse vs favorable MFE: t=${r.adverseVsFavorable_t.toFixed(3)} p=${r.adverseVsFavorable_p.toFixed(3)}${star}\n`);
      console.log("Fixed-horizon excess return (adverse vs favorable, Welch t-test):");
      for (const h of HORIZONS) {
        const c = r.horizons[h];
        if (!c) continue;
        const s = c.p < 0.05 ? "*" : "";
        console.log(`  N${h}: adverse=${(c.meanAdverse * 100).toFixed(2)}% favorable=${(c.meanFavorable * 100).toFixed(2)}% (p=${c.p.toFixed(3)}${s})`);
      }
      if (r.adverseEarlyVsLate) {
        const e = r.adverseEarlyVsLate;
        const s = e.p < 0.05 ? "*" : "";
        console.log(`\nAmong adverse crossings -- early (crossing #1-2, n=${e.nEarly}) vs late (#3+, n=${e.nLate}) MFE:`);
        console.log(`  early=${(e.meanEarly * 100).toFixed(2)}% late=${(e.meanLate * 100).toFixed(2)}% t=${e.t.toFixed(3)} p=${e.p.toFixed(3)}${s}`);
      }
    }

    const RESULTS_DIR = new URL("results/", import.meta.url);
    mkdirSync(RESULTS_DIR, { recursive: true });
    const payload = { ...r, git_commit: gitCommit(), generated_at: new Date().toISOString() };
    const fname = `persistent_line_crossing_significance_${r.side}_${r.timeframe}_${payload.generated_at.replace(/[:.]/g, "-")}.json`;
    writeFileSync(new URL(fname, RESULTS_DIR), JSON.stringify(payload, null, 2));
    console.log(`\nSaved: ${new URL(fname, RESULTS_DIR).pathname.replace(/^\/([A-Z]:)/, "$1")}`);
  });
}

main();
