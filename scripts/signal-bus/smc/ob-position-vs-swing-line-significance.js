#!/usr/bin/env node
// Corrected AGAIN per iapaulo's direct correction: no D4M, no proximity matching -- "the only
// condition that exists is at or under or at/above solid swing line." This tests OB PRICE POSITION
// relative to the current SOLID (swing-scope) structure line's actual level, not side-agreement in
// the abstract (#85/#86) and not D4M confluence (#87/#88). iapaulo's own two examples: a red
// (bearish) OB ABOVE the swing line, a blue (bullish) OB AT/UNDER the swing line.
//
// "Current swing line level" = the price of the most recent swing-scope BOS/CHoCH (either type,
// either side) at/before the touch bar, same timeframe -- structure_events.price IS the swing pivot
// level that line represents (verified directly in calc.js: pushed as highPivot/lowPivot.currentLevel).
//
// Condition: bearish (red) OB whose range sits ABOVE that level, OR bullish (blue) OB whose range
// sits AT/BELOW it. Same trade construction as #27b/#85 (entry=next-bar-open, stop=OB far edge,
// R-multiple target, malformed stop-on-wrong-side-of-entry touches excluded).
//
// Usage: node scripts/signal-bus/smc/ob-position-vs-swing-line-significance.js [--r=1,1.5,2,3] [--recurrence-min=3]

import { DatabaseSync } from "node:sqlite";
import { writeFileSync, mkdirSync } from "fs";
import { execSync } from "child_process";
import { loadCandles } from "../../backtest/lib/load-candles.js";
import { computeMetrics } from "../../backtest/lib/metrics.js";
import { applyCosts, FEE_TIERS, REPRESENTATIVE_FUNDING_PCT_PER_HOUR } from "../../backtest/lib/costs.js";

const SMC_DB_PATH = new URL("../../../data/signal-bus/smc.db", import.meta.url);
const MAX_HOLD_BARS = 200;
const args = Object.fromEntries(process.argv.slice(2).map((a) => a.replace(/^--/, "").split("=")));
const R_MULTIPLES = (args.r || "1,1.5,2,3").split(",").map(Number);
const RECURRENCE_MIN = parseInt(args["recurrence-min"] || "3", 10);
const ITERATIONS = 20000, SEED = 42;

function gitCommit() {
  try { return execSync("git rev-parse HEAD", { cwd: new URL("../../../", import.meta.url), encoding: "utf8" }).trim(); }
  catch { return "unknown"; }
}
function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function shuffle(arr, rng) {
  const out = [...arr];
  for (let i = out.length - 1; i > 0; i--) { const j = Math.floor(rng() * (i + 1)); [out[i], out[j]] = [out[j], out[i]]; }
  return out;
}
function simulateFixedR(candles, entryIdx, side, stopPrice, targetPrice) {
  const endCheck = Math.min(candles.length - 1, entryIdx + MAX_HOLD_BARS);
  for (let j = entryIdx; j <= endCheck; j++) {
    const bar = candles[j];
    const hitStop = side === "long" ? bar.l <= stopPrice : bar.h >= stopPrice;
    const hitTarget = side === "long" ? bar.h >= targetPrice : bar.l <= targetPrice;
    if (hitStop) return { exitPrice: stopPrice, exitTime: bar.t, win: 0 };
    if (hitTarget) return { exitPrice: targetPrice, exitTime: bar.t, win: 1 };
  }
  return null;
}
function winRate(vals) { return vals.length ? vals.reduce((s, x) => s + x, 0) / vals.length : null; }
function expectancy(trades) { return trades.length ? trades.reduce((s, t) => s + t.pnlPct, 0) / trades.length : null; }
function permTest(wins, labels, iterations, seed) {
  const groupA = [], groupB = [];
  for (let i = 0; i < wins.length; i++) (labels[i] ? groupA : groupB).push(wins[i]);
  const realGap = winRate(groupA) - winRate(groupB);
  const rng = mulberry32(seed);
  let geq = 0;
  for (let it = 0; it < iterations; it++) {
    const shuffled = shuffle(labels, rng);
    let sA = 0, nA = 0, sB = 0, nB = 0;
    for (let i = 0; i < wins.length; i++) { if (shuffled[i]) { sA += wins[i]; nA++; } else { sB += wins[i]; nB++; } }
    if (nA === 0 || nB === 0) continue;
    if (sA / nA - sB / nB >= realGap) geq++;
  }
  return { realGap, p: geq / iterations };
}
function findCurrentSwingLine(sortedEvents, barIdx) {
  let lo = 0, hi = sortedEvents.length - 1, ans = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (sortedEvents[mid].bar_idx <= barIdx) { ans = mid; lo = mid + 1; }
    else hi = mid - 1;
  }
  return ans === -1 ? null : sortedEvents[ans]; // { side, price }
}

