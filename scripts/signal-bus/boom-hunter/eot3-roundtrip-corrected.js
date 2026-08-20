#!/usr/bin/env node
// EOT3 ROUND TRIP, CORRECTLY OPERATIONALISED -- X3 = -1 (half 1) then X3 = +1 (half 2).
//
// **THIS CORRECTS TWO ROWS.**
//
// #191 claimed q5-floor and q6-ceiling are "mutually exclusive... the pair partitions rather than
// duplicates". **That is wrong.** Quotient5 = (X3+K)/(KX3+1) and Quotient6 = (X3-K)/(-KX3+1) with
// K = 0.9999 are two Mobius transforms of the SAME X3 with opposite K sign, and **both have fixed
// points at X3 = +/-1**. For every interior X3 they sit saturated at OPPOSITE ends (q5 ~ 110,
// q6 ~ -10); only at the exact extremes do they snap together. Measured on BTC: q5 at floor 2950
// bars, q6 also at floor 2950 -- **100.0%**; q6 at ceiling 3081 bars, q5 also at ceiling 3081 --
// **100.0%**. They occupy the same extreme ALWAYS. What is disjoint is q5-floor vs q6-ceiling, and
// that is trivial: they are the two OPPOSITE ends of X3.
//
// #196 tested "the completed round trip" using `q5 >= 105` as the return-to-ceiling. **q5 >= 105
// corresponds to X3 >= ~-0.99 -- essentially the instant q5 leaves the floor.** So #196's "COMPLETED"
// arm never tested the return at all, which is exactly why it came out within 0.05pp of the
// half-signal arm. The 3-bar round-trip median it reported is the time to leave the floor, not the
// time to complete the trip.
//
// **THE CORRECT ENCODING OF iapaulo's MODEL:**
//   half 1 = X3 hits -1  ->  q5 AND q6 both at -10   (the "drops to the floor" leg)
//   half 2 = X3 hits +1  ->  q5 AND q6 both at +110  (the "returns to ceiling" leg)
// q6's ceiling spike is the SHARP marker of half 2, because q6 is saturated at -10 for all interior
// X3 while q5 is saturated at +110 there and therefore cannot mark the return.
//
// **CONSEQUENCE THAT REFRAMES #188: a q6 ceiling excursion IS half 2 of his round trip.** #188 tested
// q6 ceilings ungated -- including those NOT preceded by a floor visit. His construction says the
// signal is the completed trip. This test separates them, which #188 could not.
//
// HIS SHARPNESS CLAIM, in his words: "some signals are sharp and return within 1 bar, these seem to
// be the strongest". Encoded as the gap between half 1 and half 2 in bars.
//
// REFERENT: q5 = yellow (`Plot55`), q6 = blue (`Plot54`), both from X3 -- REFERENTS.md.
// #143 frozen construction. BTC/ETH/SOL/XRP, 1h + 4h.

import { loadCandles } from "../../backtest/lib/load-candles.js";
import { computeBoomHunter } from "./calc.js";
import { FEE_TIERS, REPRESENTATIVE_FUNDING_PCT_PER_HOUR } from "../../backtest/lib/costs.js";

const ATR_LEN = 14, ATR_MULT = 2.0, R_MULT = 2, HOLD_BARS = 200;
const SLIP_ENTRY_ATR = 0.05, SLIP_STOP_ATR = 0.15, SLIP_TARGET_ATR = 0;
const TAKER = FEE_TIERS.bitunix_futures_vip1.takerFeePct;
const MIN_N = 60;

const FLOOR = -4;        // X3 = -1 : both q5 and q6 pinned low
const CEILING = 105;     // X3 = +1 : both pinned high; q6 is the sharp marker
const MAX_GAP = 50;      // how long half 2 may take to arrive after half 1
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
  if (g.length < MIN_N) return `    ${label.padEnd(42)}${String(g.length).padStart(5)}   below n>=${MIN_N}`;
  return `    ${label.padEnd(42)}${String(g.length).padStart(5)}${((g.filter((t) => t.won).length / g.length) * 100).toFixed(1).padStart(8)}%` +
         `${(mean(g.map((t) => t.net)) * 100).toFixed(4).padStart(12)}%${tstat(g).toFixed(2).padStart(9)}`;
};

