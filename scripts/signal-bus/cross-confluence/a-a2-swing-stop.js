#!/usr/bin/env node
// A and A2 -- ORDER-BLOCK-HEIGHT STOP versus SWING-STRUCTURAL STOP.
//
// #174 found the defect this tests: A and A2 place their stop at the ORDER BLOCK'S OWN EDGE
// (bar_low for a bullish block, bar_high for a bearish one). A thin block therefore yields a
// near-zero risk unit -- riskPct reaches 1.012e-7 -- and realised R explodes to -9,881, with 671
// trades worse than -5R and 170 worse than -20R across the population. **The percentage loss stays
// bounded, which is why this never showed up in any expectancy figure; it only appears when you try
// to SIZE the position, where risking 0.5% of equity against a 1e-7 stop implies ~5,000x equity.**
//
// #175 established that a swing stop CANNOT degenerate, because it is anchored to real structure
// rather than to one candle's body. So for A and A2 this is not an expectancy tweak -- it is a test
// of whether the strategies become SIZEABLE AT ALL. That is a different question from the one asked
// of K>=3 in #175, where the OB-height problem does not exist.
//
// **BOTH VIEWS ARE REPORTED AND NEITHER IS PRIVILEGED.** #175 normalised to R and called ATR the
// winner, which silently assumed fixed-fractional-risk sizing. That assumption is not neutral:
//   * If you size to risk a fixed % of equity, R per trade is what compounds -> the R column decides.
//   * If you take a fixed position size, the raw % per trade is what lands in the account -> the
//     net% column decides.
// Which applies is a fact about how the book is run, not something this file gets to assert. The
// DEGENERACY column is reported alongside both, because a construction that cannot be sized has no
// usable number in either column.
//
// Stop-first on ambiguous bars, MTM at the hold limit, ATR-scaled slippage in both modes (execution
// friction is a volatility property and is independent of where the stop sits).

import { DatabaseSync } from "node:sqlite";
import { loadCandles } from "../../backtest/lib/load-candles.js";
import { FEE_TIERS, REPRESENTATIVE_FUNDING_PCT_PER_HOUR } from "../../backtest/lib/costs.js";
import { computeSwingPivotSeries } from "../smc/calc.js";
import { classifyEngulfment } from "../smc/engulfment.js";

const ATR_LEN = 14, R_MULT = 2, HOLD_BARS = 200;
const SLIP_ENTRY_ATR = 0.05, SLIP_STOP_ATR = 0.15, SLIP_TARGET_ATR = 0;
const TAKER = FEE_TIERS.bitunix_futures_vip1.takerFeePct;
const DEGENERATE_RISK_PCT = 0.0005;   // 0.05% of price: below this a fixed-risk size is unusable
const TFS = ["5m", "15m", "1h", "4h"];
const FIRST_TOUCH_ONLY = !process.argv.includes("--all-touches");

const mean = (xs) => (xs.length ? xs.reduce((s, x) => s + x, 0) / xs.length : NaN);
const median = (xs) => { const s = [...xs].sort((a, b) => a - b); return s.length ? s[Math.floor(s.length / 2)] : NaN; };
function atrSeries(c, L) {
  const tr = c.map((x, i) => (i === 0 ? x.h - x.l : Math.max(x.h - x.l, Math.abs(x.h - c[i - 1].c), Math.abs(x.l - c[i - 1].c))));
  const o = new Array(c.length).fill(NaN);
  let s = 0; for (let i = 0; i < L; i++) s += tr[i];
  o[L - 1] = s / L;
  for (let i = L; i < c.length; i++) o[i] = (o[i - 1] * (L - 1) + tr[i]) / L;
  return o;
}
function runTrade(c, atr, idx, side, stopPrice) {
  const a = atr[idx];
  if (!Number.isFinite(a) || a <= 0 || !Number.isFinite(stopPrice)) return null;
  const entry = side === "long" ? c[idx].o + SLIP_ENTRY_ATR * a : c[idx].o - SLIP_ENTRY_ATR * a;
  const risk = side === "long" ? entry - stopPrice : stopPrice - entry;
  if (!(risk > 0)) return null;
  const tgt = side === "long" ? entry + R_MULT * risk : entry - R_MULT * risk;
  const end = Math.min(c.length - 1, idx + HOLD_BARS);
  let pnl = null, hours = 0, won = 0;
  for (let j = idx; j <= end; j++) {
    const b = c[j];
    const hs = side === "long" ? b.l <= stopPrice : b.h >= stopPrice;
    const ht = side === "long" ? b.h >= tgt : b.l <= tgt;
    if (hs) { const f = side === "long" ? stopPrice - SLIP_STOP_ATR * a : stopPrice + SLIP_STOP_ATR * a;
      pnl = side === "long" ? (f - entry) / entry : (entry - f) / entry; hours = (b.t - c[idx].t) / 3600; won = 0; break; }
    if (ht) { const f = side === "long" ? tgt - SLIP_TARGET_ATR * a : tgt + SLIP_TARGET_ATR * a;
      pnl = side === "long" ? (f - entry) / entry : (entry - f) / entry; hours = (b.t - c[idx].t) / 3600; won = 1; break; }
  }
  if (pnl === null) {
    if (end <= idx) return null;
    const b = c[end];
    const f = side === "long" ? b.c - SLIP_ENTRY_ATR * a : b.c + SLIP_ENTRY_ATR * a;
    pnl = side === "long" ? (f - entry) / entry : (entry - f) / entry;
    hours = (b.t - c[idx].t) / 3600; won = pnl > 0 ? 1 : 0;
  }
  const net = pnl - 2 * TAKER - REPRESENTATIVE_FUNDING_PCT_PER_HOUR * Math.max(0, hours);
  const riskPct = risk / entry;
  return { net, won, riskPct, R: net / riskPct };
}

