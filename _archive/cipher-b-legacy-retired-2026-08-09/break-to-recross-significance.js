#!/usr/bin/env node
// Follow-up to cross-recross-significance.js. That test anchored forward returns AT the recross and
// found nothing -- flat, non-significant excess return at every timeframe, while the SPAN it must be
// sitting inside (held, and broken-without-recross-yet) both showed real positive excess return. Read:
// the recross is the END of the recovery move, not the start of a new one -- by the time price crosses
// back through the line, the reclaim already happened. Measuring forward from there catches you late.
//
// This test measures the recovery move ITSELF: for every bull divergence that broke (adverse cross)
// and later recrossed (favorable cross back), what was the realized return from the BREAK bar's price
// to the RECROSS bar's price? That's the actual span iapaulo's worked example described -- WT line
// broke ~7/31, retested/reclaimed ~8/6-8/7, forming a new HL. The candidate edge is entering AT or
// near the break, anticipating the reclaim, not entering after the reclaim completes.
//
// Baseline-drift correction still applies (see price-outcome-significance.js's fix) but spans are
// variable-length, not fixed horizons, so a full sliding-window baseline per unique span length isn't
// practical. Instead: per-bar drift rate is computed once per timeframe as baseline(h)/h averaged
// across the existing horizon set -- verified near-linear (e.g. 3h: 0.089/5=0.0178, 0.728/40=0.0182,
// consistent to within rounding), so this is a defensible approximation, not a new assumption.
//
// Usage: node scripts/signal-bus/cipher-b/break-to-recross-significance.js [--side=bull]

import { DatabaseSync } from "node:sqlite";
import { writeFileSync, mkdirSync } from "fs";
import { execSync } from "child_process";
import { loadCandles } from "../../backtest/lib/load-candles.js";

const DB_PATH = new URL("../../../data/signal-bus/cipher-b.db", import.meta.url);
const BAR_DURATION_SEC = { "1w": 604800, "1d": 86400, "4h": 14400, "3h": 10800, "2h": 7200, "1h": 3600, "15m": 900, "5m": 300 };
const LADDER_KEYS = ["1w", "1d", "4h", "3h", "2h", "1h", "15m", "5m"];
const BASELINE_HORIZONS = [5, 10, 20, 40];

const args = Object.fromEntries(process.argv.slice(2).map((a) => a.replace(/^--/, "").split("=")));
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
function median(vals) {
  const s = [...vals].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

async function loadAllCandles() {
  const out = {};
  for (const key of LADDER_KEYS) out[key] = await loadCandles(key);
  return out;
}

function computePerBarDrift(candlesByTf) {
  const perBar = {};
  for (const key of LADDER_KEYS) {
    const candles = candlesByTf[key];
    const rates = [];
    for (const h of BASELINE_HORIZONS) {
      let sum = 0, count = 0;
      for (let i = 0; i + h < candles.length; i++) {
        sum += candles[i + h].c / candles[i].c - 1;
        count++;
      }
      if (count) rates.push((sum / count) / h);
    }
    perBar[key] = rates.reduce((s, x) => s + x, 0) / rates.length;
  }
  return perBar;
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
    if (firstAdverseIdx === -1) continue; // held -- no break, not part of this population

    const recross = crossings.slice(firstAdverseIdx + 1).find((c) => c.direction === favorableDirection);
    if (!recross) continue; // broken_only -- no recross yet, not part of this population

    events.push({
      timeframe: d.timeframe, source: d.source, hidden: !!d.hidden,
      slopePerDay: Math.abs(d.slope) * (86400 / BAR_DURATION_SEC[d.timeframe]),
      breakBarIdx: crossings[firstAdverseIdx].barIdx,
      recrossBarIdx: recross.barIdx,
      spanBars: recross.barIdx - crossings[firstAdverseIdx].barIdx,
    });
  }
  return events;
}

function assignTerciles(rows) {
  const sorted = [...rows].sort((a, b) => a.slopePerDay - b.slopePerDay);
  const third = Math.floor(sorted.length / 3);
  sorted.forEach((r, i) => { r._tercile = i < third ? "shallow" : i < 2 * third ? "mid" : "steep"; });
}

