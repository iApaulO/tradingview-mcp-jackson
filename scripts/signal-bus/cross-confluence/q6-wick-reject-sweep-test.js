#!/usr/bin/env node
// THE CORE HYPOTHESIS, SECOND OPERATIONALISATION -- q6 CEILING AFTER A WICK-THROUGH-AND-REJECT
// SWEEP OF BUYSIDE LIQUIDITY.
//
// #193 tested "swept" as CLOSE ABOVE AND HELD ABOVE, and refuted the short call on 1h. That row
// flagged explicitly that a wick-through-and-reject is a DIFFERENT EVENT and would need its own
// test rather than an amendment. iapaulo asked for it. This is that test.
//
// **THE TWO OPERATIONALISATIONS ARE NEARLY OPPOSITE CONFIGURATIONS AND THAT IS THE POINT.**
//   #193: price closed above the pool and stayed there -- liquidity taken, price ACCEPTED above it.
//   here: price WICKED through the pool and closed back below -- liquidity taken and REJECTED.
// The classic ICT reading of a liquidity grab is the second one. His stated phrasing was "price
// above buy side liq", which is literally the first; but the mechanism people usually mean by a
// sweep is this one, and he has asked for it explicitly, so it gets a clean run of its own.
//
// REFERENTS (REFERENTS.md, named again in the verdict):
//   * "the blue line" = **q6**, `Plot54`. NOT q1 (#157), NOT q5 (#169) -- both SUPERSEDED.
//   * "buyside liquidity" = clusters of pivot HIGHS above price (#190).
//
// SWEEP DEFINITION, two strictnesses, both requiring the pool to still be ACTIVE (never closed
// above -- `liquidity.js` only marks `broken` on a CLOSE above the top, so a wick-and-reject leaves
// the pool alive, which is exactly the complement of #193's condition):
//   STRICT: bar high >= pool.top  AND  bar close < pool.bottom   (took the whole zone, rejected below it)
//   LOOSE:  bar high >= pool.top  AND  bar close < pool.top      (took the top edge, closed back inside/below)
// Both are reported. Neither is "the" answer; they bracket the idea.
//
// Condition: a q6 ceiling crossing occurring within RECENT_BARS after such a sweep. **RECENT_BARS is
// held at 50, the same value #193 used, and is NOT re-tuned after seeing #193's result** -- changing
// it now would be fitting the window to a known outcome.
//
// Decomposition per #186: (1) q6 alone, (2) + strict sweep, (2L) + loose sweep, (3) complement of
// the loose condition. Both directions on every cell. His claim is SHORT.
//
// #143 frozen construction. BTC/ETH/SOL 1h+4h. XRP held in reserve.

import { loadCandles } from "../../backtest/lib/load-candles.js";
import { computeBoomHunter } from "../boom-hunter/calc.js";
import { computeLiquidityPools } from "../ict/liquidity.js";
import { FEE_TIERS, REPRESENTATIVE_FUNDING_PCT_PER_HOUR } from "../../backtest/lib/costs.js";

const ATR_LEN = 14, ATR_MULT = 2.0, R_MULT = 2, HOLD_BARS = 200;
const SLIP_ENTRY_ATR = 0.05, SLIP_STOP_ATR = 0.15, SLIP_TARGET_ATR = 0;
const TAKER = FEE_TIERS.bitunix_futures_vip1.takerFeePct;
const MIN_N = 60;

const CEILING = 109.9;
const RECENT_BARS = 50;       // same as #193; deliberately not re-tuned
const TFS = ["1h", "4h"];
const INSTRUMENTS = ["BTC", "ETH", "SOL"];

const mean = (xs) => (xs.length ? xs.reduce((s, x) => s + x, 0) / xs.length : NaN);

function atrSeries(c, L) {
  const tr = c.map((x, i) => (i === 0 ? x.h - x.l : Math.max(x.h - x.l, Math.abs(x.h - c[i - 1].c), Math.abs(x.l - c[i - 1].c))));
  const o = new Array(c.length).fill(NaN);
  let s = 0; for (let i = 0; i < L; i++) s += tr[i];
  o[L - 1] = s / L;
  for (let i = L; i < c.length; i++) o[i] = (o[i - 1] * (L - 1) + tr[i]) / L;
  return o;
}

