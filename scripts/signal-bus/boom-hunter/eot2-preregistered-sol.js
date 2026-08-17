#!/usr/bin/env node
// PRE-REGISTERED SINGLE RUN -- EOT2 saturation, regime-conditional, SOL.
//
// Specification: skills/ict-smc-trader/PREREGISTRATION-eot2-regime.md, committed as b4f0f06 with
// `data/signal-bus/boom-hunter-sol.db` verified absent at that commit.
//
// **THIS RUNS ONCE.** Every constant below is hard-coded rather than exposed as a CLI flag, on
// #143's reasoning that a sweepable parameter is one that will get swept. There is no --instrument,
// no --tf, no --sma. Changing any value in this file after seeing a result invalidates the run and
// must be recorded as such rather than quietly re-run.
//
// The hypothesis (#164): the construction works WITH the prevailing regime on both sides -- long in
// bull, short in bear -- beating a same-regime random-entry baseline, while both counter-regime
// cells stay dead. That pattern refutes the drift confound, because being short in a falling market
// IS the baseline and beta cannot beat it.
//
// Sequence-structure questions raised alongside the pre-registration are OUT OF SCOPE by its own
// §4 and are deliberately absent from this file.

import { loadCandles } from "../../backtest/lib/load-candles.js";
import { computeBoomHunter } from "./calc.js";
import { FEE_TIERS, REPRESENTATIVE_FUNDING_PCT_PER_HOUR } from "../../backtest/lib/costs.js";

