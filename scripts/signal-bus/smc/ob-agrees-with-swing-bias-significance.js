#!/usr/bin/env node
// Tests the precise hypothesis iapaulo described directly from daily live chart-watching: "opposing
// ob above or below swing line, by definition the swing lines are directional, the ob just
// confirms" -- does an order block whose own side (bullish/bearish) AGREES with the prevailing swing
// structure bias (the most recent swing-scope BOS/CHoCH direction at the time of the touch) predict
// a better outcome than one that disagrees? This is DIFFERENT from #62 (falsified) -- #62 tested
// whether an OB sits AT/BELOW the exact structure break point (a location/proximity test); this
// tests whether the OB's DIRECTION matches the swing trend's current direction (a bias-agreement
// test), which is the more basic, decision-policy.md-style framing and had not been isolated as its
// own standalone test anywhere in this register.
//
// Same trade construction as recurrence-backtest-fixed-rr.js/#27b: entry = touch start_bar_idx+1
// open; stop = OB's own far boundary; target = R-multiple of risk. Swing bias determined causally
// (last swing-scope structure_event at or before the TOUCH bar, same timeframe -- not the OB's own
// origin bar, since "prevailing bias when about to enter" is what a live trader actually sees).
//
// Usage: node scripts/signal-bus/smc/ob-agrees-with-swing-bias-significance.js [--r=1,1.5,2,3] [--iterations=20000]

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
const ITERATIONS = parseInt(args.iterations || "20000", 10);
const SEED = 42;

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
function expectancy(trades) { return trades.length ? trades.reduce((s, t) => s + t.pnlPct, 0) / trades.length : null; }
function winRate(vals) { return vals.length ? vals.reduce((s, x) => s + x, 0) / vals.length : null; }
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
  return { realGap, p: geq / iterations, nA: groupA.length, nB: groupB.length };
}

function findPrevailingBias(sortedEvents, barIdx) {
  let lo = 0, hi = sortedEvents.length - 1, ans = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (sortedEvents[mid].bar_idx <= barIdx) { ans = mid; lo = mid + 1; }
    else hi = mid - 1;
  }
  return ans === -1 ? null : sortedEvents[ans].side;
}

async function main() {
  const db = new DatabaseSync(SMC_DB_PATH, { readOnly: true });
  const obRows = db.prepare("SELECT id, timeframe, side, bar_high, bar_low, recurrence_count FROM order_blocks").all();
  const touchRows = db.prepare("SELECT order_block_id, start_bar_idx FROM order_block_touches").all();
  const structRows = db.prepare("SELECT timeframe, side, bar_idx FROM structure_events WHERE scope = 'swing' ORDER BY timeframe, bar_idx ASC").all();
  db.close();

  const obById = new Map(obRows.map((o) => [o.id, o]));
  const structByTf = new Map();
  for (const r of structRows) {
    if (!structByTf.has(r.timeframe)) structByTf.set(r.timeframe, []);
    structByTf.get(r.timeframe).push(r);
  }
  const entriesByTf = new Map();
  for (const t of touchRows) {
    const ob = obById.get(t.order_block_id);
    if (!entriesByTf.has(ob.timeframe)) entriesByTf.set(ob.timeframe, []);
    entriesByTf.get(ob.timeframe).push({ startBarIdx: t.start_bar_idx, ob });
  }

  const confirmedParams = { takerFeePct: FEE_TIERS.bitunix_futures_vip1.takerFeePct, fundingPctPerHour: REPRESENTATIVE_FUNDING_PCT_PER_HOUR };

  for (const rMult of R_MULTIPLES) {
    console.log(`\n========== ${rMult}R ==========`);
    const trades = [];
    for (const [tf, entries] of entriesByTf) {
      const candles = await loadCandles(tf);
      const structEvents = structByTf.get(tf) || [];
      for (const e of entries) {
        const entryIdx = e.startBarIdx + 1;
        if (entryIdx >= candles.length) continue;
        const bias = findPrevailingBias(structEvents, e.startBarIdx);
        if (bias == null) continue;
        const entryPrice = candles[entryIdx].o, entryTime = candles[entryIdx].t;
        const side = e.ob.side === "bullish" ? "long" : "short";
        const stopPrice = e.ob.side === "bullish" ? e.ob.bar_low : e.ob.bar_high;
        const risk = Math.abs(entryPrice - stopPrice);
        if (risk <= 0) continue;
        // Exclude malformed touches: the OB's own boundary has already been breached by entry time
        // (stop on the wrong side of entry) -- not a valid, executable stop-loss, found and
        // quantified 2026-08-10 (affects ~5.75% of #27b's own population too, doesn't overturn it).
        const malformed = side === "long" ? stopPrice >= entryPrice : stopPrice <= entryPrice;
        if (malformed) continue;
        const targetPrice = side === "long" ? entryPrice + rMult * risk : entryPrice - rMult * risk;
        const result = simulateFixedR(candles, entryIdx, side, stopPrice, targetPrice);
        if (!result) continue;
        const pnlPct = side === "long" ? (result.exitPrice - entryPrice) / entryPrice : (entryPrice - result.exitPrice) / entryPrice;
        const agrees = e.ob.side === bias;
        trades.push({ side, entryTime, entryPrice, exitTime: result.exitTime, exitPrice: result.exitPrice, pnlPct, win: result.win, agrees, timeframe: tf, recurrenceCount: e.ob.recurrence_count });
      }
    }
    console.log(`${trades.length} order-block touches with a known prevailing swing bias`);
    const mismatches = trades.filter((t) => (t.win === 1) !== (t.pnlPct > 0));
    if (mismatches.length) console.log(`  !! ${mismatches.length} trades where win-field and pnlPct sign disagree, e.g.`, mismatches.slice(0, 3));
    const agreeing = trades.filter((t) => t.agrees), disagreeing = trades.filter((t) => !t.agrees);
    console.log(`  agrees with swing bias: n=${agreeing.length}  disagrees: n=${disagreeing.length}`);

    const wins = trades.map((t) => t.win), labels = trades.map((t) => t.agrees);
    const test = permTest(wins, labels, ITERATIONS, SEED);
    console.log(`  win rate: agrees=${(winRate(agreeing.map((t) => t.win)) * 100).toFixed(1)}% disagrees=${(winRate(disagreeing.map((t) => t.win)) * 100).toFixed(1)}%  gap=${(test.realGap * 100).toFixed(1)}pts p=${test.p.toFixed(4)}${test.p < 0.05 ? "*" : ""}`);

    function reportCost(label, bucketTrades) {
      if (bucketTrades.length < 30) { console.log(`  ${label}: n=${bucketTrades.length} (too thin)`); return; }
      const gross = computeMetrics(bucketTrades);
      const costed = applyCosts(bucketTrades, confirmedParams);
      console.log(`  ${label.padEnd(16)} n=${gross.trade_count} win=${(gross.win_rate * 100).toFixed(1)}% PF=${gross.profit_factor?.toFixed(2)} gross_exp=${(expectancy(bucketTrades) * 100).toFixed(4)}% costed_exp=${(expectancy(costed) * 100).toFixed(4)}% ${expectancy(costed) > 0 ? "(CLEARS)" : ""}`);
    }
    console.log(`  --- cost/capacity ---`);
    reportCost("agrees", agreeing);
    reportCost("disagrees", disagreeing);
  }
}

main().catch((err) => { console.error("Fatal:", err); process.exit(1); });
