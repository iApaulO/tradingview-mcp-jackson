#!/usr/bin/env node
// The "profitable dynamics" layer iapaulo asked for: does the angle/break-or-hold pattern we just
// found actually correspond to a real, measurable price move -- not just an oscillator crossing?
//
// Two distinct event types, anchored differently (not the same measurement forced onto both):
//   BROKEN  (had a first adverse crossing) -- anchor = the break itself (divergence_crossings'
//            own price_at_cross, bar_idx), since that's the moment a live reader would act on.
//            Tests: does price confirm the failure -- move AGAINST the original divergence's
//            implied direction -- after the break?
//   HELD    (censored, never adversely broken within available data) -- anchor = the divergence's
//            own confirming pivot (its formation), since there's no break event to anchor to.
//            Tests: does price confirm the ORIGINAL implied direction while the line holds?
//
// signed_return = raw forward return, sign-flipped for bear-side divergences, so positive always
// means "the divergence's original implied direction was right" in both event types -- for BROKEN,
// a NEGATIVE signed_return after the break is the expected/hypothesis-confirming result (failure
// really was a failure); for HELD, POSITIVE is expected (holding really did mean continuation).
//
// Same slope terciles as angle-significance.js (computed fresh here per side, since bull/bear slope
// signs differ structurally and pooling them would mix apples and oranges -- iapaulo's own point).
// One-sample t-test per cell (null=0), same as every other forward-return test in this project.
//
// Usage: node scripts/signal-bus/cipher-b/price-outcome-significance.js [--horizons=5,10,20,40]

import { DatabaseSync } from "node:sqlite";
import { writeFileSync, mkdirSync } from "fs";
import { execSync } from "child_process";
import { loadCandles } from "../../backtest/lib/load-candles.js";

const DB_PATH = new URL("../../../data/signal-bus/cipher-b.db", import.meta.url);
const BAR_DURATION_SEC = { "1w": 604800, "1d": 86400, "4h": 14400, "3h": 10800, "2h": 7200, "1h": 3600, "15m": 900, "5m": 300 };
const LADDER_KEYS = ["1w", "1d", "4h", "3h", "2h", "1h", "15m", "5m"];

const args = Object.fromEntries(process.argv.slice(2).map((a) => a.replace(/^--/, "").split("=")));
const HORIZONS = (args.horizons || "5,10,20,40").split(",").map(Number);

function gitCommit() {
  try {
    return execSync("git rev-parse HEAD", { cwd: new URL("../../../", import.meta.url), encoding: "utf8" }).trim();
  } catch { return "unknown"; }
}

function tTestOneSample(vals) {
  const n = vals.length;
  const mean = vals.reduce((s, x) => s + x, 0) / n;
  const variance = vals.reduce((s, x) => s + (x - mean) ** 2, 0) / (n - 1);
  const se = Math.sqrt(variance / n);
  const t = se === 0 ? 0 : mean / se;
  // Two-sided p-value from t via a numeric approximation of the incomplete beta / normal fallback --
  // for the sample sizes here (hundreds to tens of thousands), the normal approximation to the
  // t-distribution is accurate to the precision this reporting needs.
  const z = Math.abs(t);
  const p = 2 * (1 - normalCdf(z));
  return { n, mean, t, p };
}
function normalCdf(z) {
  // Abramowitz-Stegun approximation.
  const b1 = 0.319381530, b2 = -0.356563782, b3 = 1.781477937, b4 = -1.821255978, b5 = 1.330274429;
  const p = 0.2316419, c = 0.39894228;
  if (z >= 0) {
    const t = 1 / (1 + p * z);
    return 1 - c * Math.exp((-z * z) / 2) * t * (t * (t * (t * (t * b5 + b4) + b3) + b2) + b1);
  }
  return 1 - normalCdf(-z);
}

async function loadAllCandles() {
  const out = {};
  for (const key of LADDER_KEYS) out[key] = await loadCandles(key);
  return out;
}

