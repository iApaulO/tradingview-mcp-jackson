#!/usr/bin/env node
// STRONG LOW / WEAK LOW AS A STANDALONE CONDITIONING VARIABLE, ACROSS THE WHOLE STACK.
// Plus the diagnostic iapaulo actually asked for: **GROSS vs NET, to show whether we are looking at
// a missing edge or at an edge being eaten.**
//
// WHAT STRONG LOW IS. LuxAlgo prints `Strong Low` when `swingTrend.bias == BULLISH` and `Weak Low`
// otherwise (source L733); `Strong High` / `Weak High` are the bearish mirror (L728). It is the
// swing-scope trend bias, exposed from our port for the first time in #198 -- computed since day one
// at `smc/calc.js:139/273/281`, never stored, so no test in 198 rows could use it. #198 found it
// separates bullish-OB outcomes by 0.82pp, a bigger effect than most gates in this register, which
// is why it gets its own evaluation instead of staying a by-product.
//
// **THE GROSS/NET DECOMPOSITION IS THE POINT OF THIS RUN.** Every result in this session has landed
// between -0.2% and -1.0% per trade, and iapaulo asked the right question: how is NOTHING profitable,
// what is missing? There are only two possible shapes and they demand opposite responses:
//   (a) GROSS ~ 0 too  -> the signals carry no directional edge at this horizon. More gating will not
//       help; the problem is the hypothesis space.
//   (b) GROSS > 0, NET < 0 -> there IS an edge and the construction is eating it. Then the problem is
//       execution//cost/stop placement, and the fix is a better construction, not a better signal.
// Costs charged in the NET column: taker 0.05%/side both ways (0.10% round trip), funding 0.00125%/hr
// (up to ~1.0% on a 200-bar 4h hold), entry slippage 0.05 ATR, stop slippage 0.15 ATR. GROSS strips
// ALL of that -- fees, funding and slippage -- leaving the raw mechanics of the same trades.
//
// Signals tested, LONG side (Strong Low is a bullish-bias state, so the long side is the one it
// should help), each ungated vs Strong Low vs Weak Low:
//   1. SMC bullish order blocks (at creation)
//   2. SMC bullish CHoCH events
//   3. Boom Hunter q6 ceiling excursions  -- the #188/#195 candidate
//   4. Boom Hunter Long tiers (lime/blue/yellow/gray)
//   5. Cipher B WT2 oversold extreme fractals -- Strategy G's anchor
//
// BTC/ETH/SOL/XRP, 1h + 4h, pooled. #143 construction otherwise unchanged. XRP already spent (#195).

import { DatabaseSync } from "node:sqlite";
import { loadCandles } from "../../backtest/lib/load-candles.js";
import { FEE_TIERS, REPRESENTATIVE_FUNDING_PCT_PER_HOUR } from "../../backtest/lib/costs.js";
import { dbSuffix } from "../lib/instrument.js";
import { computeSMC } from "./calc.js";
import { computeBoomHunter } from "../boom-hunter/calc.js";
import { computeWtExtremeFractals } from "../vmc-cipher-b/calc.js";

const ATR_LEN = 14, ATR_MULT = 2.0, R_MULT = 2, HOLD_BARS = 200;
const SLIP_ENTRY_ATR = 0.05, SLIP_STOP_ATR = 0.15;
const TAKER = FEE_TIERS.bitunix_futures_vip1.takerFeePct;
const MIN_N = 60;
const BULL = 1, BEAR = -1;
const TFS = ["1h", "4h"];
const INSTRUMENTS = ["BTC", "ETH", "SOL", "XRP"];

const mean = (xs) => (xs.length ? xs.reduce((s, x) => s + x, 0) / xs.length : NaN);
const sd = (xs) => { const m = mean(xs); return Math.sqrt(mean(xs.map((x) => (x - m) ** 2))); };

function atrSeries(c, L) {
  const tr = c.map((x, i) => (i === 0 ? x.h - x.l : Math.max(x.h - x.l, Math.abs(x.h - c[i - 1].c), Math.abs(x.l - c[i - 1].c))));
  const o = new Array(c.length).fill(NaN);
  let s = 0; for (let i = 0; i < L; i++) s += tr[i];
  o[L - 1] = s / L;
  for (let i = L; i < c.length; i++) o[i] = (o[i - 1] * (L - 1) + tr[i]) / L;
  return o;
}

// Returns BOTH gross (no fees/funding/slippage) and net for the SAME trade.
function runTrade(c, atr, idx) {
  if (idx >= c.length) return null;
  const a = atr[idx];
  if (!Number.isFinite(a) || a <= 0) return null;
  const risk = ATR_MULT * a;
  const eN = c[idx].o + SLIP_ENTRY_ATR * a, eG = c[idx].o;   // net entry pays slippage, gross does not
  const stopN = eN - risk, stopG = eG - risk;
  const tgtN = eN + R_MULT * risk, tgtG = eG + R_MULT * risk;
  const end = Math.min(c.length - 1, idx + HOLD_BARS);
  let gross = null, net = null, hours = 0, won = 0;
  for (let j = idx; j <= end; j++) {
    const b = c[j];
    if (b.l <= stopN) {
      const f = stopN - SLIP_STOP_ATR * a;
      net = (f - eN) / eN; gross = (stopG - eG) / eG;
      hours = (b.t - c[idx].t) / 3600; won = 0; break;
    }
    if (b.h >= tgtN) {
      net = (tgtN - eN) / eN; gross = (tgtG - eG) / eG;
      hours = (b.t - c[idx].t) / 3600; won = 1; break;
    }
  }
  if (net === null) {
    if (end <= idx) return null;
    const b = c[end];
    net = (b.c - SLIP_ENTRY_ATR * a - eN) / eN; gross = (b.c - eG) / eG;
    hours = (b.t - c[idx].t) / 3600; won = net > 0 ? 1 : 0;
  }
  return { gross, net: net - 2 * TAKER - REPRESENTATIVE_FUNDING_PCT_PER_HOUR * Math.max(0, hours), won, hours };
}

