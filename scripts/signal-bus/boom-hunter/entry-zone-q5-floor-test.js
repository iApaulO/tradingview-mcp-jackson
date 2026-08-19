#!/usr/bin/env node
// BOOM HUNTER "Entry Zone" -- q5 (THE YELLOW LINE) CROSSING DOWN INTO ITS FLOOR.
//
// REFERENT (named up front per REFERENTS.md, and named again in the verdict): the series under test
// is **q5 = Quotient5*60+50, `Plot55`, iapaulo's "yellow line"**, bound from the Pine's own input
// group `EOT 3 (Yellow Line)`. It is NOT q6 (the blue Downward Boom Line, `Plot54`) and NOT q1.
// Both of those report to TradingView under the SAME title `Quotient 1` as q5 does -- see #190. No
// part of this test resolves a series by its TradingView title.
//
// THE SIGNAL IS THE VENDOR'S OWN, AND IT HAS NEVER BEEN TESTED. `boom-hunter-pro.pine:410` is
//     alertcondition(ta.crossunder(Quotient5, -0.9), title='Entry Zone')
// Quotient5 = -0.9 maps to q5 = -0.9*60 + 50 = **-4** in our scaling (esize2=60, ey2=50, pine L43/44,
// mirrored at calc.js:279). So the event is q5 crossing DOWN through -4. Surfaced by the #190
// inventory; absent from every prior register row.
//
// WHY IT IS WORTH A RUN. #147 measured q5 as CEILING-pinned (~68% of bars at/near its top). A floor
// crossunder is therefore the rare tail of the most-studied series in this indicator, and #147's own
// principle is that a condition is informative precisely BECAUSE the default is the opposite. #187
// found exactly this shape made q6 worth testing (3.91% of bars) and #188 turned it into the
// strongest unvalidated cell in the programme. This is the same argument applied to the series
// iapaulo says carries LONG information.
//
// NOTE, and it corrects a stale comment in our own port: `calc.js:8` says EOT3 "feeds ONLY the two
// Exit Warning circles". That is wrong -- Quotient5 also drives this `Entry Zone` alert (L410), and
// q5/q6 are plotted directly (Plot55/Plot54). The comment predates the #190 inventory.
//
// DIRECTION IS TESTED, NOT ASSUMED. The vendor calls it "Entry Zone", which asserts a long reading,
// and iapaulo's framework says yellow carries long information -- so both the source AND his model
// point the same way here. That agreement is a reason to test it, not a reason to skip testing the
// short arm. #58 found STC's dose-response ran inverted to its own stated logic and #188 found the
// "Downward Boom Line" emphatically bullish, so vendor naming carries no evidential weight.
//
// XRP IS HELD IN RESERVE. Pre-registration scorecard is 2 of 4 (#143, #180 pass; #165, #186 fail).
// XRP is the last clean gate and is not spent on exploratory runs.
//
// No forward-return stage -- straight to #143's frozen construction, per the standing rule that a
// forward-return contrast in this project does not survive a stop.

import { loadCandles } from "../../backtest/lib/load-candles.js";
import { computeBoomHunter } from "./calc.js";
import { FEE_TIERS, REPRESENTATIVE_FUNDING_PCT_PER_HOUR } from "../../backtest/lib/costs.js";

const ATR_LEN = 14, ATR_MULT = 2.0, R_MULT = 2, HOLD_BARS = 200;
const SLIP_ENTRY_ATR = 0.05, SLIP_STOP_ATR = 0.15, SLIP_TARGET_ATR = 0;
const TAKER = FEE_TIERS.bitunix_futures_vip1.takerFeePct;
const MIN_N = 60;

const FLOOR = -4;                              // Quotient5 = -0.9 in q5 units
const TFS = ["1h", "4h"];
const INSTRUMENTS = ["BTC", "ETH", "SOL"];     // XRP reserved

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
  if (g.length < MIN_N) return `    ${label.padEnd(24)}${String(g.length).padStart(5)}   below n>=${MIN_N}`;
  return `    ${label.padEnd(24)}${String(g.length).padStart(5)}${((g.filter((t) => t.won).length / g.length) * 100).toFixed(1).padStart(9)}%${(mean(g.map((t) => t.net)) * 100).toFixed(4).padStart(13)}%`;
};

async function main() {
  console.log('BOOM HUNTER "Entry Zone" = ta.crossunder(Quotient5, -0.9)  ->  q5 crossing DOWN through -4.');
  console.log('REFERENT: q5, Plot55, iapaulo\'s YELLOW line (EOT 3 "Yellow Line"). NOT q6 (blue), NOT q1.');
  console.log(`Vendor naming says LONG; iapaulo's framework (yellow = long data) agrees. Both arms tested anyway.`);
  console.log(`${R_MULT}R @ ${ATR_MULT}x ATR(${ATR_LEN}), hold<=${HOLD_BARS}, taker+funding. 2R breakeven = 33.3% before costs.`);
  console.log("XRP held in reserve as the last clean pre-registration gate.\n");

  for (const inst of INSTRUMENTS) {
    for (const tf of TFS) {
      const c = await loadCandles(tf, inst);
      if (c.length < 1000) continue;
      const atr = atrSeries(c, ATR_LEN);
      const { series } = computeBoomHunter(c);
      const q5 = series.q5;

      const events = [];
      for (let i = 1; i < c.length; i++) if (q5[i] < FLOOR && q5[i - 1] >= FLOOR) events.push(i);

      const belowFloor = q5.filter((v) => Number.isFinite(v) && v < FLOOR).length;
      const atCeiling = q5.filter((v) => Number.isFinite(v) && v > 105).length;
      const pct = (x) => ((x / c.length) * 100).toFixed(2);

      console.log(`===== ${inst} ${tf}   bars ${c.length.toLocaleString()}   q5 below floor: ${pct(belowFloor)}%   q5 at ceiling: ${pct(atCeiling)}%   Entry Zone events: ${events.length}`);
      const build = (side) => events.map((i) => runTrade(c, atr, i + 1, side)).filter(Boolean);
      console.log("    arm                         n     win%    net%/trade");
      console.log(row("Entry Zone, LONG", build("long")));
      console.log(row("Entry Zone, SHORT", build("short")));
      console.log("");
    }
  }
  console.log("A LONG arm above 0 confirms the vendor's own naming AND iapaulo's yellow=long framework.");
  console.log("A SHORT arm winning would refute both at once -- which is why both are reported.");
}

main().catch((e) => { console.error("Fatal:", e); process.exit(1); });
