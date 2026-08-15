#!/usr/bin/env node
// Tests iapaulo's exact stacked live pattern, as one combined condition instead of the single
// stripped-down factor tested (and found null) in ob-agrees-with-swing-bias-significance.js/#85:
// an order block that (a) agrees with the prevailing swing structure bias (BOS/CHoCH direction,
// same as #85, malformed-trade-excluded) AND (b) sits price-confluent with a same-side, live D4M
// (Divergence-for-Many) zone at the time of touch. iapaulo's own example: a blue (bullish) OB
// under a red CHoCH, under a green D4M line, found support -- OB direction relative to structure
// PLUS a same-side D4M zone at the same level, together, not stripped apart and averaged separately.
// Related precedent: #63 tested a similar triple-stack (Boom Hunter OB + at/below solid structure +
// D4M zone) and found it marginal/non-replicating -- but that was scoped to Boom Hunter's
// full-sequence OBs specifically, not general SMC swing order blocks, so it doesn't settle this.
//
// Trade construction identical to #27b/#85: entry = touch's next-bar open; stop = OB's own far
// boundary; target = R-multiple of risk; malformed (stop-on-wrong-side-of-entry) touches excluded
// (#85's fix). D4M confluence: a same-side D4M zone whose price falls within PRICE_TOLERANCE_PCT of
// the OB's own range, and whose zone was live (confirmed <= touch time <= expiry, or unexpired) at
// touch time.
//
// Usage: node scripts/signal-bus/smc/ob-choch-d4m-confluence-significance.js [--r=1,1.5,2,3] [--recurrence-min=1] [--price-tolerance=0.005]

import { DatabaseSync } from "node:sqlite";
import { writeFileSync, mkdirSync } from "fs";
import { execSync } from "child_process";
import { loadCandles } from "../../backtest/lib/load-candles.js";
import { computeMetrics } from "../../backtest/lib/metrics.js";
import { applyCosts, FEE_TIERS, REPRESENTATIVE_FUNDING_PCT_PER_HOUR } from "../../backtest/lib/costs.js";

const SMC_DB_PATH = new URL("../../../data/signal-bus/smc.db", import.meta.url);
const D4M_DB_PATH = new URL("../../../data/signal-bus/divergence-for-many.db", import.meta.url);
const MAX_HOLD_BARS = 200;
const args = Object.fromEntries(process.argv.slice(2).map((a) => a.replace(/^--/, "").split("=")));
const R_MULTIPLES = (args.r || "1,1.5,2,3").split(",").map(Number);
const RECURRENCE_MIN = parseInt(args["recurrence-min"] || "1", 10);
const PRICE_TOLERANCE_PCT = parseFloat(args["price-tolerance"] || "0.005");
// Tightened per iapaulo's direct request: D4M proximity scaled to the trade's OWN risk distance (R)
// instead of a flat % of price -- for BTC ~$65k, 0.5% of price is ~$325, likely far wider than the
// actual OB risk distance for a recurrence-filtered order block, making the old tolerance too loose
// to mean "the D4M zone is actually AT this level" in any risk-relevant sense. Only used when
// --price-tolerance-r is passed; falls back to the flat % tolerance otherwise.
const PRICE_TOLERANCE_R = args["price-tolerance-r"] != null ? parseFloat(args["price-tolerance-r"]) : null;
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
  return { realGap, p: geq / iterations, nA: groupA.length, nB: groupB.length };
}
const RECENT_CHOCH_WINDOW_BARS = 200; // same window as MAX_HOLD_BARS -- "recent" local structure, not any historical CHoCH
function findMostRecentChoch(sortedEvents, barIdx) {
  let lo = 0, hi = sortedEvents.length - 1, ans = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (sortedEvents[mid].bar_idx <= barIdx) { ans = mid; lo = mid + 1; }
    else hi = mid - 1;
  }
  if (ans === -1) return null;
  if (barIdx - sortedEvents[ans].bar_idx > RECENT_CHOCH_WINDOW_BARS) return null;
  return sortedEvents[ans].side;
}

