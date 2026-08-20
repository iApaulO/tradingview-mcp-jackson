#!/usr/bin/env node
// MAKER RE-COST -- the same trades from #199, costed the way iapaulo actually says he executes.
//
// HIS EXECUTION, in his words: "that is our entry on trigger order". A trigger/resting limit is not
// a market order. Our cost model has always charged TAKER on both legs plus adverse entry slippage,
// which #199 measured as ~0.30%/trade of drag with roughly HALF of it coming from the slippage
// assumption alone. That is a modelling choice of mine, not a fact about the market, and it does not
// match how he trades.
//
// **WHAT CHANGES, AND WHY EACH CHANGE IS DEFENSIBLE:**
//   ENTRY FEE   taker 0.05% -> MAKER 0.02%. A resting limit adds liquidity.
//   ENTRY SLIP  0.05 ATR -> 0. A limit fills at its price or not at all; it cannot fill worse.
//   TARGET EXIT taker 0.05% -> MAKER 0.02%. The 2R target is a resting limit too. The old model
//               charged taker on BOTH legs unconditionally, which overcharged every winner.
//   STOP EXIT   UNCHANGED -- taker 0.05% AND 0.15 ATR slippage. **A stop is a market order. It
//               crosses the spread and it slips, and it slips worst exactly when you need it. This
//               is the leg that must NOT be softened, and it is not.**
//   MTM EXIT    UNCHANGED -- taker + slippage. Closing a 200-bar-unresolved position is a market out.
//   FUNDING     UNCHANGED at 0.00125%/hr.
//
// **THE ASSUMPTION THIS BUYS AND ITS COST, STATED PLAINLY:** the trade population is held IDENTICAL
// to #199 -- same signals, same entry bar, same prices. That makes this a pure re-cost and removes
// any selection effect. But it also assumes the resting limit ALWAYS FILLS. In reality a limit at a
// level price never reaches simply does not fill: you lose those trades, and they are not a random
// subset -- you preferentially miss the fastest moves away from your level. **So this run is the
// OPTIMISTIC bound on the maker path, and a true resting-limit-at-a-structural-level strategy (his
// actual description, and #180's reclaim shape) would have a different and smaller population. That
// is a separate test, not this one.**
//
// Reported side by side with the all-taker costing so the delta is visible rather than substituted.

import { DatabaseSync } from "node:sqlite";
import { loadCandles } from "../../backtest/lib/load-candles.js";
import { FEE_TIERS, REPRESENTATIVE_FUNDING_PCT_PER_HOUR } from "../../backtest/lib/costs.js";
import { dbSuffix } from "../lib/instrument.js";
import { computeSMC } from "./calc.js";
import { computeBoomHunter } from "../boom-hunter/calc.js";
import { computeWtExtremeFractals } from "../vmc-cipher-b/calc.js";

const ATR_LEN = 14, ATR_MULT = 2.0, R_MULT = 2, HOLD_BARS = 200;
const SLIP_ENTRY_ATR = 0.05, SLIP_STOP_ATR = 0.15;
const TAKER = FEE_TIERS.bitunix_futures_vip1.takerFeePct;   // 0.0005
const MAKER = FEE_TIERS.bitunix_futures_vip1.makerFeePct;   // 0.0002
const MIN_N = 60;
const BULL = 1, BEAR = -1;
const TFS = ["1h", "4h"];
const INSTRUMENTS = ["BTC", "ETH", "SOL", "XRP"];

const mean = (xs) => (xs.length ? xs.reduce((s, x) => s + x, 0) / xs.length : NaN);
const sd = (xs) => { const m = mean(xs); return Math.sqrt(mean(xs.map((x) => (x - m) ** 2))); };
const tOf = (xs) => { if (xs.length < 2) return NaN; const s = sd(xs) * Math.sqrt(xs.length / (xs.length - 1)); return s > 0 ? mean(xs) / (s / Math.sqrt(xs.length)) : NaN; };

