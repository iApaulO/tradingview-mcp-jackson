#!/usr/bin/env node
// q5 -- THE YELLOW LINE -- CHARACTERISED AS A TWO-PART ROUND TRIP, WHICH IS WHAT iapaulo HAS BEEN
// DESCRIBING SINCE THE START AND WHAT EVERY PRIOR TEST GOT WRONG.
//
// HIS DESCRIPTION (2026-08-19, and 2026-08-18 in the same terms): "the yellow line is natively on
// the ceiling. only when it drops to the floor does it generate half of its signal then when it
// returns to ceiling the other half of the signal is issued". Earlier, in the same words: "the line
// going 1 direction is half the signal returning is the other half thats why sharp tips in the line
// perform differently than flat".
//
// **WHAT I GOT WRONG.** #191 tested the Entry Zone alert -- `crossunder(Quotient5, -0.9)`, q5
// arriving at its floor -- as if IT were the entry, and refuted the long on all six cells. Under his
// model that is **HALF A SIGNAL**: the down leg. The signal is not issued until q5 RETURNS to the
// ceiling. Entering at the floor is entering at the halfway point of a construction whose completion
// is the actual trigger. Every q5 and q6 test in this register (#157, #169, #188, #191, #193, #194,
// #195) entered on a SINGLE CROSSING. None of them tested a completed round trip.
//
// REFERENT, resolved from source rather than from the number he used: he says "yellow" and "natively
// on the ceiling". In `boom-hunter-pro.pine`, `Quotient5 = (X3 + K13)/(K13*X3 + 1)` with K13 = +0.9999
// -- a Mobius transform with K -> +1, which pins the output toward +1, i.e. the CEILING -- and it is
// plotted YELLOW at `Plot55`, in the input group literally named `EOT 3 (Yellow Line)`. `Quotient6`
// uses K33 = -K13 and pins toward the FLOOR, plotted BLUE at `Plot54`. Our port matches exactly
// (`calc.js:278-280`). **Colour and behaviour both identify q5; only the number he used says q6. Two
// source-grounded identifiers beat one recalled label, so the referent here is q5.** Measured: q5
// sits at its ceiling on ~96% of bars, q6 on ~4% -- the mirror.
//
// PART 1 -- BEHAVIOUR, which is what he actually asked for and which no row has ever recorded:
//   episode counts, how long the line sits at the floor, how long each leg takes, and the
//   distribution of round-trip durations. **Characterise before testing.**
//
// PART 2 -- THE COMPLETED SIGNAL: entry on the bar after q5 RETURNS to the ceiling, having been to
//   the floor. Contrasted against the half-signal (#191's entry at the floor) on the SAME episodes,
//   so the difference is the construction and nothing else.
//
// PART 3 -- SHARPNESS, his other stated claim: episodes split by how long q5 stayed at the floor.
//   A "sharp tip" is a fast reversal (few bars at the floor); "flat" is a long stay.
//
// CEILING/FLOOR thresholds inherited: floor -4 = `Quotient5 = -0.9`, the vendor's own Entry Zone
// level (#190/#191). Ceiling 105 on a series whose max is 110.
// #143 frozen construction. BTC/ETH/SOL/XRP, 1h + 4h. XRP is already spent (#195).

import { loadCandles } from "../../backtest/lib/load-candles.js";
import { computeBoomHunter } from "./calc.js";
import { FEE_TIERS, REPRESENTATIVE_FUNDING_PCT_PER_HOUR } from "../../backtest/lib/costs.js";

const ATR_LEN = 14, ATR_MULT = 2.0, R_MULT = 2, HOLD_BARS = 200;
const SLIP_ENTRY_ATR = 0.05, SLIP_STOP_ATR = 0.15, SLIP_TARGET_ATR = 0;
const TAKER = FEE_TIERS.bitunix_futures_vip1.takerFeePct;
const MIN_N = 60;

const FLOOR = -4;      // Quotient5 = -0.9, the vendor's Entry Zone level
const CEILING = 105;   // q5 max is 110
const SHARP_MAX = 2;   // bars at the floor for a "sharp tip"
const TFS = ["1h", "4h"];
const INSTRUMENTS = ["BTC", "ETH", "SOL", "XRP"];

const mean = (xs) => (xs.length ? xs.reduce((s, x) => s + x, 0) / xs.length : NaN);
const sd = (xs) => { const m = mean(xs); return Math.sqrt(mean(xs.map((x) => (x - m) ** 2))); };
const med = (xs) => { if (!xs.length) return NaN; const a = [...xs].sort((p, q) => p - q); return a[Math.floor(a.length / 2)]; };

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

const tstat = (g) => {
  const xs = g.map((x) => x.net);
  if (xs.length < 2) return NaN;
  const s = sd(xs) * Math.sqrt(xs.length / (xs.length - 1));
  return s > 0 ? mean(xs) / (s / Math.sqrt(xs.length)) : NaN;
};

const fmt = (label, g) => {
  if (g.length < MIN_N) return `    ${label.padEnd(40)}${String(g.length).padStart(5)}   below n>=${MIN_N}`;
  return `    ${label.padEnd(40)}${String(g.length).padStart(5)}${((g.filter((t) => t.won).length / g.length) * 100).toFixed(1).padStart(8)}%` +
         `${(mean(g.map((t) => t.net)) * 100).toFixed(4).padStart(12)}%${tstat(g).toFixed(2).padStart(9)}`;
};

