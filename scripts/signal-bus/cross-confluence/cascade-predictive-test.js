#!/usr/bin/env node
// Predictive capacity of STRUCTURE-EVENT TOP-DOWN CASCADES -- the test #135 set up.
//
// WHY THIS POPULATION. #135 built the cascade encoding and found two things. First, deep cascades
// do not occur: mean depth ~2.05 across 32 configurations, essentially zero full-ladder traversals,
// in two unrelated event families. Second, and more usefully, the propagation direction REVERSES by
// event family -- SMC structure events go top-down 2.4x more than bottom-up, while SuperTrend flips
// go bottom-up more. The SuperTrend bottom-up excess is plausibly mechanical (a weekly SuperTrend
// cannot flip without price action that already flipped every faster rung), whereas structural
// breaks carry no such forced coupling. #7620896 then showed both contrasts replicate on ETH, which
// played no part in finding them.
//
// So structure top-down cascades are the one place where a real population, a theoretically
// motivated direction, and a clean cross-instrument replication all coincide. Every earlier test in
// this thread used SuperTrend -- the single event family where the mechanics run backwards.
//
// TWO DESIGN CORRECTIONS carried over from earlier mistakes in this register:
//
//   SCALE-MATCHED OUTCOME. #128 judged every rung against a fixed 1h/4h/1d horizon, which asks the
//   weekly to predict one-hour returns. Here the outcome is measured on the cascade's END RUNG --
//   the finest rung it reached -- over N bars of THAT rung. A cascade terminating at 4h and one
//   terminating at 5m are then judged on their own scales.
//
//   known_at_time IS THE KEY. A cascade is not observable until its last participating rung flips.
//   Keying on start_time would be look-ahead: the sequence is not known to have happened until it
//   has finished happening. Entry is the first bar STRICTLY AFTER known_at_time.
//
// NULL. Cascades are discrete events, so per #129 a label permutation over them is defensible for
// the top-down vs bottom-up contrast. For the "is this better than nothing" question the null is a
// CIRCULAR SHIFT of cascade entry times within each rung's series, which preserves the direction
// mix and the event count exactly while destroying only the timing alignment -- #128 showed an
// i.i.d. shuffle inflates significance badly on autocorrelated series.
//
// Usage: node scripts/signal-bus/cross-confluence/cascade-predictive-test.js
//        [--family=smc_structure] [--mult=1] [--horizon=20] [--shifts=2000]

import { DatabaseSync } from "node:sqlite";
import { writeFileSync, mkdirSync } from "fs";
import { loadCandles } from "../../backtest/lib/load-candles.js";

const args = Object.fromEntries(process.argv.slice(2).filter((a) => a.includes("=")).map((a) => a.replace(/^--/, "").split("=")));
const FAMILY = args.family || "smc_structure";
const MULT = Number(args.mult || "1");
const HORIZON = parseInt(args.horizon || "20", 10);
const SHIFTS = parseInt(args.shifts || "2000", 10);
const SEED = parseInt(args.seed || "42", 10);

const cascadeDb = (inst) => new URL(`../../../data/signal-bus/${inst === "BTC" ? "cascade.db" : "cascade-eth.db"}`, import.meta.url);