// FIXED 2026-08-08: the original version tested H0: mean(signed_return) = 0. That's the wrong null.
// signed_return flips sign for bear side, so BTC's own unconditional upward drift over this dataset
// (real, and large -- +52.9% at N40 on 1w, +6.6% at N40 on 1d, still +0.73% at N40 on 3h) gets ADDED
// to every bull cell and SUBTRACTED from every bear cell regardless of anything the divergence/
// crossing pattern actually contributed. That's why bear-broken looked like a clean, consistent,
// steepness-independent "failure confirmed" effect while bull-broken looked weak: bear-broken was
// riding the same secular drift bull-broken was fighting against, not showing a real asymmetry in
// how divergences behave. The correct null is H0: mean(signed_return) = baseline drift for that
// timeframe/horizon, i.e. test EXCESS return over what a random long/short would have earned anyway.
function computeBaseline(candlesByTf, horizons) {
  const baseline = {};
  for (const key of LADDER_KEYS) {
    const candles = candlesByTf[key];
    baseline[key] = {};
    for (const h of horizons) {
      let sum = 0, count = 0;
      for (let i = 0; i + h < candles.length; i++) {
        sum += candles[i + h].c / candles[i].c - 1;
        count++;
      }
      baseline[key][h] = count ? sum / count : 0;
    }
  }
  return baseline;
}

function loadEvents(db) {
  const divs = db.prepare(
    "SELECT id, timeframe, source, side, hidden, slope, bar_idx as barIdx FROM divergences",
  ).all();
  const crossingStmt = db.prepare(
    "SELECT bar_idx as barIdx, price_at_cross as price, direction FROM divergence_crossings WHERE divergence_id = ? ORDER BY crossing_num ASC",
  );
  const events = [];
  for (const d of divs) {
    const adverseDirection = d.slope > 0 ? "above_to_below" : "below_to_above";
    const crossings = crossingStmt.all(d.id);
    const firstAdverse = crossings.find((c) => c.direction === adverseDirection);
    events.push({
      timeframe: d.timeframe, source: d.source, side: d.side, hidden: !!d.hidden,
      slopePerDay: Math.abs(d.slope) * (86400 / BAR_DURATION_SEC[d.timeframe]),
      outcomeType: firstAdverse ? "broken" : "held",
      anchorBarIdx: firstAdverse ? firstAdverse.barIdx : d.barIdx,
    });
  }
  return events;
}

function slopeTercileLabel(rows, row) {
  // Computed once by the caller via precomputed thresholds -- see assignTerciles.
  return row._tercile;
}
function assignTerciles(rows) {
  const sorted = [...rows].sort((a, b) => a.slopePerDay - b.slopePerDay);
  const third = Math.floor(sorted.length / 3);
  sorted.forEach((r, i) => { r._tercile = i < third ? "shallow" : i < 2 * third ? "mid" : "steep"; });
}

export async function runPriceOutcomeTest({ horizons = HORIZONS } = {}) {
  const db = new DatabaseSync(DB_PATH, { readOnly: true });
  const events = loadEvents(db);
  db.close();

  const candlesByTf = await loadAllCandles();
  const baseline = computeBaseline(candlesByTf, horizons);

  // Compute signed returns per event per horizon, both raw (kept for transparency/comparison against
  // the earlier buggy run) and excess-over-baseline (the actually valid test -- see computeBaseline).
  for (const e of events) {
    const candles = candlesByTf[e.timeframe];
    const anchorPrice = candles[e.anchorBarIdx]?.c;
    e.returns = {};
    e.excessReturns = {};
    if (anchorPrice == null) continue;
    for (const h of horizons) {
      const futureBar = candles[e.anchorBarIdx + h];
      if (!futureBar) continue;
      const raw = futureBar.c / anchorPrice - 1;
      const excessRaw = raw - baseline[e.timeframe][h];
      e.returns[h] = e.side === "bull" ? raw : -raw;
      e.excessReturns[h] = e.side === "bull" ? excessRaw : -excessRaw;
    }
  }

  // Terciles computed separately per (side, outcomeType) -- bull/bear slope signs are structurally
  // different (established in angle-significance.js), and broken/held populations aren't comparable
  // either (censoring itself correlates with slope, so pooling would reintroduce the same bias).
  // FIXED 2026-08-08: terciles computed per (side, outcomeType, TIMEFRAME), not globally. The
  // global version put ~all higher-timeframe events in "shallow" by the pooled cutoffs, since 5m/15m
  // dominate the pooled distribution by sheer count even after per-day normalization -- normalizing
  // the slope's UNITS doesn't normalize the SHAPE of each timeframe's own slope distribution, so
  // pooled tercile boundaries were really just 5m/15m's boundaries. Computing within each timeframe
  // is what "steep relative to its own timeframe" actually requires.
  const groups = {};
  for (const e of events) {
    const key = `${e.side}_${e.outcomeType}_${e.timeframe}`;
    (groups[key] ||= []).push(e);
  }
  for (const key of Object.keys(groups)) assignTerciles(groups[key]);

  const results = [];
  for (const side of ["bull", "bear"]) {
    for (const outcomeType of ["broken", "held"]) {
      for (const timeframe of LADDER_KEYS) {
        const rows = groups[`${side}_${outcomeType}_${timeframe}`] || [];
        for (const tercile of ["shallow", "mid", "steep"]) {
          const sub = rows.filter((r) => r._tercile === tercile);
          const cell = { side, outcomeType, timeframe, tercile, n: sub.length, horizons: {} };
          for (const h of horizons) {
            const vals = sub.map((r) => r.returns[h]).filter((v) => v != null);
            const excessVals = sub.map((r) => r.excessReturns[h]).filter((v) => v != null);
            if (vals.length < 20) { cell.horizons[h] = { n: vals.length, tooThin: true }; continue; }
            const t = tTestOneSample(vals);
            const te = tTestOneSample(excessVals);
            cell.horizons[h] = {
              n: vals.length,
              meanSignedReturn: t.mean, t: t.t, p: t.p,
              meanExcessReturn: te.mean, tExcess: te.t, pExcess: te.p,
            };
          }
          results.push(cell);
        }
      }
    }
  }
  return { totalEvents: events.length, horizons, baseline, results };
}