// An EPISODE: q5 at the ceiling -> departs -> reaches the FLOOR -> returns to the CEILING.
// floorArrive = first bar <= FLOOR (half 1). ceilingReturn = first later bar >= CEILING (half 2).
function episodes(q5) {
  const out = [];
  let i = 0;
  const n = q5.length;
  while (i < n) {
    while (i < n && !(q5[i] >= CEILING)) i++;            // find a ceiling state
    if (i >= n) break;
    let j = i;
    while (j < n && q5[j] >= CEILING) j++;                // leave the ceiling
    if (j >= n) break;
    let f = j;
    while (f < n && q5[f] > FLOOR) { if (q5[f] >= CEILING) break; f++; }   // reach the floor
    if (f >= n || q5[f] >= CEILING) { i = f; continue; }  // returned without reaching the floor
    let g = f;
    while (g < n && q5[g] <= FLOOR) g++;                  // leave the floor
    const barsAtFloor = g - f;
    let r = g;
    while (r < n && q5[r] < CEILING) r++;                 // return to the ceiling
    if (r >= n) break;
    out.push({ departBar: j, floorArrive: f, floorLeave: g, ceilingReturn: r, barsAtFloor,
               downLeg: f - j, upLeg: r - f, roundTrip: r - j });
    i = r;
  }
  return out;
}

async function main() {
  console.log("q5 -- THE YELLOW LINE -- AS A TWO-PART ROUND TRIP (iapaulo's construction).");
  console.log("REFERENT: q5 = Quotient5 = (X3+K13)/(K13*X3+1), K13=+0.9999 -> pinned to the CEILING;");
  console.log("plotted YELLOW at Plot55, input group 'EOT 3 (Yellow Line)'. q6 uses K33=-K13 and pins");
  console.log("to the FLOOR, plotted BLUE. Colour AND behaviour both identify q5.");
  console.log(`HALF 1 = q5 reaches the floor (${FLOOR}, the vendor's Entry Zone). HALF 2 = q5 returns to the ceiling (${CEILING}).`);
  console.log("#191 entered at HALF 1 and refuted it. This enters on completion, which is the actual signal.\n");

  const pooled = {};
  const addp = (k, side, t) => { (pooled[k] ??= { long: [], short: [] })[side].push(t); };

  for (const inst of INSTRUMENTS) {
    for (const tf of TFS) {
      const c = await loadCandles(tf, inst);
      if (c.length < 1000) continue;
      const atr = atrSeries(c, ATR_LEN);
      const { series } = computeBoomHunter(c);
      const q5 = series.q5;
      const eps = episodes(q5);
      if (!eps.length) continue;

      const atCeil = q5.filter((v) => Number.isFinite(v) && v >= CEILING).length;
      console.log(`===== ${inst} ${tf}   bars ${c.length.toLocaleString()}   at ceiling ${((atCeil / c.length) * 100).toFixed(1)}%   COMPLETED ROUND TRIPS ${eps.length}`);
      console.log(`      bars at floor: median ${med(eps.map((e) => e.barsAtFloor))}, mean ${mean(eps.map((e) => e.barsAtFloor)).toFixed(1)}   ` +
                  `down leg median ${med(eps.map((e) => e.downLeg))}   up leg median ${med(eps.map((e) => e.upLeg))}   round trip median ${med(eps.map((e) => e.roundTrip))}`);

      const sharp = eps.filter((e) => e.barsAtFloor <= SHARP_MAX);
      const flat = eps.filter((e) => e.barsAtFloor > SHARP_MAX);
      console.log(`      sharp tips (<=${SHARP_MAX} bars at floor) ${sharp.length}   flat ${flat.length}`);
      console.log("    arm                                         n    win%   net%/trade        t");

      const B = (list, bar, side) => list.map((e) => runTrade(c, atr, e[bar] + 1, side)).filter(Boolean);
      const rows = [
        ["HALF 1 only (#191 entry, at floor), LONG", B(eps, "floorArrive", "long")],
        ["HALF 1 only (#191 entry, at floor), SHORT", B(eps, "floorArrive", "short")],
        ["COMPLETED (return to ceiling), LONG", B(eps, "ceilingReturn", "long")],
        ["COMPLETED (return to ceiling), SHORT", B(eps, "ceilingReturn", "short")],
        ["COMPLETED + SHARP tip, LONG", B(sharp, "ceilingReturn", "long")],
        ["COMPLETED + SHARP tip, SHORT", B(sharp, "ceilingReturn", "short")],
        ["COMPLETED + FLAT, LONG", B(flat, "ceilingReturn", "long")],
        ["COMPLETED + FLAT, SHORT", B(flat, "ceilingReturn", "short")],
      ];
      for (const [label, g] of rows) console.log(fmt(label, g));
      for (const [label, g] of rows) {
        const k = label.replace(/, (LONG|SHORT)$/, "");
        const side = label.endsWith("LONG") ? "long" : "short";
        for (const t of g) addp(k, side, t);
      }
      console.log("");
    }
  }

  console.log("--- POOLED across BTC/ETH/SOL/XRP, 1h+4h");
  console.log("    arm                                         n    win%   net%/trade        t");
  for (const k of Object.keys(pooled)) {
    for (const side of ["long", "short"]) console.log(fmt(`${k}, ${side.toUpperCase()}`, pooled[k][side]));
  }
  console.log("\nIf COMPLETED beats HALF 1 on the SAME episodes, the round trip is the signal and every");
  console.log("prior single-crossing test in this register was measuring the wrong event.");
}

main().catch((e) => { console.error("Fatal:", e); process.exit(1); });