function atrSeries(c, L) {
  const tr = c.map((x, i) => (i === 0 ? x.h - x.l : Math.max(x.h - x.l, Math.abs(x.h - c[i - 1].c), Math.abs(x.l - c[i - 1].c))));
  const o = new Array(c.length).fill(NaN);
  let s = 0; for (let i = 0; i < L; i++) s += tr[i];
  o[L - 1] = s / L;
  for (let i = L; i < c.length; i++) o[i] = (o[i - 1] * (L - 1) + tr[i]) / L;
  return o;
}

// **TWO INDEPENDENT SIMULATIONS.** The taker path enters 0.05 ATR worse, so its stop and target sit
// at different absolute prices than the maker path's. A bar can hit one and not the other, which
// means the two paths can RESOLVE DIFFERENTLY -- they are not the same trade with two price tags.
// An earlier version of this file determined the outcome once on the maker levels and applied taker
// prices to it, which contaminated the delta. Each path is now simulated on its own levels.
function simulate(c, atr, idx, mode) {
  const a = atr[idx];
  const risk = ATR_MULT * a;
  const entry = mode === "taker" ? c[idx].o + SLIP_ENTRY_ATR * a : c[idx].o;
  const stop = entry - risk, tgt = entry + R_MULT * risk;
  const end = Math.min(c.length - 1, idx + HOLD_BARS);
  for (let j = idx; j <= end; j++) {
    const b = c[j];
    if (b.l <= stop) {
      const fill = stop - SLIP_STOP_ATR * a;                 // stop slips in BOTH modes
      return { raw: (fill - entry) / entry, outcome: "stop", hours: (b.t - c[idx].t) / 3600 };
    }
    if (b.h >= tgt) return { raw: (tgt - entry) / entry, outcome: "target", hours: (b.t - c[idx].t) / 3600 };
  }
  if (end <= idx) return null;
  const b = c[end];
  const fill = b.c - SLIP_ENTRY_ATR * a;                     // forced market close-out slips in both
  return { raw: (fill - entry) / entry, outcome: "mtm", hours: (b.t - c[idx].t) / 3600 };
}

function runTrade(c, atr, idx) {
  if (idx >= c.length) return null;
  const a = atr[idx];
  if (!Number.isFinite(a) || a <= 0) return null;
  const T = simulate(c, atr, idx, "taker");
  const M = simulate(c, atr, idx, "maker");
  if (!T || !M) return null;
  const fundT = REPRESENTATIVE_FUNDING_PCT_PER_HOUR * Math.max(0, T.hours);
  const fundM = REPRESENTATIVE_FUNDING_PCT_PER_HOUR * Math.max(0, M.hours);
  const exitFeeM = M.outcome === "target" ? MAKER : TAKER;   // a filled limit target is maker
  return {
    gross: M.raw,
    taker: T.raw - 2 * TAKER - fundT,
    maker: M.raw - MAKER - exitFeeM - fundM,
    won: M.outcome === "target" ? 1 : (M.outcome === "mtm" && M.raw > 0 ? 1 : 0),
    outcome: M.outcome,
    diverged: T.outcome !== M.outcome ? 1 : 0,
    hours: M.hours,
  };
}

function show(label, g) {
  if (g.length < MIN_N) return `    ${label.padEnd(38)}${String(g.length).padStart(6)}   below n>=${MIN_N}`;
  const tk = mean(g.map((x) => x.taker)) * 100, mk = mean(g.map((x) => x.maker)) * 100;
  return `    ${label.padEnd(38)}${String(g.length).padStart(6)}` +
    `${(mean(g.map((x) => x.gross)) * 100).toFixed(4).padStart(10)}%` +
    `${tk.toFixed(4).padStart(11)}%${tOf(g.map((x) => x.taker)).toFixed(2).padStart(7)}` +
    `${mk.toFixed(4).padStart(11)}%${tOf(g.map((x) => x.maker)).toFixed(2).padStart(7)}` +
    `${(mk - tk).toFixed(4).padStart(10)}pp`;
}