async function main() {
  console.log("EOT3 ROUND TRIP, CORRECTED -- half 1 = X3 hits -1 (q5 AND q6 at -10), half 2 = X3 hits +1 (both at +110).");
  console.log("q5 and q6 share Mobius fixed points at +/-1: they hit the SAME extreme together, 100.0% of bars.");
  console.log("#191's 'the pair partitions' is WRONG. #196's 'return to ceiling' used q5>=105 = X3>=-0.99,");
  console.log("which fires as q5 LEAVES the floor -- so #196 never tested the return. q6's ceiling is the sharp marker.");
  console.log(`Half 2 must arrive within ${MAX_GAP} bars of half 1. Entry next bar. ${R_MULT}R @ ${ATR_MULT}x ATR(${ATR_LEN}), breakeven 33.3%.\n`);

  const pooled = {};
  const addp = (k, side, t) => { (pooled[k] ??= { long: [], short: [] })[side].push(t); };
  const gaps = [];

  for (const inst of INSTRUMENTS) {
    for (const tf of TFS) {
      const c = await loadCandles(tf, inst);
      if (c.length < 1000) continue;
      const atr = atrSeries(c, ATR_LEN);
      const { series } = computeBoomHunter(c);
      const q5 = series.q5, q6 = series.q6;

      // half 1: first bar of a floor visit (X3 = -1). half 2: next q6 ceiling crossing.
      const trips = [];
      const ceilCross = [];
      for (let i = 1; i < c.length; i++) if (q6[i] >= CEILING && q6[i - 1] < CEILING) ceilCross.push(i);
      const ceilSet = ceilCross.slice();
      let ci = 0;
      for (let i = 1; i < c.length; i++) {
        if (!(q5[i] <= FLOOR && q5[i - 1] > FLOOR)) continue;   // half 1 fires
        while (ci < ceilSet.length && ceilSet[ci] <= i) ci++;
        if (ci >= ceilSet.length) break;
        const r = ceilSet[ci];
        const gap = r - i;
        if (gap <= MAX_GAP) trips.push({ f: i, r, gap });
      }
      gaps.push(...trips.map((t) => t.gap));

      const sharp1 = trips.filter((t) => t.gap <= 1);
      const sharp2 = trips.filter((t) => t.gap <= 2);
      const slow = trips.filter((t) => t.gap > 2);
      const unpaired = ceilCross.filter((r) => !trips.some((t) => t.r === r));

      console.log(`===== ${inst} ${tf}   q6 ceiling crossings ${ceilCross.length}   COMPLETED trips ${trips.length}   gap median ${med(trips.map((t) => t.gap))}   <=1 bar ${sharp1.length}   <=2 ${sharp2.length}   >2 ${slow.length}   ceilings with NO prior floor ${unpaired.length}`);
      console.log("    arm                                           n    win%   net%/trade        t");
      const B = (list, key, side) => list.map((e) => runTrade(c, atr, (key ? e[key] : e) + 1, side)).filter(Boolean);
      const rows = [
        ["#188 baseline: ALL q6 ceilings, LONG", B(ceilCross, null, "long")],
        ["#188 baseline: ALL q6 ceilings, SHORT", B(ceilCross, null, "short")],
        ["COMPLETED trip (half1->half2), LONG", B(trips, "r", "long")],
        ["COMPLETED trip (half1->half2), SHORT", B(trips, "r", "short")],
        ["SHARP: return within 1 bar, LONG", B(sharp1, "r", "long")],
        ["SHARP: return within 1 bar, SHORT", B(sharp1, "r", "short")],
        ["SHARP: within 2 bars, LONG", B(sharp2, "r", "long")],
        ["SLOW: >2 bars, LONG", B(slow, "r", "long")],
        ["Ceiling with NO prior floor, LONG", B(unpaired, null, "long")],
      ];
      for (const [l, g] of rows) console.log(fmt(l, g));
      for (const [l, g] of rows) {
        const k = l.replace(/, (LONG|SHORT)$/, "");
        const side = l.endsWith("SHORT") ? "short" : "long";
        for (const t of g) addp(k, side, t);
      }
      console.log("");
    }
  }

  console.log(`--- POOLED BTC/ETH/SOL/XRP, 1h+4h.   half1->half2 gap: median ${med(gaps)}, mean ${mean(gaps).toFixed(1)}`);
  console.log("    arm                                           n    win%   net%/trade        t");
  for (const k of Object.keys(pooled)) {
    for (const side of ["long", "short"]) {
      if (pooled[k][side].length) console.log(fmt(`${k}, ${side.toUpperCase()}`, pooled[k][side]));
    }
  }
  console.log("\nHIS CLAIM: sharp returns (<=1 bar) are the strongest. That is a comparison of SHARP vs SLOW,");
  console.log("and vs the #188 ungated baseline -- if completing the trip adds nothing over any q6 ceiling,");
  console.log("then the floor leg carries no information and #188's construction was already sufficient.");
}

main().catch((e) => { console.error("Fatal:", e); process.exit(1); });
