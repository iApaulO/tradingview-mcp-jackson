#!/usr/bin/env node
// PRE-REGISTERED SINGLE RUN -- the reclaim confirmation entry, XRP.
//
// Specification: skills/ict-smc-trader/PREREGISTRATION-reclaim-entry.md, committed as a1b25ed with
// NO XRP data present anywhere in the repository at that commit -- verified by `ls data/historical |
// grep -i xrp` returning nothing and no XRP string appearing under scripts/. That is #143's
// standard, which #165 could not claim because SOL's price data already existed when its spec was
// frozen.
//
// **THIS RUNS ONCE.** Every constant below is hard-coded rather than exposed as a flag, on #143's
// reasoning that a sweepable parameter is one that will get swept. There is no --instrument, no
// --window, no --stop. Changing any value in this file after seeing a result invalidates the run and
// must be recorded as such rather than quietly re-run.
//
// THE CLAIM (#176/#177, replicated on three instruments in #179): entering only after price CLOSES
// BACK OUTSIDE the order block beats entering blindly on the touch, on risk-adjusted return, and
// separately collapses the degenerate-stop defect recorded in #174. BTC, ETH and SOL all agree --
// and all three were used to DEVELOP the rule, so under #165's finding that an instrument is spent
// per hypothesis, none of them can test it.
//
// The stop is the ORDER BLOCK'S EDGE and deliberately not the swing level: #175 and #179 both found
// the OB stop superior risk-adjusted in every cell tested, so using the swing stop here would test a
// construction that already lost.

import { DatabaseSync } from "node:sqlite";
import { loadCandles } from "../../backtest/lib/load-candles.js";
import { FEE_TIERS, REPRESENTATIVE_FUNDING_PCT_PER_HOUR } from "../../backtest/lib/costs.js";
import { classifyEngulfment } from "../smc/engulfment.js";
import { dbSuffix } from "../lib/instrument.js";

// ---- FROZEN. Do not parameterise. ----
const INSTRUMENT = "XRP";
const TFS = ["5m", "15m", "1h", "4h"];
const ATR_LEN = 14, R_MULT = 2, HOLD_BARS = 200, CONFIRM_WINDOW = 12;
const SLIP_ENTRY_ATR = 0.05, SLIP_STOP_ATR = 0.15, SLIP_TARGET_ATR = 0;
const TAKER = FEE_TIERS.bitunix_futures_vip1.takerFeePct;
const DEGENERATE_RISK_PCT = 0.0005;
const MIN_N = 60;

const mean = (xs) => (xs.length ? xs.reduce((s, x) => s + x, 0) / xs.length : NaN);