function mulberry32(seed) {
  let a = seed >>> 0;
  return function () { a |= 0; a = (a + 0x6d2b79f5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
const mean = (xs) => (xs.length ? xs.reduce((s, x) => s + x, 0) / xs.length : null);

async function buildOutcomes(instrument) {
  const db = new DatabaseSync(cascadeDb(instrument), { readOnly: true });
  const rows = db.prepare(
    `SELECT propagation, direction, depth, end_rung, known_at_time
     FROM cascades WHERE event_family = ? AND window_mult = ? ORDER BY known_at_time`,
  ).all(FAMILY, MULT);
  db.close();

  // Group by end rung so each rung's candle series is loaded once.
  const byRung = new Map();
  for (const r of rows) {
    if (!byRung.has(r.end_rung)) byRung.set(r.end_rung, []);
    byRung.get(r.end_rung).push(r);
  }

  const out = [];
  const rungSeries = new Map(); // rung -> { closes, n } for the shift null
  for (const [rung, list] of byRung) {
    const candles = await loadCandles(rung, instrument);
    const times = candles.map((c) => c.t);
    const closes = candles.map((c) => c.c);
    rungSeries.set(rung, closes);

    for (const r of list) {
      // First bar STRICTLY after the cascade became observable.
      let lo = 0, hi = times.length - 1, idx = -1;
      while (lo <= hi) {
        const mid = (lo + hi) >> 1;
        if (times[mid] > r.known_at_time) { idx = mid; hi = mid - 1; } else lo = mid + 1;
      }
      if (idx < 0 || idx + HORIZON >= closes.length) continue;
      const raw = (closes[idx + HORIZON] - closes[idx]) / closes[idx];
      const signed = r.direction === "bullish" ? raw : -raw;
      out.push({ ...r, rung, entryIdx: idx, signed });
    }
  }
  return { outcomes: out, rungSeries };
}

// Null: shift every cascade's entry index by the same random offset within its own rung's series,
// keeping direction and count identical. Destroys timing, preserves everything else.
function shiftedMean(outcomes, rungSeries, rng) {
  const offsets = new Map();
  for (const rung of rungSeries.keys()) {
    const n = rungSeries.get(rung).length;
    offsets.set(rung, 1 + Math.floor(rng() * (n - 2)));
  }
  let sum = 0, cnt = 0;
  for (const o of outcomes) {
    const closes = rungSeries.get(o.rung);
    const n = closes.length;
    const i = (o.entryIdx + offsets.get(o.rung)) % n;
    if (i + HORIZON >= n) continue;
    const raw = (closes[i + HORIZON] - closes[i]) / closes[i];
    sum += o.direction === "bullish" ? raw : -raw;
    cnt++;
  }
  return cnt ? sum / cnt : null;
}

function report(label, subset, rungSeries, rng, out) {
  if (subset.length < 30) { console.log(`  ${label.padEnd(34)} n=${String(subset.length).padStart(4)}  (too thin)`); return null; }
  const m = mean(subset.map((o) => o.signed));
  const win = subset.filter((o) => o.signed > 0).length / subset.length;
  let geq = 0;
  for (let k = 0; k < SHIFTS; k++) {
    const nullMean = shiftedMean(subset, rungSeries, rng);
    if (nullMean != null && nullMean >= m) geq++;
  }
  const p = geq / SHIFTS;
  console.log(`  ${label.padEnd(34)} n=${String(subset.length).padStart(4)}  mean=${(m * 100).toFixed(4).padStart(8)}%  win=${(win * 100).toFixed(1).padStart(5)}%  p=${p.toFixed(4)}${p < 0.05 ? "*" : " "}`);
  const rec = { label, n: subset.length, mean_pct: m * 100, win_rate: win, p };
  out.push(rec);
  return rec;
}

async function main() {
  const rng = mulberry32(SEED);
  const results = { family: FAMILY, window_mult: MULT, horizon_bars: HORIZON, shifts: SHIFTS, instruments: {} };

  console.log(`\n${"=".repeat(96)}`);
  console.log(`CASCADE PREDICTIVE TEST -- family=${FAMILY}, window_mult=${MULT}, horizon=${HORIZON} bars of the END RUNG`);
  console.log(`Outcome: signed return toward the cascade's direction, from the first bar after known_at_time.`);
  console.log(`Null: circular shift of entry times within each rung (preserves direction mix and count).`);
  console.log(`${"=".repeat(96)}`);

  const pooled = { td: [], bu: [] };
  let pooledSeries = null;

  for (const inst of ["BTC", "ETH"]) {
    const { outcomes, rungSeries } = await buildOutcomes(inst);
    const td = outcomes.filter((o) => o.propagation === "top_down");
    const bu = outcomes.filter((o) => o.propagation === "bottom_up");
    pooled.td.push(...td); pooled.bu.push(...bu);
    pooledSeries = rungSeries; // same rung keys both instruments; used only for offset ranges

    console.log(`\n--- ${inst} (${outcomes.length} cascades with resolvable outcomes) ---`);
    const rows = [];
    report("TOP-DOWN (all depths)", td, rungSeries, rng, rows);
    report("  top-down depth 2", td.filter((o) => o.depth === 2), rungSeries, rng, rows);
    report("  top-down depth >=3", td.filter((o) => o.depth >= 3), rungSeries, rng, rows);
    report("BOTTOM-UP (control)", bu, rungSeries, rng, rows);

    // Direct top-down vs bottom-up contrast, label permutation over the pooled cascade set (#129).
    if (td.length >= 30 && bu.length >= 30) {
      const all = [...td.map((o) => ({ ...o, isTd: 1 })), ...bu.map((o) => ({ ...o, isTd: 0 }))];
      const realGap = mean(td.map((o) => o.signed)) - mean(bu.map((o) => o.signed));
      let geq = 0;
      for (let k = 0; k < SHIFTS; k++) {
        const lab = all.map((o) => o.isTd);
        for (let i = lab.length - 1; i > 0; i--) { const j = Math.floor(rng() * (i + 1)); [lab[i], lab[j]] = [lab[j], lab[i]]; }
        let sA = 0, nA = 0, sB = 0, nB = 0;
        for (let i = 0; i < all.length; i++) { if (lab[i]) { sA += all[i].signed; nA++; } else { sB += all[i].signed; nB++; } }
        if (nA && nB && sA / nA - sB / nB >= realGap) geq++;
      }
      const p = geq / SHIFTS;
      console.log(`  ${"top-down MINUS bottom-up".padEnd(34)} gap=${(realGap * 100).toFixed(4)}pp  p=${p.toFixed(4)}${p < 0.05 ? "*" : " "}`);
      rows.push({ label: "td_minus_bu", gap_pp: realGap * 100, p });
    }
    results.instruments[inst] = rows;
  }

  console.log(`\n--- POOLED (BTC+ETH) ---`);
  const prows = [];
  report("TOP-DOWN (all depths)", pooled.td, pooledSeries, rng, prows);
  report("  top-down depth 2", pooled.td.filter((o) => o.depth === 2), pooledSeries, rng, prows);
  report("  top-down depth >=3", pooled.td.filter((o) => o.depth >= 3), pooledSeries, rng, prows);
  report("BOTTOM-UP (control)", pooled.bu, pooledSeries, rng, prows);
  results.pooled = prows;

  const RESULTS_DIR = new URL("results/", import.meta.url);
  mkdirSync(RESULTS_DIR, { recursive: true });
  const fname = `cascade_predictive_${FAMILY}_${new Date().toISOString().replace(/[:.]/g, "-")}.json`;
  writeFileSync(new URL(fname, RESULTS_DIR), JSON.stringify({ generated_at: new Date().toISOString(), ...results }, null, 2));
  console.log(`\nSaved: ${new URL(fname, RESULTS_DIR).pathname.replace(/^\/([A-Z]:)/, "$1")}`);
}

main().catch((err) => { console.error("Fatal:", err); process.exit(1); });
