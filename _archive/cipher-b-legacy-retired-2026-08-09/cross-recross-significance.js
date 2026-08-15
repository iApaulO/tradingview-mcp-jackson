#!/usr/bin/env node
// Tests the actual pattern iapaulo pointed at directly: not "does a line get adversely crossed"
// (angle-significance.js) and not "does a broken/held line's own price move confirm or deny it"
// (price-outcome-significance.js) -- but the CROSS-RECROSS itself. The real worked example this is
// modeled on: the Cipher B WT line from 6/6, broken (fell through) on ~7/31, then RETESTED back
// through the same line on ~8/6-8/7 to form a new HL. iapaulo's read is that the recross -- price/
// oscillator crossing back through the line after having broken it -- is where the value is, not
// the break itself and not the raw hold/fail dichotomy.
//
// Scoped first to bull, horizontal (shallow-tercile) divergences specifically, per instruction to
// "start with that" -- the population where price-outcome-significance.js already showed the highest
// failure rate (~90% never hold), so if a recross-back is a real, tradeable reclaim signal it should
// show up clearest here.
//
// Three anchors compared side by side, same population, same excess-return methodology (baseline
// drift subtracted, see price-outcome-significance.js's fix -- this file reuses that same logic
// rather than re-deriving it, since the drift confound applies identically here):
//   held            -- never adversely crossed at all. anchor = divergence's own confirm_bar_idx.
//   broken_only     -- adversely crossed, but no subsequent favorable recross in available data.
//                      anchor = the (first) adverse crossing's bar_idx.
//   broken_recrossed -- adversely crossed, THEN crossed back favorable. anchor = that recross's
//                      bar_idx -- the actual event under test.
//
// Terciles assigned per (side, timeframe) only -- NOT per outcome, since "horizontal" has to be
// knowable before we know whether the line held/broke/recrossed (it's a property of the line at
// formation, not a label attached after the fact).
//
// Usage: node scripts/signal-bus/cipher-b/cross-recross-significance.js [--horizons=5,10,20,40] [--side=bull]

import { DatabaseSync } from "node:sqlite";
import { writeFileSync, mkdirSync } from "fs";
import { execSync } from "child_process";
import { loadCandles } from "../../backtest/lib/load-candles.js";

const DB_PATH = new URL("../../../data/signal-bus/cipher-b.db", import.meta.url);
const BAR_DURATION_SEC = { "1w": 604800, "1d": 86400, "4h": 14400, "3h": 10800, "2h": 7200, "1h": 3600, "15m": 900, "5m": 300 };
const LADDER_KEYS = ["1w", "1d", "4h", "3h", "2h", "1h", "15m", "5m"];