async function main() {
  console.log("A and A2 -- OB-HEIGHT STOP versus SWING-STRUCTURAL STOP.");
  console.log("#174 found the OB-height stop degenerates (riskPct -> 1.0e-7, realised R -> -9,881).");
  console.log("#175 established a swing stop cannot degenerate. Both views reported; neither privileged.");
  console.log(`Degenerate = riskPct < ${(DEGENERATE_RISK_PCT * 100).toFixed(2)}% of price, i.e. unsizeable by a fixed-risk rule.\n`);

  const db = new DatabaseSync(new URL("../../../data/signal-bus/smc.db", import.meta.url), { readOnly: true });

  // Population is taken EXACTLY as the real builders take it, not approximated. Entries come from
  // `order_block_touches` (a block can be touched several times, each a separate trade), NOT from
  // mitigated_time -- an earlier version of this file used mitigated_time and would have measured a
  // different and smaller population than A/A2 actually trade.
  const allOb = db.prepare("SELECT id, timeframe, side, bar_high, bar_low, recurrence_count FROM order_blocks WHERE instrument='BTC'").all();
  classifyEngulfment(allOb);
  const touches = db.prepare("SELECT order_block_id, start_bar_idx FROM order_block_touches").all();
  db.close();
  const touchesByOb = new Map();
  for (const t of touches) {
    if (!touchesByOb.has(t.order_block_id)) touchesByOb.set(t.order_block_id, []);
    touchesByOb.get(t.order_block_id).push(t.start_bar_idx);
  }

  const candlesByTf = {}, atrByTf = {}, pivByTf = {};
  for (const tf of TFS) {
    const c = await loadCandles(tf, "BTC");
    candlesByTf[tf] = c; atrByTf[tf] = atrSeries(c, ATR_LEN); pivByTf[tf] = computeSwingPivotSeries(c);
  }

  for (const [label, pop] of [
    ["A  (recurrence>=3)", allOb.filter((o) => o.recurrence_count >= 3)],
    ["A2 (recurrence>=3 + engulfment)", allOb.filter((o) => o.recurrence_count >= 3 && o.engulfmentClass === "engulfment")],
  ]) {
    const res = { ob: [], swing: [] };
    let swingUnavailable = 0;
    for (const ob of pop) {
      const c = candlesByTf[ob.timeframe];
      if (!c) continue;
      const atr = atrByTf[ob.timeframe], piv = pivByTf[ob.timeframe];
      // FIRST TOUCH ONLY. iapaulo's objection, and it is correct: a block can be tapped many times
      // as price oscillates around its edge, and `order_block_touches` logs every crossing. A has
      // 13,570 qualifying blocks producing 43,189 entries -- 3.2 per block -- so the population the
      // portfolio rows report is not 43,189 independent opportunities, it is 13,570 setups counted
      // repeatedly at nearly the same price. Nobody trades the fifth re-tap of a line.
      const allTouches = (touchesByOb.get(ob.id) || []).slice().sort((a, b) => a - b);
      const useTouches = FIRST_TOUCH_ONLY ? allTouches.slice(0, 1) : allTouches;
      for (const startBar of useTouches) {
        const idx = startBar + 1;
        if (idx < 1 || idx >= c.length) continue;
        const side = ob.side === "bullish" ? "long" : "short";
        const tOb = runTrade(c, atr, idx, side, side === "long" ? ob.bar_low : ob.bar_high);
        if (tOb) res.ob.push(tOb);
        const sw = side === "long" ? piv.swingLowLevel[idx - 1] : piv.swingHighLevel[idx - 1];
        const tSw = runTrade(c, atr, idx, side, sw);
        if (tSw) res.swing.push(tSw); else swingUnavailable++;
      }
    }
    console.log(`  ${label}   blocks=${pop.length.toLocaleString()}`);
    console.log("    stop mode        n      win%     net%/trade    mean risk%   median risk%      R/trade   DEGENERATE");
    for (const mode of ["ob", "swing"]) {
      const g = res[mode];
      if (!g.length) { console.log(`    ${mode.padEnd(14)} none`); continue; }
      const deg = g.filter((t) => t.riskPct < DEGENERATE_RISK_PCT).length;
      console.log(
        `    ${(mode === "ob" ? "OB height" : "swing").padEnd(14)}${String(g.length).padStart(6)}` +
        `${(g.filter((t) => t.won).length / g.length * 100).toFixed(1).padStart(10)}%` +
        `${(mean(g.map((t) => t.net)) * 100).toFixed(4).padStart(14)}%` +
        `${(mean(g.map((t) => t.riskPct)) * 100).toFixed(3).padStart(13)}%` +
        `${(median(g.map((t) => t.riskPct)) * 100).toFixed(3).padStart(14)}%` +
        `${mean(g.map((t) => t.R)).toFixed(3).padStart(13)}` +
        `${String(deg).padStart(13)} (${((deg / g.length) * 100).toFixed(1)}%)`,
      );
    }
    if (swingUnavailable) console.log(`    (swing level unavailable or wrong-side on ${swingUnavailable} setups)`);
    console.log("");
  }
  console.log("  R/trade is the column that compounds under fixed-fractional-risk sizing.");
  console.log("  net%/trade is the column that lands in the account under fixed position size.");
  console.log("  DEGENERATE counts setups a fixed-risk rule cannot size at all -- those have no usable");
  console.log("  number in either column, which is why #174 called this a sizing defect and not a result.");
}

main().catch((e) => { console.error("Fatal:", e); process.exit(1); });
