#!/usr/bin/env node
// q6 CEILING EXCURSION, alone and gated by a bullish MSS -- iapaulo's hypothesis, first test of q6.
//
// #187 identified q6 as the "blue line" he has been pointing at across three separate corrections.
// It is the ONLY series in Boom Hunter with a genuine rarity profile: above 50 on 3.91% of 1h bars,
// 815 excursions in nine years, floor-pinned the other 96%. That is the mirror of q5's ceiling
// pinning (#147, ~68%) and it is why q6 renders as sharp vertical spikes rather than a wandering
// line. **q6 has never been tested in 197 register rows** despite being computed since the port and
// persisted since #159, while most of the Boom Hunter effort went into q1 and q5 -- the two
// saturated series where "went to the top" describes the DEFAULT STATE rather than an event.
//
// #147's principle applies directly: a condition is informative precisely BECAUSE the default is the
// opposite. On that reasoning q6 is the best-shaped candidate this indicator has offered.
//
// **DIRECTION IS TESTED, NOT ASSUMED, AND THAT IS THE POINT.** The series is named the "Downward
// Boom Line", which asserts a bearish reading. iapaulo's observed instance did the opposite: two q6
// ceiling excursions immediately after a bullish MSS on 17 Aug, followed by roughly +1,100 points of
// upside. #58 already found STC's dose-response ran INVERTED to its stated logic, so an indicator's
// own naming is not evidence about its behaviour. Both sides are evaluated on every cell and the
// name is given no weight.
//
// TWO QUESTIONS, DECOMPOSED, because a gated result means nothing without its ungated baseline:
//   (a) does a q6 ceiling excursion predict anything ON ITS OWN?
//   (b) does requiring a recent bullish MSS improve it?
// #186 is the cautionary case -- an MFI gate that replicated perfectly while the signal it gated lost
// money, producing a smaller loss and no edge.
//
// **XRP IS DELIBERATELY EXCLUDED AND HELD IN RESERVE.** It is the only instrument on which neither
// Boom Hunter nor this hypothesis has been evaluated, and the pre-registration scorecard now stands
// at two passes in four (#143, #180 pass; #165, #186 fail). Spending the last clean gate on an
// exploratory run would leave nothing to confirm a positive result with.
//
// No forward-return stage: straight to #143's frozen construction, per #154/#155, #161/#162,
// #168/#169.

import { DatabaseSync } from "node:sqlite";
import { loadCandles } from "../../backtest/lib/load-candles.js";
import { computeBoomHunter } from "./calc.js";
import { FEE_TIERS, REPRESENTATIVE_FUNDING_PCT_PER_HOUR } from "../../backtest/lib/costs.js";
import { dbSuffix } from "../lib/instrument.js";

const ATR_LEN = 14, ATR_MULT = 2.0, R_MULT = 2, HOLD_BARS = 200;
const SLIP_ENTRY_ATR = 0.05, SLIP_STOP_ATR = 0.15, SLIP_TARGET_ATR = 0;
const TAKER = FEE_TIERS.bitunix_futures_vip1.takerFeePct;
const MIN_N = 60;

const CEILING = 109.9;      // q6 spans [-10, 110]; this is "at the ceiling"
const MSS_LOOKBACK_BARS = 12;   // how recently a bullish MSS must have fired to count as gating
const TFS = ["1h", "4h"];       // 1h is where the observation was; 4h added as the coarser check
const INSTRUMENTS = ["BTC", "ETH", "SOL"];   // XRP held in reserve -- see header

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

const row = (label, g) => {
  if (g.length < MIN_N) return `    ${label.padEnd(26)}${String(g.length).padStart(5)}   below n>=${MIN_N}`;
  return `    ${label.padEnd(26)}${String(g.length).padStart(5)}${((g.filter((t) => t.won).length / g.length) * 100).toFixed(1).padStart(9)}%${(mean(g.map((t) => t.net)) * 100).toFixed(4).padStart(13)}%`;
};

async function main() {
  console.log("q6 CEILING EXCURSION -- first test of the only rare series in Boom Hunter (3.91% of bars).");
  console.log("DIRECTION IS TESTED, NOT ASSUMED: the series is named 'Downward Boom Line' but the observed");
  console.log("instance produced +1,100 points UP. #58 already found STC inverted to its own stated logic.");
  console.log(`XRP held in reserve as the last clean pre-registration gate. ${R_MULT}R @ ${ATR_MULT}x ATR(${ATR_LEN}), breakeven 33.3%.\n`);

  for (const inst of INSTRUMENTS) {
    const db = new DatabaseSync(new URL(`../../../data/signal-bus/smc${dbSuffix(inst)}.db`, import.meta.url), { readOnly: true });
    for (const tf of TFS) {
      const c = await loadCandles(tf, inst);
      if (c.length < 1000) continue;
      const atr = atrSeries(c, ATR_LEN);
      const { series } = computeBoomHunter(c);
      const q6 = series.q6;
      const idxOf = new Map(c.map((x, i) => [x.t, i]));

      // bullish MSS = bullish CHoCH, which is what ICT Concepts labels MSS (#185)
      const mssBars = new Set(
        db.prepare("SELECT time FROM structure_events WHERE timeframe = ? AND instrument = ? AND type = 'CHOCH' AND side = 'bullish'")
          .all(tf, inst).map((r) => idxOf.get(r.time)).filter((v) => v !== undefined),
      );

      // event: q6 crossing UP into its ceiling
      const events = [];
      for (let i = 1; i < c.length; i++) {
        if (q6[i] >= CEILING && q6[i - 1] < CEILING) events.push(i);
      }
      const gated = events.filter((i) => {
        for (let k = 0; k <= MSS_LOOKBACK_BARS; k++) if (mssBars.has(i - k)) return true;
        return false;
      });

      const build = (list, side) => list.map((i) => runTrade(c, atr, i + 1, side)).filter(Boolean);
      console.log(`===== ${inst} ${tf}   q6 excursions: ${events.length}   with a bullish MSS within ${MSS_LOOKBACK_BARS} bars: ${gated.length}`);
      console.log("    arm                           n     win%    net%/trade");
      console.log(row("q6 alone, LONG", build(events, "long")));
      console.log(row("q6 alone, SHORT", build(events, "short")));
      console.log(row("q6 + bullish MSS, LONG", build(gated, "long")));
      console.log(row("q6 + bullish MSS, SHORT", build(gated, "short")));
      console.log("");
    }
    db.close();
  }
  console.log("A LONG arm beating a SHORT arm on the same events refutes the 'Downward' name.");
  console.log("A gated arm beating its ungated baseline is what makes the MSS worth requiring -- #186 is");
  console.log("the cautionary case, where a gate replicated perfectly while the signal it gated lost money.");
}

main().catch((e) => { console.error("Fatal:", e); process.exit(1); });