const args = Object.fromEntries(process.argv.slice(2).map((a) => a.replace(/^--/, "").split("=")));
const HORIZONS = (args.horizons || "5,10,20,40").split(",").map(Number);
const SIDE = args.side || "bull";

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
  const p = 2 * (1 - normalCdf(Math.abs(t)));
  return { n, mean, t, p };
}
function normalCdf(z) {
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

// Same drift confound as price-outcome-significance.js -- see that file's header for the full
// explanation. Netting this out is not optional here either: bull-side signed_return === raw
// return, so it rides the same unconditional upward drift the fix there had to remove.
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

function loadEvents(db, side) {
  const divs = db.prepare(
    "SELECT id, timeframe, source, side, hidden, slope, confirm_bar_idx as barIdx FROM divergences WHERE side = ?",
  ).all(side);
  const crossingStmt = db.prepare(
    "SELECT crossing_num, bar_idx as barIdx, direction FROM divergence_crossings WHERE divergence_id = ? ORDER BY crossing_num ASC",
  );

  const events = [];
  for (const d of divs) {
    const adverseDirection = d.slope > 0 ? "above_to_below" : "below_to_above";
    const favorableDirection = d.slope > 0 ? "below_to_above" : "above_to_below";
    const crossings = crossingStmt.all(d.id);
    const firstAdverseIdx = crossings.findIndex((c) => c.direction === adverseDirection);

    let classification, anchorBarIdx;
    if (firstAdverseIdx === -1) {
      classification = "held";
      anchorBarIdx = d.barIdx;
    } else {
      const recross = crossings.slice(firstAdverseIdx + 1).find((c) => c.direction === favorableDirection);
      if (recross) {
        classification = "broken_recrossed";
        anchorBarIdx = recross.barIdx;
      } else {
        classification = "broken_only";
        anchorBarIdx = crossings[firstAdverseIdx].barIdx;
      }
    }

    events.push({
      timeframe: d.timeframe, source: d.source, hidden: !!d.hidden,
      slopePerDay: Math.abs(d.slope) * (86400 / BAR_DURATION_SEC[d.timeframe]),
      classification, anchorBarIdx,
    });
  }
  return events;
}

function assignTerciles(rows) {
  const sorted = [...rows].sort((a, b) => a.slopePerDay - b.slopePerDay);
  const third = Math.floor(sorted.length / 3);
  sorted.forEach((r, i) => { r._tercile = i < third ? "shallow" : i < 2 * third ? "mid" : "steep"; });
}

export async function runCrossRecrossTest({ horizons = HORIZONS, side = SIDE } = {}) {
  const db = new DatabaseSync(DB_PATH, { readOnly: true });
  const events = loadEvents(db, side);
  db.close();

  const candlesByTf = await loadAllCandles();
  const baseline = computeBaseline(candlesByTf, horizons);

  for (const e of events) {
    const candles = candlesByTf[e.timeframe];
    const anchorPrice = candles[e.anchorBarIdx]?.c;
    e.excessReturns = {};
    if (anchorPrice == null) continue;
    for (const h of horizons) {
      const futureBar = candles[e.anchorBarIdx + h];
      if (!futureBar) continue;
      const raw = futureBar.c / anchorPrice - 1;
      // side is fixed (loaded per-side), so signed === raw for bull, -raw for bear -- no per-row
      // branch needed, but keep it explicit rather than assuming bull.
      const signed = side === "bull" ? raw : -raw;
      e.excessReturns[h] = signed - (side === "bull" ? baseline[e.timeframe][h] : -baseline[e.timeframe][h]);
    }
  }

  // Terciles per timeframe only (side is already fixed for the whole run) -- "horizontal" has to be
  // a property of the line itself, not of an outcome that hasn't happened yet.
  const byTf = {};
  for (const e of events) (byTf[e.timeframe] ||= []).push(e);
  for (const tf of Object.keys(byTf)) assignTerciles(byTf[tf]);

  const results = [];
  const rates = [];
  for (const timeframe of LADDER_KEYS) {
    const rows = byTf[timeframe] || [];
    for (const tercile of ["shallow", "mid", "steep"]) {
      const sub = rows.filter((r) => r._tercile === tercile);
      const held = sub.filter((r) => r.classification === "held");
      const brokenOnly = sub.filter((r) => r.classification === "broken_only");
      const recrossed = sub.filter((r) => r.classification === "broken_recrossed");
      const brokenTotal = brokenOnly.length + recrossed.length;
      rates.push({
        timeframe, tercile, n: sub.length,
        heldPct: sub.length ? (held.length / sub.length) * 100 : null,
        brokenOnlyPct: sub.length ? (brokenOnly.length / sub.length) * 100 : null,
        recrossedPct: sub.length ? (recrossed.length / sub.length) * 100 : null,
        recrossedOfBrokenPct: brokenTotal ? (recrossed.length / brokenTotal) * 100 : null,
      });
      for (const [classification, group] of [["held", held], ["broken_only", brokenOnly], ["broken_recrossed", recrossed]]) {
        const cell = { timeframe, tercile, classification, n: group.length, horizons: {} };
        for (const h of horizons) {
          const vals = group.map((r) => r.excessReturns[h]).filter((v) => v != null);
          if (vals.length < 20) { cell.horizons[h] = { n: vals.length, tooThin: true }; continue; }
          const t = tTestOneSample(vals);
          cell.horizons[h] = { n: vals.length, meanExcessReturn: t.mean, t: t.t, p: t.p };
        }
        results.push(cell);
      }
    }
  }

  return { side, totalEvents: events.length, horizons, baseline, rates, results };
}

function main() {
  runCrossRecrossTest({ horizons: HORIZONS, side: SIDE }).then((out) => {
    console.log(`${out.totalEvents.toLocaleString()} total ${out.side} divergence events.\n`);

    console.log("=== Composition: % held / broken-only / broken-then-recrossed, by tercile (horizontal = shallow) ===");
    console.log(
      "tf".padEnd(6) + "tercile".padEnd(9) + "n".padEnd(7) + "held%".padEnd(9) +
      "brokenOnly%".padEnd(13) + "recrossed%".padEnd(12) + "recrossed/broken%",
    );
    for (const r of out.rates) {
      console.log(
        r.timeframe.padEnd(6) + r.tercile.padEnd(9) + String(r.n).padEnd(7) +
        (r.heldPct == null ? "-" : r.heldPct.toFixed(1)).padEnd(9) +
        (r.brokenOnlyPct == null ? "-" : r.brokenOnlyPct.toFixed(1)).padEnd(13) +
        (r.recrossedPct == null ? "-" : r.recrossedPct.toFixed(1)).padEnd(12) +
        (r.recrossedOfBrokenPct == null ? "-" : r.recrossedOfBrokenPct.toFixed(1)),
      );
    }

    console.log("\n=== Excess forward return by anchor type (baseline-drift-corrected) ===");
    for (const timeframe of LADDER_KEYS) {
      console.log(`\n=== ${timeframe} ===`);
      console.log(
        "tercile".padEnd(9) + "anchor".padEnd(18) + "n".padEnd(7) +
        out.horizons.map((h) => `N${h}`.padEnd(18)).join(""),
      );
      for (const r of out.results.filter((r) => r.timeframe === timeframe)) {
        let line = r.tercile.padEnd(9) + r.classification.padEnd(18) + String(r.n).padEnd(7);
        for (const h of out.horizons) {
          const c = r.horizons[h];
          if (!c || c.tooThin) { line += `thin(n=${c ? c.n : 0})`.padEnd(18); continue; }
          const star = c.p < 0.05 ? "*" : "";
          line += `${(c.meanExcessReturn * 100).toFixed(2)}%(p=${c.p.toFixed(3)}${star})`.padEnd(18);
        }
        console.log(line);
      }
    }

    const RESULTS_DIR = new URL("results/", import.meta.url);
    mkdirSync(RESULTS_DIR, { recursive: true });
    const payload = { ...out, git_commit: gitCommit(), generated_at: new Date().toISOString() };
    const fname = `cross_recross_significance_${out.side}_${payload.generated_at.replace(/[:.]/g, "-")}.json`;
    writeFileSync(new URL(fname, RESULTS_DIR), JSON.stringify(payload, null, 2));
    console.log(`\nSaved: ${new URL(fname, RESULTS_DIR).pathname.replace(/^\/([A-Z]:)/, "$1")}`);
  });
}

main();