function atrSeries(c, L) {
  const tr = c.map((x, i) => (i === 0 ? x.h - x.l : Math.max(x.h - x.l, Math.abs(x.h - c[i - 1].c), Math.abs(x.l - c[i - 1].c))));
  const o = new Array(c.length).fill(NaN);
  let s = 0;
  for (let i = 0; i < L; i++) s += tr[i];
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
    const hitStop = side === "long" ? b.l <= stopPrice : b.h >= stopPrice;
    const hitTgt = side === "long" ? b.h >= tgt : b.l <= tgt;
    if (hitStop) {
      const f = side === "long" ? stopPrice - SLIP_STOP_ATR * a : stopPrice + SLIP_STOP_ATR * a;
      pnl = side === "long" ? (f - entry) / entry : (entry - f) / entry;
      hours = (b.t - c[idx].t) / 3600; won = 0; break;
    }
    if (hitTgt) {
      const f = side === "long" ? tgt - SLIP_TARGET_ATR * a : tgt + SLIP_TARGET_ATR * a;
      pnl = side === "long" ? (f - entry) / entry : (entry - f) / entry;
      hours = (b.t - c[idx].t) / 3600; won = 1; break;
    }
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
  console.log("PRE-REGISTERED RUN -- reclaim confirmation entry, " + INSTRUMENT + ", executed once.");
  console.log("Spec: skills/ict-smc-trader/PREREGISTRATION-reclaim-entry.md (commit a1b25ed).");
  console.log(`Treatment: FIRST TOUCH, then first candle closing back OUTSIDE the block within ${CONFIRM_WINDOW} bars, enter next bar open.`);
  console.log(`Control: blind entry at touch+1. Stop = OB edge. ${R_MULT}R target, hold<=${HOLD_BARS}, slip ${SLIP_ENTRY_ATR}/${SLIP_STOP_ATR}, taker+funding.\n`);

  const db = new DatabaseSync(new URL(`../../../data/signal-bus/smc${dbSuffix(INSTRUMENT)}.db`, import.meta.url), { readOnly: true });
  const allOb = db.prepare(
    "SELECT id, timeframe, side, bar_high, bar_low, created_time, mitigated_time, recurrence_count FROM order_blocks WHERE instrument = ?",
  ).all(INSTRUMENT);
  classifyEngulfment(allOb);
  const touches = db.prepare("SELECT order_block_id, start_bar_idx FROM order_block_touches").all();
  db.close();

  const touchesByOb = new Map();
  for (const t of touches) {
    if (!touchesByOb.has(t.order_block_id)) touchesByOb.set(t.order_block_id, []);
    touchesByOb.get(t.order_block_id).push(t.start_bar_idx);
  }

  const byTf = {};
  for (const tf of TFS) {
    const c = await loadCandles(tf, INSTRUMENT);
    byTf[tf] = { c, atr: atrSeries(c, ATR_LEN) };
  }

  const cells = {};
  for (const [strat, pop] of [
    ["A", allOb.filter((o) => o.recurrence_count >= 3)],
    ["A2", allOb.filter((o) => o.recurrence_count >= 3 && o.engulfmentClass === "engulfment")],
  ]) {
    const res = { blind: [], reclaim: [] };
    for (const ob of pop) {
      const t = byTf[ob.timeframe];
      if (!t) continue;
      const { c, atr } = t;
      const tl = (touchesByOb.get(ob.id) || []).slice().sort((a, b) => a - b);
      if (!tl.length) continue;
      const idx0 = tl[0] + 1;
      if (idx0 < 1 || idx0 >= c.length) continue;
      const side = ob.side === "bullish" ? "long" : "short";
      const stop = side === "long" ? ob.bar_low : ob.bar_high;

      const tB = runTrade(c, atr, idx0, side, stop);
      if (tB) res.blind.push(tB);

      let ei = -1;
      for (let j = idx0; j < Math.min(c.length - 1, idx0 + CONFIRM_WINDOW); j++) {
        const ok = side === "long" ? c[j].c > ob.bar_high : c[j].c < ob.bar_low;
        if (ok) { ei = j + 1; break; }
      }
      if (ei >= 1 && ei < c.length) {
        const tR = runTrade(c, atr, ei, side, stop);
        if (tR) res.reclaim.push(tR);
      }
    }
    cells[strat] = res;
    console.log(`  ${strat}  qualifying blocks = ${pop.length.toLocaleString()}`);
    console.log("    entry        n      win%     net%/trade      R/trade   DEGENERATE");
    for (const k of ["blind", "reclaim"]) {
      const g = res[k];
      if (!g.length) { console.log(`    ${k.padEnd(10)} none`); continue; }
      const deg = g.filter((x) => x.riskPct < DEGENERATE_RISK_PCT).length;
      console.log(
        `    ${k.padEnd(10)}${String(g.length).padStart(6)}${((g.filter((x) => x.won).length / g.length) * 100).toFixed(1).padStart(10)}%` +
        `${(mean(g.map((x) => x.net)) * 100).toFixed(4).padStart(14)}%${mean(g.map((x) => x.R)).toFixed(3).padStart(13)}` +
        `${String(deg).padStart(12)} (${((deg / g.length) * 100).toFixed(2)}%)`,
      );
    }
    console.log("");
  }

  // ---- criteria from PREREGISTRATION section 3, evaluated mechanically in code ----
  const R = (s, k) => mean(cells[s][k].map((x) => x.R));
  const degShare = (s, k) => cells[s][k].filter((x) => x.riskPct < DEGENERATE_RISK_PCT).length / Math.max(1, cells[s][k].length);
  const nOk = ["A", "A2"].every((s) => cells[s].reclaim.length >= MIN_N);
  const c1 = ["A", "A2"].every((s) => R(s, "reclaim") > R(s, "blind"));
  const c2 = ["A", "A2"].every((s) => R(s, "reclaim") > 0);
  const c4 = ["A", "A2"].every((s) => degShare(s, "reclaim") < degShare(s, "blind") / 2);

  console.log("---- CRITERIA (PREREGISTRATION section 3) ----");
  console.log(`  3. n >= ${MIN_N} in each reclaim cell .............. ${nOk ? "MET" : "NOT MET"}  (A ${cells.A.reclaim.length}, A2 ${cells.A2.reclaim.length})`);
  console.log(`  1. reclaim R > blind R, both strategies ....... ${c1 ? "MET" : "NOT MET"}  (A ${R("A", "blind").toFixed(3)} -> ${R("A", "reclaim").toFixed(3)}, A2 ${R("A2", "blind").toFixed(3)} -> ${R("A2", "reclaim").toFixed(3)})`);
  console.log(`  2. reclaim R > 0, both strategies ............. ${c2 ? "MET" : "NOT MET"}`);
  console.log(`  4. reclaim degeneracy < half blind, both ...... ${c4 ? "MET" : "NOT MET"}  (A ${(degShare("A", "blind") * 100).toFixed(2)}% -> ${(degShare("A", "reclaim") * 100).toFixed(2)}%, A2 ${(degShare("A2", "blind") * 100).toFixed(2)}% -> ${(degShare("A2", "reclaim") * 100).toFixed(2)}%)`);
  const verdict = !nOk ? "INCONCLUSIVE (population floor)" : c1 && c2 && c4 ? "PASS" : "FAIL";
  console.log(`\n  VERDICT: ${verdict}`);
  if (verdict === "PASS") console.log("  Authorises the #33 paper/live-shadow stage for the reclaim entry ONLY. Not portfolio wiring. C-2 and C-3 still apply.");
  if (verdict === "FAIL") console.log("  Recorded as a FAIL. No partial credit, no amendment, no re-run.");
}

main().catch((e) => { console.error("Fatal:", e); process.exit(1); });