export async function runBreakToRecrossTest({ side = SIDE } = {}) {
  const db = new DatabaseSync(DB_PATH, { readOnly: true });
  const events = loadEvents(db, side);
  db.close();

  const candlesByTf = await loadAllCandles();
  const perBarDrift = computePerBarDrift(candlesByTf);

  for (const e of events) {
    const candles = candlesByTf[e.timeframe];
    const breakPrice = candles[e.breakBarIdx]?.c;
    const recrossPrice = candles[e.recrossBarIdx]?.c;
    if (breakPrice == null || recrossPrice == null) continue;
    const raw = recrossPrice / breakPrice - 1;
    const signed = side === "bull" ? raw : -raw;
    const baselineForSpan = perBarDrift[e.timeframe] * e.spanBars;
    const baselineSigned = side === "bull" ? baselineForSpan : -baselineForSpan;
    e.spanReturn = signed;
    e.excessSpanReturn = signed - baselineSigned;
  }

  const byTf = {};
  for (const e of events) (byTf[e.timeframe] ||= []).push(e);
  for (const tf of Object.keys(byTf)) assignTerciles(byTf[tf]);

  const results = [];
  for (const timeframe of LADDER_KEYS) {
    const rows = (byTf[timeframe] || []).filter((r) => r.excessSpanReturn != null);
    for (const tercile of ["shallow", "mid", "steep"]) {
      const sub = rows.filter((r) => r._tercile === tercile);
      const cell = { timeframe, tercile, n: sub.length };
      if (sub.length < 20) { cell.tooThin = true; results.push(cell); continue; }
      const raw = tTestOneSample(sub.map((r) => r.spanReturn));
      const excess = tTestOneSample(sub.map((r) => r.excessSpanReturn));
      cell.meanSpanBars = sub.reduce((s, r) => s + r.spanBars, 0) / sub.length;
      cell.medianSpanBars = median(sub.map((r) => r.spanBars));
      cell.rawSpanReturn = raw.mean; cell.rawP = raw.p;
      cell.excessSpanReturn = excess.mean; cell.excessP = excess.p;
      results.push(cell);
    }
  }

  return { side, totalEvents: events.length, perBarDrift, results };
}

function main() {
  runBreakToRecrossTest({ side: SIDE }).then((out) => {
    console.log(`${out.totalEvents.toLocaleString()} broken-then-recrossed ${out.side} divergences.\n`);
    console.log(
      "tf".padEnd(6) + "tercile".padEnd(9) + "n".padEnd(7) + "meanSpan(bars)".padEnd(16) +
      "medianSpan".padEnd(12) + "rawSpanReturn".padEnd(22) + "excessSpanReturn",
    );
    for (const r of out.results) {
      if (r.tooThin) { console.log(`${r.timeframe.padEnd(6)}${r.tercile.padEnd(9)}${String(r.n).padEnd(7)}thin`); continue; }
      const starR = r.rawP < 0.05 ? "*" : "";
      const starE = r.excessP < 0.05 ? "*" : "";
      console.log(
        r.timeframe.padEnd(6) + r.tercile.padEnd(9) + String(r.n).padEnd(7) +
        r.meanSpanBars.toFixed(1).padEnd(16) + String(r.medianSpanBars).padEnd(12) +
        `${(r.rawSpanReturn * 100).toFixed(2)}%(p=${r.rawP.toFixed(3)}${starR})`.padEnd(22) +
        `${(r.excessSpanReturn * 100).toFixed(2)}%(p=${r.excessP.toFixed(3)}${starE})`,
      );
    }

    const RESULTS_DIR = new URL("results/", import.meta.url);
    mkdirSync(RESULTS_DIR, { recursive: true });
    const payload = { ...out, git_commit: gitCommit(), generated_at: new Date().toISOString() };
    const fname = `break_to_recross_significance_${out.side}_${payload.generated_at.replace(/[:.]/g, "-")}.json`;
    writeFileSync(new URL(fname, RESULTS_DIR), JSON.stringify(payload, null, 2));
    console.log(`\nSaved: ${new URL(fname, RESULTS_DIR).pathname.replace(/^\/([A-Z]:)/, "$1")}`);
  });
}

main();