async function main() {
  console.log("MAKER RE-COST -- identical trades to #199, costed for a resting-limit (trigger) entry.");
  console.log(`  entry ${(MAKER * 100).toFixed(2)}% maker + NO entry slippage | target exit ${(MAKER * 100).toFixed(2)}% maker`);
  console.log(`  STOP EXIT UNCHANGED: ${(TAKER * 100).toFixed(2)}% taker + 0.15 ATR slippage -- a stop is a market order and must not be softened`);
  console.log("  ASSUMES THE LIMIT ALWAYS FILLS. That is the optimistic bound: a real resting limit misses");
  console.log("  the fastest moves away from its level. A true limit-at-a-structural-level test is separate.\n");

  const pool = {};
  const add = (k, t) => { (pool[k] ??= []).push(t); };

  for (const inst of INSTRUMENTS) {
    for (const tf of TFS) {
      const c = await loadCandles(tf, inst);
      if (c.length < 1000) continue;
      const atr = atrSeries(c, ATR_LEN);
      const idxOf = new Map(c.map((x, i) => [x.t, i]));
      const { swingBias } = computeSMC(c);
      const boom = computeBoomHunter(c);
      const q6 = boom.series.q6;

      const sets = {};
      try {
        const db = new DatabaseSync(new URL(`../../../data/signal-bus/smc${dbSuffix(inst)}.db`, import.meta.url), { readOnly: true });
        sets["SMC bullish OB"] = db.prepare("SELECT created_time FROM order_blocks WHERE timeframe=? AND instrument=? AND side='bullish'").all(tf, inst).map((r) => idxOf.get(r.created_time)).filter((v) => v !== undefined);
        sets["SMC bullish CHoCH"] = db.prepare("SELECT time FROM structure_events WHERE timeframe=? AND instrument=? AND type='CHOCH' AND side='bullish'").all(tf, inst).map((r) => idxOf.get(r.time)).filter((v) => v !== undefined);
        db.close();
      } catch { /* no db */ }
      const q6c = [];
      for (let i = 1; i < c.length; i++) if (q6[i] >= 105 && q6[i - 1] < 105) q6c.push(i);
      sets["Boom q6 ceiling"] = q6c;
      sets["Boom Long tiers"] = boom.events.filter((e) => ["long_lime", "long_blue", "long_yellow", "long_gray"].includes(e.type)).map((e) => e.barIdx);
      try {
        const fr = computeWtExtremeFractals(c);
        const arr = Array.isArray(fr) ? fr : (fr.events || fr.extremes || []);
        sets["CipherB WT2 oversold"] = arr.filter((e) => (e.side || e.type || "").toString().match(/bull|bot|oversold/i)).map((e) => e.barIdx ?? e.i).filter((v) => v !== undefined);
      } catch { /* shape mismatch */ }

      for (const [name, list] of Object.entries(sets)) {
        if (!list || !list.length) continue;
        for (const i of [...new Set(list)]) {
          const t = runTrade(c, atr, i + 1);
          if (!t) continue;
          add(`${name} :: ALL`, t);
          if (swingBias[i] === BULL) add(`${name} :: STRONG LOW`, t);
          else if (swingBias[i] === BEAR) add(`${name} :: weak low`, t);
        }
      }
    }
  }

  console.log("    signal :: bias state                       n     GROSS   ALL-TAKER      t      MAKER      t     delta");
  for (const n of ["SMC bullish OB", "SMC bullish CHoCH", "Boom q6 ceiling", "Boom Long tiers", "CipherB WT2 oversold"]) {
    for (const k of ["ALL", "STRONG LOW", "weak low"]) {
      const key = `${n} :: ${k}`;
      if (pool[key]) console.log(show(key, pool[key]));
    }
    console.log("");
  }
  const all = Object.values(pool).flat();
  const oc = all.reduce((m, x) => (m[x.outcome] = (m[x.outcome] || 0) + 1, m), {});
  const div = all.reduce((n, x) => n + x.diverged, 0);
  console.log(`outcome mix (maker path): ${JSON.stringify(oc)}  -- only 'target' exits get the maker exit fee.`);
  console.log(`paths RESOLVED DIFFERENTLY on ${div} of ${all.length} simulated trades (${((div / all.length) * 100).toFixed(2)}%) -- this is why they must be simulated separately.`);
}

main().catch((e) => { console.error("Fatal:", e); process.exit(1); });
