#!/usr/bin/env node
// THE CORE HYPOTHESIS -- q6 AT ITS CEILING + PRICE ABOVE SWEPT BUYSIDE LIQUIDITY -> SHORT.
//
// iapaulo has stated this since #146. **It has never been tested.** #157 tested q1 and #169 tested
// q5; both were the WRONG SERIES and both are marked SUPERSEDED -- WRONG REFERENT (#189). #187
// identified the blue line as q6 from a chart image; #188 tested q6 ALONE, without the liquidity
// condition. This is the first run of the actual claim.
//
// REFERENTS, bound before the test and named again in the verdict (REFERENTS.md):
//   * "the blue line" = **q6**, `Plot54`, the Downward Boom Line. NOT q1, NOT q5. All three report
//     to TradingView under the identical title `Quotient 1` (#190), so nothing here resolves a
//     series by its TV title.
//   * "buyside liquidity" = a cluster of pivot **HIGHS**, sitting ABOVE price. Confirmed four ways
//     in #190 after the house-stack card was found to have this inverted. Getting this backwards
//     would silently invert the entire test.
//
// WHAT "PRICE ABOVE SWEPT BUYSIDE LIQUIDITY" MEANS OPERATIONALLY. A buyside pool is SWEPT when
// price closes above its top edge -- `liquidity.js` sets `brokenTop` on `close > top`, which for a
// buyside pool implies `brokenBtm` too, so the pool reaches status `broken`. "Price above it" is
// then `close > pool.top` at the signal bar. So the condition is: **there exists a buyside pool
// broken at or before this bar, and price is still above it.** Both an any-time and a recency-capped
// variant are reported, because a pool swept two years ago that price never returned under is
// almost certainly not what he is describing.
//
// DECOMPOSITION, per #186's lesson that a gated result is meaningless without its baseline:
//   (1) q6 ceiling ALONE            -- replicates #188, the thing the condition must beat
//   (2) q6 ceiling + his condition  -- the claim
//   (3) q6 ceiling + NOT condition  -- the complement, which is what tells you whether the gate is
//                                      selecting anything or just shrinking n
// Both LONG and SHORT arms on every cell. **His claim is specifically SHORT**, and #188 found the
// ungated event strongly LONG on all six cells -- so this test asks whether the liquidity state
// FLIPS a known-bullish event. That is a demanding thing to ask of a filter and it should be
// reported as such whichever way it lands.
//
// NOTE ON MECHANISM: QUEUE.md Q2 records that iapaulo has NOT stated why the sweep would flip it,
// and I am not inferring one. This test is fully specified without a mechanism; the mechanism is
// required only before any causal reading of the result.
//
// #143 frozen construction, no forward-return stage. BTC/ETH/SOL 1h+4h. XRP held in reserve.

import { loadCandles } from "../../backtest/lib/load-candles.js";
import { computeBoomHunter } from "../boom-hunter/calc.js";
import { computeLiquidityPools } from "../ict/liquidity.js";
import { FEE_TIERS, REPRESENTATIVE_FUNDING_PCT_PER_HOUR } from "../../backtest/lib/costs.js";

const ATR_LEN = 14, ATR_MULT = 2.0, R_MULT = 2, HOLD_BARS = 200;
const SLIP_ENTRY_ATR = 0.05, SLIP_STOP_ATR = 0.15, SLIP_TARGET_ATR = 0;
const TAKER = FEE_TIERS.bitunix_futures_vip1.takerFeePct;
const MIN_N = 60;