async function main() {
  const db = new DatabaseSync(SMC_DB_PATH, { readOnly: true });
  const obRows = db.prepare("SELECT id, timeframe, side, bar_high, bar_low, recurrence_count FROM order_blocks WHERE recurrence_count >= ?").all(RECURRENCE_MIN);
  const touchRows = db.prepare(
    `SELECT order_block_id, start_bar_idx FROM order_block_touches WHERE order_block_id IN (${obRows.map(() => "?").join(",") || "0"})`,
  ).all(...obRows.map((o) => o.id));
  const structRows = db.prepare("SELECT timeframe, side, bar_idx, price FROM structure_events WHERE scope = 'swing' ORDER BY timeframe, bar_idx ASC").all();
  db.close();

  const obById = new Map(obRows.map((o) => [o.id, o]));
  const structByTf = new Map();
  for (const r of structRows) { if (!structByTf.has(r.timeframe)) structByTf.set(r.timeframe, []); structByTf.get(r.timeframe).push(r); }
  const entriesByTf = new Map();
  for (const t of touchRows) {
    const ob = obById.get(t.order_block_id);
    if (!entriesByTf.has(ob.timeframe)) entriesByTf.set(ob.timeframe, []);
    entriesByTf.get(ob.timeframe).push({ startBarIdx: t.start_bar_idx, ob });
  }

  const confirmedParams = { takerFeePct: FEE_TIERS.bitunix_futures_vip1.takerFeePct, fundingPctPerHour: REPRESENTATIVE_FUNDING_PCT_PER_HOUR };

  for (const rMult of R_MULTIPLES) {
    console.log(`\n========== ${rMult}R (recurrence_count >= ${RECURRENCE_MIN}) ==========`);
    const trades = [];
    for (const [tf, entries] of entriesByTf) {
      const candles = await loadCandles(tf);
      const structEvents = structByTf.get(tf) || [];
      for (const e of entries) {
        const entryIdx = e.startBarIdx + 1;
        if (entryIdx >= candles.length) continue;
        const entryPrice = candles[entryIdx].o, entryTime = candles[entryIdx].t;
        const side = e.ob.side === "bullish" ? "long" : "short";
        const stopPrice = e.ob.side === "bullish" ? e.ob.bar_low : e.ob.bar_high;
        const risk = Math.abs(entryPrice - stopPrice);
        if (risk <= 0) continue;
        const malformed = side === "long" ? stopPrice >= entryPrice : stopPrice <= entryPrice;
        if (malformed) continue;
        const swingLine = findCurrentSwingLine(structEvents, e.startBarIdx);
        if (swingLine == null) continue;
        // Corrected per iapaulo's exact wording: "red ob at/over green swingline, blue ob at/under
        // red swing line" -- the swing line's OWN color/side must ALSO match (not just any swing
        // line's price level, which is what the previous version of this test actually checked).
        const correctPosition =
          e.ob.side === "bearish" ? (swingLine.side === "bullish" && e.ob.bar_low >= swingLine.price)
          : (swingLine.side === "bearish" && e.ob.bar_high <= swingLine.price);
        const targetPrice = side === "long" ? entryPrice + rMult * risk : entryPrice - rMult * risk;
        const result = simulateFixedR(candles, entryIdx, side, stopPrice, targetPrice);
        if (!result) continue;
        const pnlPct = side === "long" ? (result.exitPrice - entryPrice) / entryPrice : (entryPrice - result.exitPrice) / entryPrice;
        trades.push({ side, entryTime, entryPrice, exitTime: result.exitTime, exitPrice: result.exitPrice, pnlPct, win: result.win, correctPosition, timeframe: tf });
      }
    }
    console.log(`${trades.length} touches with a known current swing line level`);
    const matching = trades.filter((t) => t.correctPosition), notMatching = trades.filter((t) => !t.correctPosition);
    console.log(`  correct position (red at/over GREEN line / blue at/under RED line): n=${matching.length}  not: n=${notMatching.length}`);

    const labels = trades.map((t) => t.correctPosition), wins = trades.map((t) => t.win);
    const test = permTest(wins, labels, ITERATIONS, SEED);
    console.log(`  win rate: matching=${(winRate(matching.map((t) => t.win)) * 100).toFixed(1)}% not=${(winRate(notMatching.map((t) => t.win)) * 100).toFixed(1)}%  gap=${(test.realGap * 100).toFixed(1)}pts p=${test.p.toFixed(4)}${test.p < 0.05 ? "*" : ""}`);

    function reportCost(label, bucketTrades) {
      if (bucketTrades.length < 30) { console.log(`  ${label}: n=${bucketTrades.length} (too thin)`); return; }
      const gross = computeMetrics(bucketTrades);
      const costed = applyCosts(bucketTrades, confirmedParams);
      console.log(`  ${label.padEnd(16)} n=${gross.trade_count} win=${(gross.win_rate * 100).toFixed(1)}% PF=${gross.profit_factor?.toFixed(2)} gross_exp=${(expectancy(bucketTrades) * 100).toFixed(4)}% costed_exp=${(expectancy(costed) * 100).toFixed(4)}% ${expectancy(costed) > 0 ? "(CLEARS)" : ""}`);
    }
    console.log(`  --- cost/capacity ---`);
    reportCost("matching", matching);
    reportCost("not matching", notMatching);
  }

  const RESULTS_DIR = new URL("results/", import.meta.url);
  mkdirSync(RESULTS_DIR, { recursive: true });
}

main().catch((err) => { console.error("Fatal:", err); process.exit(1); });