function main() {
  runPriceOutcomeTest({ horizons: HORIZONS }).then((out) => {
    console.log(`${out.totalEvents.toLocaleString()} total divergence events.\n`);

    console.log("=== Unconditional baseline drift (mean forward return, ALL bars, no divergence conditioning) ===");
    console.log(
      "tf".padEnd(6) + out.horizons.map((h) => `N${h}`.padEnd(12)).join(""),
    );
    for (const tf of LADDER_KEYS) {
      console.log(tf.padEnd(6) + out.horizons.map((h) => `${(out.baseline[tf][h] * 100).toFixed(3)}%`.padEnd(12)).join(""));
    }
    console.log("\nCells below report EXCESS signed return over this baseline (the valid test) with raw signed return in brackets for comparison.\n");

    for (const timeframe of LADDER_KEYS) {
      console.log(`=== ${timeframe} ===`);
      console.log(
        "side".padEnd(6) + "outcome".padEnd(9) + "tercile".padEnd(9) + "n".padEnd(8) +
        out.horizons.map((h) => `N${h}`.padEnd(34)).join(""),
      );
      for (const r of out.results.filter((r) => r.timeframe === timeframe)) {
        let line = r.side.padEnd(6) + r.outcomeType.padEnd(9) + r.tercile.padEnd(9) + String(r.n).padEnd(8);
        for (const h of out.horizons) {
          const c = r.horizons[h];
          if (!c || c.tooThin) { line += `thin(n=${c ? c.n : 0})`.padEnd(34); continue; }
          const star = c.pExcess < 0.05 ? "*" : "";
          const excessStr = `${(c.meanExcessReturn * 100).toFixed(2)}%(p=${c.pExcess.toFixed(3)}${star})`;
          const rawStr = `[raw ${(c.meanSignedReturn * 100).toFixed(2)}%]`;
          line += `${excessStr} ${rawStr}`.padEnd(34);
        }
        console.log(line);
      }
      console.log("");
    }

    const RESULTS_DIR = new URL("results/", import.meta.url);
    mkdirSync(RESULTS_DIR, { recursive: true });
    const payload = { ...out, git_commit: gitCommit(), generated_at: new Date().toISOString() };
    const fname = `price_outcome_significance_${payload.generated_at.replace(/[:.]/g, "-")}.json`;
    writeFileSync(new URL(fname, RESULTS_DIR), JSON.stringify(payload, null, 2));
    console.log(`\nSaved: ${new URL(fname, RESULTS_DIR).pathname.replace(/^\/([A-Z]:)/, "$1")}`);
  });
}

main();
