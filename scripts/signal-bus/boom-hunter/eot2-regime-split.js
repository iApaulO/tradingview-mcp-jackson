#!/usr/bin/env node
// DOES THE EOT2 4h EDGE SURVIVE IN DOWN-TRENDING REGIMES? -- the drift adjudication from #162.
//
// #162 left the EOT2 saturation construction as a LONG-ONLY 4h signal: BTC +0.6731%/trade and ETH
// +0.6421%, both significant, while the short side lost in all four instrument-rung cells. #144's
// method for refuting the drift confound -- showing shorts OUTPERFORM longs -- is therefore not
// available, so on that evidence the result cannot be distinguished from crypto beta.
//
// THE TEST THAT SEPARATES THE TWO. If the long edge is beta, it exists because the sample trended up
// and should VANISH where the trend is down. If it is a momentum signal, it should persist in
// down-regimes, because railing high inside a downtrend is still a momentum event.
//
// **THE BASELINE IS THE WHOLE POINT AND IT IS NOT THE UNCONDITIONAL MEAN.** Comparing signal trades
// against all trades would re-answer a question already settled. The drift hypothesis says the edge
// is "being long in a rising market", so the null must be RANDOM ENTRY OF THE SAME SIDE WITHIN THE
// SAME REGIME. Beating that is what beta cannot do.
//
// REGIME, pre-declared and single: close versus the 200-period SMA on the trading rung. Knowable at
// the bar, no lookahead, no tuned parameter. Calendar-year figures are printed as DESCRIPTION only
// and are not a second test -- running several regime definitions and reporting the kind one is the
// selection this register exists to prevent.
//
// **BOTH SIDES ARE RUN.** The drift hypothesis makes a second prediction that #162 could not test:
// if longs work only because the market rose, then SHORTS should work where it fell. A short side
// that comes alive in bear regimes would resolve the mechanism as genuinely bidirectional after all;
// one that stays dead is informative in the opposite direction.
//
// Trade construction is #143's frozen configuration, identical to #162.

import { loadCandles } from "../../backtest/lib/load-candles.js";
import { computeBoomHunter } from "./calc.js";
import { FEE_TIERS, REPRESENTATIVE_FUNDING_PCT_PER_HOUR } from "../../backtest/lib/costs.js";

const ATR_LEN = 14, ATR_MULT = 2.0, R_MULT = 2, HOLD_BARS = 200;
const SLIP_ENTRY_ATR = 0.05, SLIP_STOP_ATR = 0.15, SLIP_TARGET_ATR = 0;
const TAKER = FEE_TIERS.bitunix_futures_vip1.takerFeePct;
const ITERATIONS = 20000, SEED = 42;
const MIN_N = 60;
const SMA_LEN = 200;
const TF = "4h";
const TOL = 1e-9;

