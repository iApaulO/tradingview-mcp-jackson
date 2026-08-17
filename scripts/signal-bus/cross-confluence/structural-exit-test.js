#!/usr/bin/env node
// STRUCTURAL EXITS versus a FIXED 2R TARGET, on the entry rule #177 established.
//
// iapaulo: "there has to be a better way to solidify proper entry exit." He is pointing at a real
// internal inconsistency. After #177 the ENTRY is structural and confirmation-gated -- touch the
// block, wait for price to close back outside it, enter next bar. The EXIT is still a fixed 2R
// target and a 200-bar clock: an arbitrary volatility objective bolted onto a structural setup.
// That is the same mismatch #175 identified for stops, and #177 showed that fixing the entry side
// moved A from -0.225R to +0.406R.
//
// HELD CONSTANT so only the exit varies: entry = first touch, react_reclaim (close back outside the
// block, enter next bar's open, 12-bar confirmation window, skip if unconfirmed); stop = the order
// block's own edge, which #177 found beats the swing stop risk-adjusted on this population.
//
// EXIT RULES COMPARED:
//   fixed_2R        -- the current construction. Target at 2x the stop distance, 200-bar hold.
//   opposing_struct -- exit on the first BOS or CHoCH against the position, same timeframe. This is
//                      the structural analogue of the entry: leave when structure says the premise
//                      is gone, not when an arbitrary multiple is reached.
//   trailing_swing  -- ratchet the stop to each newly confirmed swing low (long) / high (short),
//                      never loosening it. No target at all; the trade runs until structure takes it.
//   struct_or_2R    -- whichever comes first, opposing structure or the 2R target. The hybrid, since
//                      a pure structural exit gives back open profit and a pure target caps winners.
//
// available_at: swing levels are read at the bar BEFORE the decision, and structure events are used
// only from their recorded confirmation time forward. No exit rule may consult a bar the position
// has not yet lived through.
//
// A pure trailing exit has NO fixed target, so its R distribution is unbounded upward. That makes
// mean R the wrong headline on its own -- median R and win rate are reported alongside, because a
// trailing rule can post a high mean off a few large winners while losing most trades.

import { DatabaseSync } from "node:sqlite";
import { loadCandles } from "../../backtest/lib/load-candles.js";
import { FEE_TIERS, REPRESENTATIVE_FUNDING_PCT_PER_HOUR } from "../../backtest/lib/costs.js";
import { computeSwingPivotSeries } from "../smc/calc.js";

const ATR_LEN = 14, R_MULT = 2, HOLD_BARS = 200, CONFIRM_WINDOW = 12;
const SLIP_ENTRY_ATR = 0.05, SLIP_STOP_ATR = 0.15, SLIP_TARGET_ATR = 0;
const TAKER = FEE_TIERS.bitunix_futures_vip1.takerFeePct;
const TFS = ["5m", "15m", "1h", "4h"];
const RULES = ["fixed_2R", "opposing_struct", "trailing_swing", "struct_or_2R"];

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