async function main() {
  const smcDb = new DatabaseSync(SMC_DB_PATH, { readOnly: true });
  const obRows = smcDb.prepare("SELECT id, timeframe, side, bar_high, bar_low, recurrence_count FROM order_blocks WHERE recurrence_count >= ?").all(RECURRENCE_MIN);
  const touchRows = smcDb.prepare(
    `SELECT order_block_id, start_bar_idx FROM order_block_touches WHERE order_block_id IN (${obRows.map(() => "?").join(",") || "0"})`,
  ).all(...obRows.map((o) => o.id));
  // CHOCH only (not BOS) -- a CHoCH is specifically a character-change/reversal marker, matching
  // iapaulo's own wording ("under a red choch"). Internal scope: a reversal-off-recent-structure
  // setup is a local/tactical event, not necessarily tied to the larger swing trend.
  const structRows = smcDb.prepare("SELECT timeframe, side, bar_idx FROM structure_events WHERE scope = 'internal' AND type = 'CHOCH' ORDER BY timeframe, bar_idx ASC").all();
  smcDb.close();

  const d4mDb = new DatabaseSync(D4M_DB_PATH, { readOnly: true });
  const zoneRows = d4mDb.prepare("SELECT timeframe, side, price, confirmed_time, expires_time FROM zones").all();
  d4mDb.close();

  const obById = new Map(obRows.map((o) => [o.id, o]));
  const structByTf = new Map();
  for (const r of structRows) { if (!structByTf.has(r.timeframe)) structByTf.set(r.timeframe, []); structByTf.get(r.timeframe).push(r); }
  const zonesByTfSide = new Map();
  for (const z of zoneRows) {
    const key = `${z.timeframe}:${z.side}`;
    if (!zonesByTfSide.has(key)) zonesByTfSide.set(key, []);
    zonesByTfSide.get(key).push(z);
  }
  const entriesByTf = new Map();
  for (const t of touchRows) {
    const ob = obById.get(t.order_block_id);
    if (!entriesByTf.has(ob.timeframe)) entriesByTf.set(ob.timeframe, []);
    entriesByTf.get(ob.timeframe).push({ startBarIdx: t.start_bar_idx, ob });
  }

  function hasD4mConfluence(ob, touchTime, risk) {
    const zones = zonesByTfSide.get(`${ob.timeframe}:${ob.side}`);
    if (!zones) return false;
    const tol = PRICE_TOLERANCE_R != null ? risk * PRICE_TOLERANCE_R : ((ob.bar_high + ob.bar_low) / 2) * PRICE_TOLERANCE_PCT;
    return zones.some((z) => {
      if (z.confirmed_time > touchTime) return false;
      if (z.expires_time != null && touchTime > z.expires_time) return false;
      return z.price >= ob.bar_low - tol && z.price <= ob.bar_high + tol;
    });
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
        const recentChochSide = findMostRecentChoch(structEvents, e.startBarIdx);
        if (recentChochSide == null) continue;
        // A reversal/rejection OB is, by construction, on the OPPOSITE side of the local CHoCH it's
        // rejecting -- iapaulo's exact framing (blue OB under a RED CHoCH). This is the corrected
        // condition; #86's "agrees with prevailing bias" version could never match this pattern.
        const opposesRecentChoch = e.ob.side !== recentChochSide;
        const d4mConfluent = hasD4mConfluence(e.ob, entryTime, risk);
        const targetPrice = side === "long" ? entryPrice + rMult * risk : entryPrice - rMult * risk;
        const result = simulateFixedR(candles, entryIdx, side, stopPrice, targetPrice);
        if (!result) continue;
        const pnlPct = side === "long" ? (result.exitPrice - entryPrice) / entryPrice : (entryPrice - result.exitPrice) / entryPrice;
        trades.push({ side, entryTime, entryPrice, exitTime: result.exitTime, exitPrice: result.exitPrice, pnlPct, win: result.win, opposesRecentChoch, d4mConfluent, timeframe: tf });
      }
    }
    console.log(`${trades.length} touches with a recent (within ${RECENT_CHOCH_WINDOW_BARS} bars) internal CHoCH`);
    const fullStack = trades.filter((t) => t.opposesRecentChoch && t.d4mConfluent);
    const structOnly = trades.filter((t) => t.opposesRecentChoch && !t.d4mConfluent);
    const d4mOnly = trades.filter((t) => !t.opposesRecentChoch && t.d4mConfluent);
    const neither = trades.filter((t) => !t.opposesRecentChoch && !t.d4mConfluent);
    console.log(`  full stack (reversal-CHoCH+D4M): n=${fullStack.length}  reversal-CHoCH only: n=${structOnly.length}  D4M only: n=${d4mOnly.length}  neither: n=${neither.length}`);

    const labels = trades.map((t) => t.opposesRecentChoch && t.d4mConfluent);
    const wins = trades.map((t) => t.win);
    const test = permTest(wins, labels, ITERATIONS, SEED);
    console.log(`  full-stack vs rest: win ${(winRate(fullStack.map((t) => t.win)) * 100).toFixed(1)}% vs ${(winRate(trades.filter((t) => !(t.opposesRecentChoch && t.d4mConfluent)).map((t) => t.win)) * 100).toFixed(1)}%  gap=${(test.realGap * 100).toFixed(1)}pts p=${test.p.toFixed(4)}${test.p < 0.05 ? "*" : ""}`);

    function reportCost(label, bucketTrades) {
      if (bucketTrades.length < 30) { console.log(`  ${label}: n=${bucketTrades.length} (too thin)`); return; }
      const gross = computeMetrics(bucketTrades);
      const costed = applyCosts(bucketTrades, confirmedParams);
      console.log(`  ${label.padEnd(20)} n=${gross.trade_count} win=${(gross.win_rate * 100).toFixed(1)}% PF=${gross.profit_factor?.toFixed(2)} gross_exp=${(expectancy(bucketTrades) * 100).toFixed(4)}% costed_exp=${(expectancy(costed) * 100).toFixed(4)}% ${expectancy(costed) > 0 ? "(CLEARS)" : ""}`);
    }
    console.log(`  --- cost/capacity ---`);
    reportCost("full stack", fullStack);
    reportCost("structure only", structOnly);
    reportCost("D4M only", d4mOnly);
    reportCost("neither", neither);
  }
}

main().catch((err) => { console.error("Fatal:", err); process.exit(1); });