function runTrade(c, atr, idx, side) {
  const a = atr[idx];
  if (!Number.isFinite(a) || a <= 0) return null;
  const risk = ATR_MULT * a;
  const entry = side === "long" ? c[idx].o + SLIP_ENTRY_ATR * a : c[idx].o - SLIP_ENTRY_ATR * a;
  const stop = side === "long" ? entry - risk : entry + risk;
  const tgt = side === "long" ? entry + R_MULT * risk : entry - R_MULT * risk;
  const end = Math.min(c.length - 1, idx + HOLD_BARS);
  let pnl = null, hours = 0, won = 0;
  for (let j = idx; j <= end; j++) {
    const b = c[j];
    const hs = side === "long" ? b.l <= stop : b.h >= stop;
    const ht = side === "long" ? b.h >= tgt : b.l <= tgt;
    if (hs) { const f = side === "long" ? stop - SLIP_STOP_ATR * a : stop + SLIP_STOP_ATR * a;
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
  return { net: pnl - 2 * TAKER - REPRESENTATIVE_FUNDING_PCT_PER_HOUR * Math.max(0, hours), won };
}

const fmt = (label, g) => {
  if (g.length < MIN_N) return `    ${label.padEnd(34)}${String(g.length).padStart(5)}   below n>=${MIN_N}`;
  return `    ${label.padEnd(34)}${String(g.length).padStart(5)}${((g.filter((t) => t.won).length / g.length) * 100).toFixed(1).padStart(8)}%${(mean(g.map((t) => t.net)) * 100).toFixed(4).padStart(12)}%`;
};

async function main() {
  console.log("CORE HYPOTHESIS, WICK-THROUGH-AND-REJECT VARIANT -- q6 ceiling after a REJECTED buyside sweep.");
  console.log("REFERENT: q6 = Plot54, the blue Downward Boom Line. BUYSIDE = clusters of pivot HIGHS.");
  console.log("#193 tested close-above-and-HELD-above and refuted the short on 1h. This is the opposite");
  console.log("configuration: liquidity taken by a WICK and REJECTED back below. Pool must still be ACTIVE.");
  console.log(`STRICT: high>=top AND close<bottom.  LOOSE: high>=top AND close<top.  Window ${RECENT_BARS} bars (unchanged from #193).`);
  console.log(`${R_MULT}R @ ${ATR_MULT}x ATR(${ATR_LEN}), breakeven 33.3%. XRP reserved.\n`);

  for (const inst of INSTRUMENTS) {
    for (const tf of TFS) {
      const c = await loadCandles(tf, inst);
      if (c.length < 1000) continue;
      const atr = atrSeries(c, ATR_LEN);
      const { series } = computeBoomHunter(c);
      const q6 = series.q6;
      const { pools } = computeLiquidityPools(c);

      // Wick-and-reject sweeps of buyside pools, while the pool is still active.
      const strictSweep = new Array(c.length).fill(false);
      const looseSweep = new Array(c.length).fill(false);
      let nStrict = 0, nLoose = 0;
      for (const p of pools) {
        if (p.side !== "buyside") continue;
        const stop = p.brokenBarIdx !== null ? p.brokenBarIdx : c.length - 1;
        for (let j = p.createdBarIdx + 1; j <= stop; j++) {
          if (c[j].h < p.top) continue;
          if (c[j].c < p.bottom) { if (!strictSweep[j]) nStrict++; strictSweep[j] = true; }
          if (c[j].c < p.top) { if (!looseSweep[j]) nLoose++; looseSweep[j] = true; }
        }
      }

      // bars-since for each variant
      const since = (flags) => {
        const o = new Array(c.length).fill(Infinity);
        let last = -Infinity;
        for (let i = 0; i < c.length; i++) { if (flags[i]) last = i; o[i] = i - last; }
        return o;
      };
      const sS = since(strictSweep), sL = since(looseSweep);

      const events = [];
      for (let i = 1; i < c.length; i++) if (q6[i] >= CEILING && q6[i - 1] < CEILING) events.push(i);

      const condS = events.filter((i) => sS[i] >= 1 && sS[i] <= RECENT_BARS);
      const condL = events.filter((i) => sL[i] >= 1 && sL[i] <= RECENT_BARS);
      const comp = events.filter((i) => !(sL[i] >= 1 && sL[i] <= RECENT_BARS));

      const build = (list, side) => list.map((i) => runTrade(c, atr, i + 1, side)).filter(Boolean);

      console.log(`===== ${inst} ${tf}   q6 ceiling ${events.length}   strict-swept bars ${nStrict}   loose-swept bars ${nLoose}   cond(S) ${condS.length}   cond(L) ${condL.length}   complement ${comp.length}`);
      console.log("    arm                                   n    win%   net%/trade");
      console.log(fmt("(1) q6 alone, LONG", build(events, "long")));
      console.log(fmt("(1) q6 alone, SHORT", build(events, "short")));
      console.log(fmt("(2) + STRICT wick-reject, LONG", build(condS, "long")));
      console.log(fmt("(2) + STRICT wick-reject, SHORT", build(condS, "short")));
      console.log(fmt("(2L) + LOOSE wick-reject, LONG", build(condL, "long")));
      console.log(fmt("(2L) + LOOSE wick-reject, SHORT", build(condL, "short")));
      console.log(fmt("(3) complement of LOOSE, LONG", build(comp, "long")));
      console.log(fmt("(3) complement of LOOSE, SHORT", build(comp, "short")));
      console.log("");
    }
  }
  console.log("HIS CLAIM HOLDS only if a conditioned SHORT arm is positive AND beats its own LONG arm.");
  console.log("A SHORT that merely loses less than the ungated SHORT is harm reduction, not a flip (#155).");
  console.log("If the complement matches the conditioned cell, the sweep is selecting nothing.");
}

main().catch((e) => { console.error("Fatal:", e); process.exit(1); });