const mean = (xs) => (xs.length ? xs.reduce((s, x) => s + x, 0) / xs.length : null);
function mulberry32(seed) {
  let a = seed >>> 0;
  return function () { a |= 0; a = (a + 0x6d2b79f5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
function atrSeries(c, length) {
  const tr = c.map((x, i) => (i === 0 ? x.h - x.l : Math.max(x.h - x.l, Math.abs(x.h - c[i - 1].c), Math.abs(x.l - c[i - 1].c))));
  const out = new Array(c.length).fill(NaN);
  let s = 0; for (let i = 0; i < length; i++) s += tr[i];
  out[length - 1] = s / length;
  for (let i = length; i < c.length; i++) out[i] = (out[i - 1] * (length - 1) + tr[i]) / length;
  return out;
}
function runTrade(c, atr, idx, side) {
  const a = atr[idx];
  if (!Number.isFinite(a) || a <= 0) return null;
  const risk = ATR_MULT * a;
  const entry = side === "long" ? c[idx].o + SLIP_ENTRY_ATR * a : c[idx].o - SLIP_ENTRY_ATR * a;
  const stop = side === "long" ? entry - risk : entry + risk;
  const target = side === "long" ? entry + R_MULT * risk : entry - R_MULT * risk;
  const end = Math.min(c.length - 1, idx + HOLD_BARS);
  let pnl = null, hours = 0, won = 0;
  for (let j = idx; j <= end; j++) {
    const b = c[j];
    const hitStop = side === "long" ? b.l <= stop : b.h >= stop;
    const hitTarget = side === "long" ? b.h >= target : b.l <= target;
    if (hitStop) { const f = side === "long" ? stop - SLIP_STOP_ATR * a : stop + SLIP_STOP_ATR * a;
      pnl = side === "long" ? (f - entry) / entry : (entry - f) / entry; hours = (b.t - c[idx].t) / 3600; won = 0; break; }
    if (hitTarget) { const f = side === "long" ? target - SLIP_TARGET_ATR * a : target + SLIP_TARGET_ATR * a;
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

async function main() {
  console.log("EOT2 4h REGIME SPLIT -- is the long edge momentum, or is it beta?");
  console.log(`Regime: close vs SMA(${SMA_LEN}) on ${TF}. Pre-declared, single definition, knowable at the bar.`);
  console.log("NULL = random entry of the SAME SIDE within the SAME REGIME. Beating that is what beta cannot do.");
  console.log("#143 frozen config; 2R breakeven is 33.3% before costs.\n");

  for (const inst of ["BTC", "ETH"]) {
    const c = await loadCandles(TF, inst);
    const n = c.length;
    const atr = atrSeries(c, ATR_LEN);
    const { series } = computeBoomHunter(c);
    const { q3, q4 } = series;

    // regime
    const sma = new Array(n).fill(NaN);
    let run = 0;
    for (let i = 0; i < n; i++) {
      run += c[i].c;
      if (i >= SMA_LEN) run -= c[i - SMA_LEN].c;
      if (i >= SMA_LEN - 1) sma[i] = run / SMA_LEN;
    }
    const bull = new Int8Array(n);
    for (let i = 0; i < n; i++) bull[i] = Number.isFinite(sma[i]) ? (c[i].c >= sma[i] ? 1 : -1) : 0;

    // saturation state + events
    const st = new Int8Array(n);
    for (let i = 0; i < n; i++) {
      if (!Number.isFinite(q3[i]) || !Number.isFinite(q4[i])) continue;
      if (Math.abs(q3[i] - q4[i]) > TOL) continue;
      st[i] = q3[i] > 50 ? 1 : -1;
    }
    const upper = [], lower = [];
    for (let i = 1; i < n; i++) {
      if ((st[i] === 1 && st[i - 1] !== 1) || (st[i] !== 1 && st[i - 1] === 1)) upper.push(i);
      if ((st[i] === -1 && st[i - 1] !== -1) || (st[i] !== -1 && st[i - 1] === -1)) lower.push(i);
    }

    // precompute both sides for every bar
    const NET = { long: new Float64Array(n).fill(NaN), short: new Float64Array(n).fill(NaN) };
    const WON = { long: new Int8Array(n), short: new Int8Array(n) };
    for (let i = 0; i < n; i++) {
      for (const s of ["long", "short"]) {
        const t = runTrade(c, atr, i, s);
        if (t) { NET[s][i] = t.net; WON[s][i] = t.won; }
      }
    }

    const bullBars = [], bearBars = [];
    for (let i = 0; i < n; i++) { if (bull[i] === 1) bullBars.push(i); else if (bull[i] === -1) bearBars.push(i); }
    console.log(`===== ${inst} ${TF} -- ${n.toLocaleString()} bars   bull ${(bullBars.length / n * 100).toFixed(1)}%   bear ${(bearBars.length / n * 100).toFixed(1)}%`);
    console.log("   side    regime    n    win%     signal net%   regime baseline%   excess     p");

    for (const [side, evs] of [["long", upper], ["short", lower]]) {
      for (const [rname, want, pool] of [["BULL", 1, bullBars], ["BEAR", -1, bearBars]]) {
        const entries = evs.map((i) => i + 1).filter((e) => e < n && bull[e] === want && Number.isFinite(NET[side][e]));
        const valid = pool.map((i) => i + 1).filter((e) => e < n && bull[e] === want && Number.isFinite(NET[side][e]));
        if (entries.length < MIN_N || valid.length < 100) {
          console.log(`   ${side.padEnd(7)}${rname.padEnd(8)}${String(entries.length).padStart(5)}   below n>=${MIN_N} floor, INCONCLUSIVE`);
          continue;
        }
        const obs = mean(entries.map((e) => NET[side][e]));
        const win = entries.reduce((s, e) => s + WON[side][e], 0) / entries.length;
        const base = mean(valid.map((e) => NET[side][e]));

        // null: random same-side entries drawn from the same regime, same count
        const rnd = mulberry32(SEED);
        let ge = 0;
        for (let k = 0; k < ITERATIONS; k++) {
          let s2 = 0;
          for (let j = 0; j < entries.length; j++) s2 += NET[side][valid[Math.floor(rnd() * valid.length)]];
          if (s2 / entries.length >= obs) ge++;
        }
        const p = ge / ITERATIONS;
        console.log(
          `   ${side.padEnd(7)}${rname.padEnd(8)}${String(entries.length).padStart(5)}${(win * 100).toFixed(1).padStart(8)}%` +
          `${(obs * 100).toFixed(4).padStart(14)}%${(base * 100).toFixed(4).padStart(18)}%${((obs - base) * 100).toFixed(4).padStart(10)}pp${p.toFixed(4).padStart(9)}` +
          `${p < 0.05 ? " *" : ""}${obs > 0 ? "  [profitable]" : "  [loses]"}`,
        );
      }
    }

    // descriptive only -- NOT a second test
    const years = {};
    for (const i of upper) {
      const e = i + 1; if (e >= n || !Number.isFinite(NET.long[e])) continue;
      const y = new Date(c[e].t * 1000).getUTCFullYear();
      (years[y] = years[y] || []).push(NET.long[e]);
    }
    console.log("   long by year (descriptive, not a test): " +
      Object.keys(years).sort().map((y) => `${y}:${(mean(years[y]) * 100).toFixed(2)}%(n=${years[y].length})`).join("  "));
    console.log("");
  }
}

main().catch((e) => { console.error("Fatal:", e); process.exit(1); });
