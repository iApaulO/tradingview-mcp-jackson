#!/usr/bin/env node
// Does FULL containment between two overlapping same-timeframe/side order blocks (one's
// [bar_low,bar_high] range is a strict superset of the other's) predict differently than plain
// PARTIAL overlap (ranges cross but neither fully contains the other)? iapaulo's direct ask
// (2026-08-12): "the impact of one ob fully engulfed by the next one instead of just overlapping."
// recurrence_count (#27/#27b, the validated A_recurrence signal) already counts ANY overlap
// (rangesOverlap + windowsOverlap, confluence.js's computeRecurrence) symmetrically and doesn't
// distinguish containment from a partial cross -- this tests whether that distinction, ignored so
// far, carries real additional information within the already-overlapping population.
//
// Classification (restricted to OBs with recurrence_count>=2, i.e. at least one overlap partner --
// isolated OBs, recurrence_count=1, have no relationship to classify and are reported separately as
// the baseline):
//   ENGULFED:   at least one partner's range fully contains this OB's own range
//               (partner.low <= this.low && partner.high >= this.high, strictly wider)
//   ENGULFING:  this OB's range fully contains at least one partner's range
//   PARTIAL:    has an overlap partner, but no full-containment relationship either direction
// (an OB can be both engulfed by one partner and engulfing of another in a 3+ chain -- reported as
// its own category rather than force-assigned to one side.)
//
// Trade construction: EXACT reuse of recurrence-fixed-rr-significance.js's fixed-R trade (entry at
// touch start +1 bar open, stop = OB far edge, target = R x risk) -- the already-validated #27b
// construction, unchanged, so this tests the containment variable on the SAME trades, not a new
// invented one.
//
// Usage: node scripts/signal-bus/smc/ob-engulfment-significance.js [--r=1,1.5,2,3] [--iterations=20000]

import { DatabaseSync } from "node:sqlite";
import { loadCandles } from "../../backtest/lib/load-candles.js";
import { applyCosts, FEE_TIERS, REPRESENTATIVE_FUNDING_PCT_PER_HOUR } from "../../backtest/lib/costs.js";
import { classifyEngulfment } from "./engulfment.js";

const DB_PATH = new URL("../../../data/signal-bus/smc.db", import.meta.url);
const args = Object.fromEntries(process.argv.slice(2).map((a) => a.replace(/^--/, "").split("=")));
const ITERATIONS = parseInt(args.iterations || "20000", 10);
const SEED = 42;
const R_MULTIPLES = (args.r || "1,1.5,2,3").split(",").map(Number);
const MAX_HOLD_BARS = 200;
const COST_PARAMS = { takerFeePct: FEE_TIERS.bitunix_futures_vip1.takerFeePct, fundingPctPerHour: REPRESENTATIVE_FUNDING_PCT_PER_HOUR };