const tOf = (xs) => {
  if (xs.length < 2) return NaN;
  const s = sd(xs) * Math.sqrt(xs.length / (xs.length - 1));
  return s > 0 ? mean(xs) / (s / Math.sqrt(xs.length)) : NaN;
};

function show(label, g) {
  if (g.length < MIN_N) return `    ${label.padEnd(38)}${String(g.length).padStart(6)}   below n>=${MIN_N}`;
  const gr = mean(g.map((x) => x.gross)) * 100, ne = mean(g.map((x) => x.net)) * 100;
  return `    ${label.padEnd(38)}${String(g.length).padStart(6)}${((g.filter((x) => x.won).length / g.length) * 100).toFixed(1).padStart(7)}%` +
         `${gr.toFixed(4).padStart(11)}%${tOf(g.map((x) => x.gross)).toFixed(2).padStart(8)}` +
         `${ne.toFixed(4).padStart(11)}%${tOf(g.map((x) => x.net)).toFixed(2).padStart(8)}` +
         `${(gr - ne).toFixed(4).padStart(10)}%${mean(g.map((x) => x.hours)).toFixed(0).padStart(7)}h`;
}

async function main() {
  console.log("STRONG LOW (swingTrend.bias == BULLISH) AS A STANDALONE CONDITION, ACROSS THE STACK.");
  console.log("Plus GROSS vs NET on identical trades -- the diagnostic for 'how is nothing profitable'.");
  console.log("GROSS strips fees, funding AND slippage. NET = taker 0.05%/side x2 + funding 0.00125%/hr + 0.05/0.15 ATR slip.\n");

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
      // 1/2 -- SMC objects from the db
      try {
        const db = new DatabaseSync(new URL(`../../../data/signal-bus/smc${dbSuffix(inst)}.db`, import.meta.url), { readOnly: true });
        sets["SMC bullish OB"] = db.prepare("SELECT created_time FROM order_blocks WHERE timeframe=? AND instrument=? AND side='bullish'").all(tf, inst).map((r) => idxOf.get(r.created_time)).filter((v) => v !== undefined);
        sets["SMC bullish CHoCH"] = db.prepare("SELECT time FROM structure_events WHERE timeframe=? AND instrument=? AND type='CHOCH' AND side='bullish'").all(tf, inst).map((r) => idxOf.get(r.time)).filter((v) => v !== undefined);
        db.close();
      } catch { /* no db for this instrument */ }
      // 3 -- q6 ceiling excursions
      const q6c = [];
      for (let i = 1; i < c.length; i++) if (q6[i] >= 105 && q6[i - 1] < 105) q6c.push(i);
      sets["Boom q6 ceiling"] = q6c;
      // 4 -- Boom long tiers
      sets["Boom Long tiers"] = boom.events.filter((e) => ["long_lime", "long_blue", "long_yellow", "long_gray"].includes(e.type)).map((e) => e.barIdx);
      // 5 -- Cipher B WT2 oversold extreme
      try {
        const fr = computeWtExtremeFractals(c);
        const arr = Array.isArray(fr) ? fr : (fr.events || fr.extremes || []);
        sets["CipherB WT2 oversold"] = arr.filter((e) => (e.side || e.type || "").toString().match(/bull|bot|oversold/i)).map((e) => e.barIdx ?? e.i).filter((v) => v !== undefined);
      } catch { /* shape mismatch, skipped */ }

      for (const [name, list] of Object.entries(sets)) {
        if (!list || !list.length) continue;
        const uniq = [...new Set(list)];
        for (const i of uniq) {
          const t = runTrade(c, atr, i + 1);
          if (!t) continue;
          add(`${name} :: ALL`, t);
          if (swingBias[i] === BULL) add(`${name} :: STRONG LOW`, t);
          else if (swingBias[i] === BEAR) add(`${name} :: weak low`, t);
        }
      }
    }
  }

  console.log("    signal :: bias state                       n    win%      GROSS       t        NET       t      drag  avg hold");
  const names = ["SMC bullish OB", "SMC bullish CHoCH", "Boom q6 ceiling", "Boom Long tiers", "CipherB WT2 oversold"];
  for (const n of names) {
    for (const k of ["ALL", "STRONG LOW", "weak low"]) {
      const key = `${n} :: ${k}`;
      if (pool[key]) console.log(show(key, pool[key]));
    }
    console.log("");
  }
  console.log("READ IT THIS WAY:");
  console.log("  GROSS ~ 0 as well  -> no directional edge at this horizon; more gating will not fix it.");
  console.log("  GROSS > 0, NET < 0 -> the edge exists and the CONSTRUCTION is eating it (cost/stop/exit).");
}

main().catch((e) => { console.error("Fatal:", e); process.exit(1); });