function runTrade(c, atr, piv, oppTimes, idx, side, stop0, rule) {
  const a = atr[idx];
  if (!Number.isFinite(a) || a <= 0 || !Number.isFinite(stop0)) return null;
  const entry = side === "long" ? c[idx].o + SLIP_ENTRY_ATR * a : c[idx].o - SLIP_ENTRY_ATR * a;
  const risk = side === "long" ? entry - stop0 : stop0 - entry;
  if (!(risk > 0)) return null;
  const tgt = side === "long" ? entry + R_MULT * risk : entry - R_MULT * risk;
  const useTarget = rule === "fixed_2R" || rule === "struct_or_2R";
  const useStruct = rule === "opposing_struct" || rule === "struct_or_2R";
  const useTrail = rule === "trailing_swing";
  const end = Math.min(c.length - 1, idx + HOLD_BARS);

  let stop = stop0, pnl = null, hours = 0, won = 0;
  for (let j = idx; j <= end; j++) {
    const b = c[j];
    if (useTrail && j > idx) {
      // ratchet only -- a trailing stop that can loosen is not a stop
      const lvl = side === "long" ? piv.swingLowLevel[j - 1] : piv.swingHighLevel[j - 1];
      if (Number.isFinite(lvl)) {
        if (side === "long" && lvl > stop && lvl < b.o) stop = lvl;
        if (side === "short" && lvl < stop && lvl > b.o) stop = lvl;
      }
    }
    const hitStop = side === "long" ? b.l <= stop : b.h >= stop;
    if (hitStop) {
      const f = side === "long" ? stop - SLIP_STOP_ATR * a : stop + SLIP_STOP_ATR * a;
      pnl = side === "long" ? (f - entry) / entry : (entry - f) / entry;
      hours = (b.t - c[idx].t) / 3600; won = pnl > 0 ? 1 : 0; break;
    }
    if (useTarget) {
      const hitTgt = side === "long" ? b.h >= tgt : b.l <= tgt;
      if (hitTgt) {
        const f = side === "long" ? tgt - SLIP_TARGET_ATR * a : tgt + SLIP_TARGET_ATR * a;
        pnl = side === "long" ? (f - entry) / entry : (entry - f) / entry;
        hours = (b.t - c[idx].t) / 3600; won = 1; break;
      }
    }
    if (useStruct && j > idx && oppTimes.length) {
      // first opposing structure event confirmed at or before this bar's close
      let lo = 0, hi = oppTimes.length - 1, found = -1;
      while (lo <= hi) { const m = (lo + hi) >> 1; if (oppTimes[m] > c[idx].t && oppTimes[m] <= b.t) { found = m; hi = m - 1; } else if (oppTimes[m] <= c[idx].t) lo = m + 1; else hi = m - 1; }
      if (found >= 0) {
        const f = side === "long" ? b.c - SLIP_ENTRY_ATR * a : b.c + SLIP_ENTRY_ATR * a;
        pnl = side === "long" ? (f - entry) / entry : (entry - f) / entry;
        hours = (b.t - c[idx].t) / 3600; won = pnl > 0 ? 1 : 0; break;
      }
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
  return { net, won, riskPct, R: net / riskPct, hours };
}

async function main() {
  console.log("STRUCTURAL EXITS versus FIXED 2R -- entry held at #177's react_reclaim, stop at OB edge.");
  console.log("Only the EXIT varies. Entry is structural and confirmation-gated; the question is whether");
  console.log("the exit should be too, or whether an arbitrary 2R objective is actually doing better.\n");

  const db = new DatabaseSync(new URL("../../../data/signal-bus/smc.db", import.meta.url), { readOnly: true });
  const allOb = db.prepare("SELECT id, timeframe, side, bar_high, bar_low, recurrence_count FROM order_blocks WHERE instrument='BTC'").all();
  const touches = db.prepare("SELECT order_block_id, start_bar_idx FROM order_block_touches").all();
  const evRows = db.prepare("SELECT timeframe, side, time FROM structure_events WHERE instrument='BTC' ORDER BY time").all();
  db.close();

  const touchesByOb = new Map();
  for (const t of touches) { if (!touchesByOb.has(t.order_block_id)) touchesByOb.set(t.order_block_id, []); touchesByOb.get(t.order_block_id).push(t.start_bar_idx); }
  const oppByTfSide = {};
  for (const tf of TFS) {
    oppByTfSide[tf] = {
      long: evRows.filter((e) => e.timeframe === tf && e.side === "bearish").map((e) => e.time),
      short: evRows.filter((e) => e.timeframe === tf && e.side === "bullish").map((e) => e.time),
    };
  }

  const pop = allOb.filter((o) => o.recurrence_count >= 3);
  const res = Object.fromEntries(RULES.map((r) => [r, []]));

  for (const tf of TFS) {
    const c = await loadCandles(tf, "BTC");
    const atr = atrSeries(c, ATR_LEN);
    const piv = computeSwingPivotSeries(c);
    for (const ob of pop.filter((o) => o.timeframe === tf)) {
      const tlist = (touchesByOb.get(ob.id) || []).slice().sort((a, b) => a - b);
      if (!tlist.length) continue;
      const idx0 = tlist[0] + 1;
      if (idx0 < 1 || idx0 >= c.length) continue;
      const side = ob.side === "bullish" ? "long" : "short";
      // react_reclaim confirmation
      let ei = -1;
      for (let j = idx0; j < Math.min(c.length - 1, idx0 + CONFIRM_WINDOW); j++) {
        const ok = side === "long" ? c[j].c > ob.bar_high : c[j].c < ob.bar_low;
        if (ok) { ei = j + 1; break; }
      }
      if (ei < 1 || ei >= c.length) continue;
      const stop0 = side === "long" ? ob.bar_low : ob.bar_high;
      for (const rule of RULES) {
        const t = runTrade(c, atr, piv, oppByTfSide[tf][side], ei, side, stop0, rule);
        if (t) res[rule].push(t);
      }
    }
  }

  console.log("  exit rule            n      win%     net%/trade      mean R    median R   mean hold(h)");
  for (const rule of RULES) {
    const g = res[rule];
    if (!g.length) { console.log(`  ${rule.padEnd(18)} none`); continue; }
    console.log(
      `  ${rule.padEnd(18)}${String(g.length).padStart(6)}${(g.filter((t) => t.won).length / g.length * 100).toFixed(1).padStart(10)}%` +
      `${(mean(g.map((t) => t.net)) * 100).toFixed(4).padStart(14)}%${mean(g.map((t) => t.R)).toFixed(3).padStart(12)}` +
      `${median(g.map((t) => t.R)).toFixed(3).padStart(12)}${mean(g.map((t) => t.hours)).toFixed(1).padStart(15)}`,
    );
  }
  console.log("\n  trailing_swing has NO fixed target, so its R is unbounded upward -- read median R and");
  console.log("  win rate alongside the mean, since a trailing rule can post a high mean off a few large");
  console.log("  winners while losing most trades.");
}

main().catch((e) => { console.error("Fatal:", e); process.exit(1); });