// ---- FROZEN. Do not parameterise. ----
const INSTRUMENT = "SOL";
const TF = "4h";
const SMA_LEN = 200;
const TOL = 1e-9;
const ATR_LEN = 14, ATR_MULT = 2.0, R_MULT = 2, HOLD_BARS = 200;
const SLIP_ENTRY_ATR = 0.05, SLIP_STOP_ATR = 0.15, SLIP_TARGET_ATR = 0;
const TAKER = FEE_TIERS.bitunix_futures_vip1.takerFeePct;
const ITERATIONS = 20000, SEED = 42;
const MIN_N = 60;
const ALPHA = 0.05;

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
  console.log("PRE-REGISTERED RUN -- EOT2 regime-conditional, " + INSTRUMENT + " " + TF + ", executed once.");
  console.log("Spec: skills/ict-smc-trader/PREREGISTRATION-eot2-regime.md (commit b4f0f06).");
  console.log(`Regime SMA(${SMA_LEN}) | ${R_MULT}R @ ${ATR_MULT}x ATR(${ATR_LEN}) | hold<=${HOLD_BARS} | slip ${SLIP_ENTRY_ATR}/${SLIP_STOP_ATR} | taker ${(TAKER * 100).toFixed(3)}% + funding`);
  console.log(`Null: random same-side entry within same regime, ${ITERATIONS} draws, seed ${SEED}.\n`);

  const c = await loadCandles(TF, INSTRUMENT);
  const n = c.length;
  const atr = atrSeries(c, ATR_LEN);
  const { series } = computeBoomHunter(c);
  const { q3, q4 } = series;

  const sma = new Array(n).fill(NaN);
  let run = 0;
  for (let i = 0; i < n; i++) {
    run += c[i].c;
    if (i >= SMA_LEN) run -= c[i - SMA_LEN].c;
    if (i >= SMA_LEN - 1) sma[i] = run / SMA_LEN;
  }
  const reg = new Int8Array(n);
  for (let i = 0; i < n; i++) reg[i] = Number.isFinite(sma[i]) ? (c[i].c >= sma[i] ? 1 : -1) : 0;

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

  const NET = { long: new Float64Array(n).fill(NaN), short: new Float64Array(n).fill(NaN) };
  const WON = { long: new Int8Array(n), short: new Int8Array(n) };
  for (let i = 0; i < n; i++) for (const s of ["long", "short"]) {
    const t = runTrade(c, atr, i, s);
    if (t) { NET[s][i] = t.net; WON[s][i] = t.won; }
  }

  const bullBars = [], bearBars = [];
  for (let i = 0; i < n; i++) { if (reg[i] === 1) bullBars.push(i); else if (reg[i] === -1) bearBars.push(i); }
  console.log(`${INSTRUMENT} ${TF}: ${n.toLocaleString()} bars, ${new Date(c[0].t * 1000).toISOString().slice(0, 10)} -> ${new Date(c[n - 1].t * 1000).toISOString().slice(0, 10)}`);
  console.log(`bull ${(bullBars.length / n * 100).toFixed(1)}%   bear ${(bearBars.length / n * 100).toFixed(1)}%\n`);
  console.log("   cell            n    win%    signal net%   regime baseline%    excess      p");

  const cells = {};
  for (const [side, evs] of [["long", upper], ["short", lower]]) {
    for (const [rname, want, pool] of [["BULL", 1, bullBars], ["BEAR", -1, bearBars]]) {
      const key = `${side}/${rname}`;
      const entries = evs.map((i) => i + 1).filter((e) => e < n && reg[e] === want && Number.isFinite(NET[side][e]));
      const valid = pool.map((i) => i + 1).filter((e) => e < n && reg[e] === want && Number.isFinite(NET[side][e]));
      if (!entries.length || valid.length < 100) { cells[key] = { n: entries.length, insufficient: true }; console.log(`   ${key.padEnd(14)}${String(entries.length).padStart(5)}   insufficient`); continue; }
      const obs = mean(entries.map((e) => NET[side][e]));
      const win = entries.reduce((s, e) => s + WON[side][e], 0) / entries.length;
      const base = mean(valid.map((e) => NET[side][e]));
      const rnd = mulberry32(SEED);
      let ge = 0;
      for (let k = 0; k < ITERATIONS; k++) {
        let s2 = 0;
        for (let j = 0; j < entries.length; j++) s2 += NET[side][valid[Math.floor(rnd() * valid.length)]];
        if (s2 / entries.length >= obs) ge++;
      }
      const p = ge / ITERATIONS;
      cells[key] = { n: entries.length, win, net: obs, base, excess: obs - base, p };
      console.log(
        `   ${key.padEnd(14)}${String(entries.length).padStart(5)}${(win * 100).toFixed(1).padStart(8)}%` +
        `${(obs * 100).toFixed(4).padStart(14)}%${(base * 100).toFixed(4).padStart(18)}%${((obs - base) * 100).toFixed(4).padStart(10)}pp${p.toFixed(4).padStart(9)}${p < ALPHA ? " *" : ""}`,
      );
    }
  }

  // ---- criteria from PREREGISTRATION §3, evaluated mechanically ----
  const LB = cells["long/BULL"], SB = cells["short/BEAR"];
  const LBe = cells["long/BEAR"], SBu = cells["short/BULL"];
  const floorOK = !LB.insufficient && !SB.insufficient && LB.n >= MIN_N && SB.n >= MIN_N;
  const c1 = floorOK && LB.net > 0 && SB.net > 0;
  const c2 = floorOK && LB.p < ALPHA && SB.p < ALPHA;
  const counterLive = (x) => x && !x.insufficient && x.p < ALPHA && x.excess > 0;
  const c4 = !counterLive(LBe) && !counterLive(SBu);

  console.log("\n---- CRITERIA (PREREGISTRATION §3) ----");
  console.log(`  3. population floor n>=${MIN_N} in both aligned cells .... ${floorOK ? "MET" : "NOT MET"}  (long/BULL n=${LB.n}, short/BEAR n=${SB.n})`);
  console.log(`  1. both aligned cells net > 0 ......................... ${c1 ? "MET" : "NOT MET"}`);
  console.log(`  2. both aligned cells beat baseline at p<${ALPHA} ......... ${c2 ? "MET" : "NOT MET"}`);
  console.log(`  4. neither counter-regime cell significantly positive . ${c4 ? "MET" : "NOT MET"}`);
  const verdict = !floorOK ? "INCONCLUSIVE (population floor)" : (c1 && c2 && c4) ? "PASS" : "FAIL";
  console.log(`\n  VERDICT: ${verdict}`);
  if (verdict === "PASS") console.log("  Authorises the #33 paper/live-shadow stage ONLY. Not portfolio wiring. C-2 and C-3 still apply.");
  if (verdict === "FAIL") console.log("  Recorded as a FAIL. No partial credit, no amendment, no re-run.");
}

main().catch((e) => { console.error("Fatal:", e); process.exit(1); });