const CEILING = 109.9;        // q6 spans [-10, 110]; same threshold as #188
const RECENT_BARS = 50;       // recency cap for the "recently swept" variant
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
  console.log("CORE HYPOTHESIS -- q6 CEILING + PRICE ABOVE SWEPT BUYSIDE LIQUIDITY -> SHORT (iapaulo, since #146).");
  console.log("REFERENT: q6 = Plot54, the blue Downward Boom Line. NOT q1 (#157), NOT q5 (#169) -- both SUPERSEDED.");
  console.log("BUYSIDE = clusters of pivot HIGHS above price. Swept = close above the pool top; still above = close > top.");
  console.log(`#188 found the UNGATED event strongly LONG on all six cells. This asks whether liquidity FLIPS it.`);
  console.log(`${R_MULT}R @ ${ATR_MULT}x ATR(${ATR_LEN}), hold<=${HOLD_BARS}, taker+funding. 2R breakeven 33.3%. XRP reserved.\n`);

  for (const inst of INSTRUMENTS) {
    for (const tf of TFS) {
      const c = await loadCandles(tf, inst);
      if (c.length < 1000) continue;
      const atr = atrSeries(c, ATR_LEN);
      const { series } = computeBoomHunter(c);
      const q6 = series.q6;
      const { pools } = computeLiquidityPools(c);

      // Buyside pools that reached `broken` (price closed above the top edge) = SWEPT.
      const swept = pools
        .filter((p) => p.side === "buyside" && p.brokenBarIdx !== null)
        .sort((a, b) => a.brokenBarIdx - b.brokenBarIdx);

      // For each bar: is there a swept buyside pool that price is still above?
      // Walk forward, maintaining the set of already-swept pools.
      const aboveSweptAny = new Array(c.length).fill(false);
      const aboveSweptRecent = new Array(c.length).fill(false);
      let ptr = 0;
      const active = [];
      for (let i = 0; i < c.length; i++) {
        while (ptr < swept.length && swept[ptr].brokenBarIdx <= i) active.push(swept[ptr++]);
        const close = c[i].c;
        for (const p of active) {
          if (close > p.top) {
            aboveSweptAny[i] = true;
            if (i - p.brokenBarIdx <= RECENT_BARS) aboveSweptRecent[i] = true;
          }
          if (aboveSweptAny[i] && aboveSweptRecent[i]) break;
        }
      }

      const events = [];
      for (let i = 1; i < c.length; i++) if (q6[i] >= CEILING && q6[i - 1] < CEILING) events.push(i);

      const condAny = events.filter((i) => aboveSweptAny[i]);
      const condRec = events.filter((i) => aboveSweptRecent[i]);
      const compAny = events.filter((i) => !aboveSweptAny[i]);

      const build = (list, side) => list.map((i) => runTrade(c, atr, i + 1, side)).filter(Boolean);

      console.log(`===== ${inst} ${tf}   q6 ceiling events ${events.length}   above-swept-buyside ${condAny.length}   swept within ${RECENT_BARS} bars ${condRec.length}   complement ${compAny.length}`);
      console.log("    arm                                   n    win%   net%/trade");
      console.log(fmt("(1) q6 alone, LONG", build(events, "long")));
      console.log(fmt("(1) q6 alone, SHORT", build(events, "short")));
      console.log(fmt("(2) + above swept buyside, LONG", build(condAny, "long")));
      console.log(fmt("(2) + above swept buyside, SHORT", build(condAny, "short")));
      console.log(fmt(`(2r) + swept <=${RECENT_BARS} bars, LONG`, build(condRec, "long")));
      console.log(fmt(`(2r) + swept <=${RECENT_BARS} bars, SHORT`, build(condRec, "short")));
      console.log(fmt("(3) complement, LONG", build(compAny, "long")));
      console.log(fmt("(3) complement, SHORT", build(compAny, "short")));
      console.log("");
    }
  }
  console.log("HIS CLAIM HOLDS only if cell (2)/(2r) SHORT is positive AND beats its own LONG arm.");
  console.log("If (2) SHORT merely loses less than (1) SHORT, that is harm reduction, not a flip -- #155's shape.");
  console.log("If the complement (3) looks the same as (2), the liquidity condition is selecting nothing.");
}

main().catch((e) => { console.error("Fatal:", e); process.exit(1); });