function mulberry32(seed) {
  let a = seed >>> 0;
  return function () { a |= 0; a = (a + 0x6d2b79f5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
function shuffle(arr, rng) {
  const out = [...arr];
  for (let i = out.length - 1; i > 0; i--) { const j = Math.floor(rng() * (i + 1)); [out[i], out[j]] = [out[j], out[i]]; }
  return out;
}
function expectancy(trades) { return trades.length ? trades.reduce((s, t) => s + t.pnlPct, 0) / trades.length : null; }

async function buildFixedRWinsByOrderBlock(rMultiple, obRowsClassified) {
  const db = new DatabaseSync(DB_PATH, { readOnly: true });
  const touchRows = db.prepare(`SELECT order_block_id, start_bar_idx FROM order_block_touches`).all();
  db.close();

  const obById = new Map(obRowsClassified.map((o) => [o.id, o]));
  const entriesByTf = new Map();
  for (const t of touchRows) {
    const ob = obById.get(t.order_block_id);
    if (!ob) continue; // touch belongs to an order block outside this run's set (shouldn't happen -- obRowsClassified is all order_blocks -- kept defensive)
    if (!entriesByTf.has(ob.timeframe)) entriesByTf.set(ob.timeframe, []);
    entriesByTf.get(ob.timeframe).push({ startBarIdx: t.start_bar_idx, ob });
  }

  const obOutcomes = new Map(); // ob.id -> { engulfmentClass, wins: [0/1,...] }
  const flatTrades = []; // per-trade records for costed expectancy + per-timeframe breakdown
  for (const [tf, entries] of entriesByTf) {
    const candles = await loadCandles(tf);
    for (const e of entries) {
      const entryIdx = e.startBarIdx + 1;
      if (entryIdx >= candles.length) continue;
      const entryPrice = candles[entryIdx].o, entryTime = candles[entryIdx].t;
      const side = e.ob.side === "bullish" ? "long" : "short";
      const stopPrice = e.ob.side === "bullish" ? e.ob.bar_low : e.ob.bar_high;
      const risk = Math.abs(entryPrice - stopPrice);
      if (risk <= 0) continue;
      const targetPrice = side === "long" ? entryPrice + rMultiple * risk : entryPrice - rMultiple * risk;
      let outcome = null, exitPrice = null, exitTime = null;
      const endCheck = Math.min(candles.length - 1, entryIdx + MAX_HOLD_BARS);
      for (let j = entryIdx; j <= endCheck; j++) {
        const bar = candles[j];
        const hitStop = side === "long" ? bar.l <= stopPrice : bar.h >= stopPrice;
        const hitTarget = side === "long" ? bar.h >= targetPrice : bar.l <= targetPrice;
        if (hitStop) { outcome = 0; exitPrice = stopPrice; exitTime = bar.t; break; }
        if (hitTarget) { outcome = 1; exitPrice = targetPrice; exitTime = bar.t; break; }
      }
      if (outcome == null) continue;
      if (!obOutcomes.has(e.ob.id)) obOutcomes.set(e.ob.id, { engulfmentClass: e.ob.engulfmentClass, wins: [] });
      obOutcomes.get(e.ob.id).wins.push(outcome);
      const pnlPct = side === "long" ? (exitPrice - entryPrice) / entryPrice : (entryPrice - exitPrice) / entryPrice;
      flatTrades.push({ engulfmentClass: e.ob.engulfmentClass, timeframe: tf, side, entryTime, entryPrice, exitTime, exitPrice, pnlPct });
    }
  }
  return { obOutcomes: [...obOutcomes.values()], flatTrades };
}

function summarize(label, obs, flatTrades, engulfmentClassFilter) {
  const wins = obs.flatMap((o) => o.wins);
  const n = wins.length, holds = wins.reduce((s, w) => s + w, 0);
  const classTrades = flatTrades.filter((t) => t.engulfmentClass === engulfmentClassFilter);
  const costed = applyCosts(classTrades, COST_PARAMS);
  const grossExp = expectancy(classTrades), costedExp = expectancy(costed);
  console.log(`  ${label.padEnd(24)} obs=${String(obs.length).padEnd(5)} trades=${String(n).padEnd(6)} win_rate=${n ? ((holds / n) * 100).toFixed(1) : "n/a"}%  gross_exp=${grossExp != null ? (grossExp * 100).toFixed(4) + "%" : "n/a"}  costed_exp=${costedExp != null ? (costedExp * 100).toFixed(4) + "%" : "n/a"}${costedExp > 0 ? " (clears costs)" : costedExp != null ? " (BLOCKED)" : ""}`);
}

function timeframeBreakdown(flatTrades) {
  const tfs = [...new Set(flatTrades.map((t) => t.timeframe))];
  const order = ["1w", "1d", "4h", "3h", "2h", "1h", "15m", "5m"];
  tfs.sort((a, b) => order.indexOf(a) - order.indexOf(b));
  console.log(`  ${"timeframe".padEnd(6)} ${"isolated".padEnd(28)} ${"partial".padEnd(28)} ${"engulfment".padEnd(28)}`);
  for (const tf of tfs) {
    const row = [tf.padEnd(6)];
    for (const cls of ["isolated", "partial", "engulfment"]) {
      const ts = flatTrades.filter((t) => t.timeframe === tf && t.engulfmentClass === cls);
      if (ts.length < 10) { row.push(`n=${ts.length} (thin)`.padEnd(28)); continue; }
      const wins = ts.filter((t) => t.pnlPct > 0).length;
      const costedExp = expectancy(applyCosts(ts, COST_PARAMS));
      row.push(`n=${ts.length} win=${((wins / ts.length) * 100).toFixed(0)}% exp=${(costedExp * 100).toFixed(3)}%${costedExp > 0 ? "+" : ""}`.padEnd(28));
    }
    console.log(`  ${row.join(" ")}`);
  }
}

async function runForRMultiple(rMultiple, obRowsClassified) {
  console.log(`\n=== R-multiple: ${rMultiple}R ===`);
  const { obOutcomes: obs, flatTrades } = await buildFixedRWinsByOrderBlock(rMultiple, obRowsClassified);

  const isolated = obs.filter((o) => o.engulfmentClass === "isolated");
  const partial = obs.filter((o) => o.engulfmentClass === "partial");
  const engulfment = obs.filter((o) => o.engulfmentClass === "engulfment");
  summarize("isolated (recurrence=1)", isolated, flatTrades, "isolated");
  summarize("partial-overlap-only", partial, flatTrades, "partial");
  summarize("engulfment (contains/contained)", engulfment, flatTrades, "engulfment");
  console.log(`\n  -- per-timeframe breakdown (costed expectancy) --`);
  timeframeBreakdown(flatTrades);

  // Formal test: WITHIN the overlapping population only (partial + engulfment, excludes isolated --
  // isolating the containment-type effect from #27b's already-established raw-overlap effect),
  // binary label engulfment=1/partial=0, permutation test vs win/loss, same order-block-level
  // shuffle methodology as recurrence-significance.js/recurrence-fixed-rr-significance.js.
  const pool = [...partial, ...engulfment];
  const realLabels = pool.map((o) => (o.engulfmentClass === "engulfment" ? 1 : 0));
  const realX = [], realY = [];
  for (const o of pool) { const label = o.engulfmentClass === "engulfment" ? 1 : 0; for (const w of o.wins) { realX.push(label); realY.push(w); } }
  const n = realX.length;
  if (n < 30) { console.log(`  Too few overlapping-population trades (n=${n}) for a significance test.`); return { rMultiple, n, verdict: "too thin" }; }

  const nEngulf = realX.filter((x) => x === 1).length, nPartial = n - nEngulf;
  const engulfWinRate = realY.reduce((s, y, i) => s + (realX[i] === 1 ? y : 0), 0) / nEngulf;
  const partialWinRate = realY.reduce((s, y, i) => s + (realX[i] === 0 ? y : 0), 0) / nPartial;
  const realGap = engulfWinRate - partialWinRate;
  console.log(`  Engulfment win rate=${(engulfWinRate * 100).toFixed(1)}% (n=${nEngulf}) vs Partial-only win rate=${(partialWinRate * 100).toFixed(1)}% (n=${nPartial}) -- gap=${(realGap * 100).toFixed(2)}pts`);

  const rng = mulberry32(SEED);
  let geq = 0;
  for (let iter = 0; iter < ITERATIONS; iter++) {
    const shuffledLabels = shuffle(realLabels, rng);
    const px = [];
    for (let i = 0; i < pool.length; i++) for (const _w of pool[i].wins) px.push(shuffledLabels[i]);
    const pEngulf = px.filter((x) => x === 1).length;
    const pPartial = px.length - pEngulf;
    if (pEngulf === 0 || pPartial === 0) continue;
    let engSum = 0, parSum = 0;
    for (let i = 0; i < px.length; i++) { if (px[i] === 1) engSum += realY[i]; else parSum += realY[i]; }
    const gap = engSum / pEngulf - parSum / pPartial;
    if (gap >= realGap) geq++;
  }
  const p = geq / ITERATIONS;
  console.log(`  Permutation test (${ITERATIONS} iter, order-block-level shuffle): p=${p.toFixed(4)}${p < 0.05 ? " (significant at 5%)" : " (NOT significant)"}`);
  return { rMultiple, n, nEngulf, nPartial, engulfWinRate, partialWinRate, gap: realGap, p, verdict: p < 0.05 ? "real" : "not significant" };
}

async function main() {
  const db = new DatabaseSync(DB_PATH, { readOnly: true });
  const obRows = db.prepare(`SELECT id, timeframe, side, bar_high, bar_low, created_time, mitigated_time, recurrence_count FROM order_blocks`).all();
  db.close();
  classifyEngulfment(obRows);

  const counts = { isolated: 0, partial: 0, engulfment: 0 };
  for (const o of obRows) counts[o.engulfmentClass]++;
  console.log(`Order blocks classified: ${obRows.length} total -- isolated=${counts.isolated}, partial-overlap-only=${counts.partial}, engulfment=${counts.engulfment}`);
  const engulfedOnly = obRows.filter((o) => o.isEngulfed && !o.isEngulfing).length;
  const engulfingOnly = obRows.filter((o) => o.isEngulfing && !o.isEngulfed).length;
  const both = obRows.filter((o) => o.isEngulfed && o.isEngulfing).length;
  console.log(`  of the ${counts.engulfment} engulfment cases: engulfed-only=${engulfedOnly}, engulfing-only=${engulfingOnly}, both (3+ chain)=${both}`);

  const results = {};
  for (const r of R_MULTIPLES) results[`${r}R`] = await runForRMultiple(r, obRows);

  console.log("\n\n=== Summary across all R multiples (engulfment vs partial-overlap-only, within the overlapping population) ===");
  for (const [label, r] of Object.entries(results)) {
    if (r.p == null) { console.log(`  ${label.padEnd(5)} ${r.verdict}`); continue; }
    console.log(`  ${label.padEnd(5)} n=${r.n}  engulf_win=${(r.engulfWinRate * 100).toFixed(1)}%(n=${r.nEngulf})  partial_win=${(r.partialWinRate * 100).toFixed(1)}%(n=${r.nPartial})  gap=${(r.gap * 100).toFixed(2)}pts  p=${r.p.toFixed(4)}  -- ${r.verdict}`);
  }
}

main().catch((err) => { console.error("Fatal:", err); process.exit(1); });
