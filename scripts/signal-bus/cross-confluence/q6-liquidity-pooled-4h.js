#!/usr/bin/env node
// THE CORE HYPOTHESIS ON 4h, POOLED ACROSS BTC/ETH/SOL/XRP -- the rung #193 could not test.
//
// **THIS SPENDS XRP.** XRP was held in reserve across #188, #191, #193 and #194 as the last clean
// pre-registration gate (scorecard 2 of 4: #143, #180 pass; #165, #186 fail). iapaulo asked for it
// directly after #194 reported that 4h was untestable at n=33-42. **After this run, "Boom Hunter has
// never been evaluated on XRP" is no longer true and no future q6 result can claim XRP as a clean
// out-of-sample gate.** That cost is recorded rather than absorbed silently.
//
// WHY 4h SPECIFICALLY. #188 found q6's only profitable arm on 4h (BTC +0.4988%, ETH +0.7252%, SOL
// +0.7420%) and nothing on 1h. #193 then refuted the short call on 1h but hit n=33-42 on 4h -- below
// the n>=60 floor -- so the refutation could not reach the rung where the signal actually lives.
// Pooling the four instruments is the only way to lift that population without inventing new knobs.
//
// REFERENTS (REFERENTS.md, named again in the verdict): "the blue line" = **q6**, `Plot54` -- NOT q1
// (#157), NOT q5 (#169), both SUPERSEDED. "buyside liquidity" = clusters of pivot **HIGHS** (#190).
//
// **EVERY THRESHOLD IS INHERITED, NOT RE-CHOSEN.** CEILING 109.9 (#188), RECENT_BARS 50 (#193),
// sweep definitions verbatim from #193 (accepted-above) and #194 (wick-reject, strict and loose).
// Nothing is re-tuned after seeing those results -- the ONLY change here is the instrument set,
// which is exactly what #193/#194 named as the honest next step.
//
// Pooling is legitimate here because #143's construction is ATR-normalised: every trade is 2R at
// 2.0x ATR(14), so a BTC trade and an XRP trade are the same unit of risk and can share a mean.
//
// XRP is ALSO reported standing alone, because a pooled number that is carried entirely by one
// instrument is a different fact from four instruments agreeing.

import { loadCandles } from "../../backtest/lib/load-candles.js";
import { computeBoomHunter } from "../boom-hunter/calc.js";
import { computeLiquidityPools } from "../ict/liquidity.js";
import { FEE_TIERS, REPRESENTATIVE_FUNDING_PCT_PER_HOUR } from "../../backtest/lib/costs.js";

const ATR_LEN = 14, ATR_MULT = 2.0, R_MULT = 2, HOLD_BARS = 200;
const SLIP_ENTRY_ATR = 0.05, SLIP_STOP_ATR = 0.15, SLIP_TARGET_ATR = 0;
const TAKER = FEE_TIERS.bitunix_futures_vip1.takerFeePct;
const MIN_N = 60;

const CEILING = 109.9;        // #188
const RECENT_BARS = 50;       // #193
const TF = "4h";
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

// one-sample t on mean net vs 0
const tstat = (g) => {
  const xs = g.map((x) => x.net);
  if (xs.length < 2) return NaN;
  const s = sd(xs) * Math.sqrt(xs.length / (xs.length - 1));
  return s > 0 ? mean(xs) / (s / Math.sqrt(xs.length)) : NaN;
};

const fmt = (label, g) => {
  if (g.length < MIN_N) return `    ${label.padEnd(36)}${String(g.length).padStart(5)}   below n>=${MIN_N}`;
  return `    ${label.padEnd(36)}${String(g.length).padStart(5)}${((g.filter((t) => t.won).length / g.length) * 100).toFixed(1).padStart(8)}%` +
         `${(mean(g.map((t) => t.net)) * 100).toFixed(4).padStart(12)}%${tstat(g).toFixed(2).padStart(9)}`;
};

async function main() {
  console.log(`CORE HYPOTHESIS ON ${TF}, POOLED ACROSS ${INSTRUMENTS.join("/")}.`);
  console.log("** THIS SPENDS XRP as a clean out-of-sample gate. Recorded, not absorbed silently. **");
  console.log("REFERENT: q6 = Plot54, the blue Downward Boom Line. BUYSIDE = clusters of pivot HIGHS.");
  console.log(`Thresholds INHERITED, not re-chosen: ceiling ${CEILING} (#188), window ${RECENT_BARS} bars (#193),`);
  console.log("sweep definitions verbatim from #193 (accepted-above) and #194 (wick-reject).");
  console.log(`${R_MULT}R @ ${ATR_MULT}x ATR(${ATR_LEN}), breakeven 33.3%. t is one-sample vs 0.\n`);

  const pool = {};
  const add = (k, side, t) => { (pool[k] ??= { long: [], short: [] })[side].push(t); };
  const perInst = {};

  for (const inst of INSTRUMENTS) {
    const c = await loadCandles(TF, inst);
    if (c.length < 500) { console.log(`(${inst}: only ${c.length} bars, skipped)`); continue; }
    const atr = atrSeries(c, ATR_LEN);
    const { series } = computeBoomHunter(c);
    const q6 = series.q6;
    const { pools } = computeLiquidityPools(c);

    // --- #193 condition: buyside pool swept by a CLOSE above its top, price still above it
    const swept = pools.filter((p) => p.side === "buyside" && p.brokenBarIdx !== null)
      .sort((a, b) => a.brokenBarIdx - b.brokenBarIdx);
    const aboveRecent = new Array(c.length).fill(false);
    let ptr = 0; const active = [];
    for (let i = 0; i < c.length; i++) {
      while (ptr < swept.length && swept[ptr].brokenBarIdx <= i) active.push(swept[ptr++]);
      for (const p of active) {
        if (c[i].c > p.top && i - p.brokenBarIdx <= RECENT_BARS) { aboveRecent[i] = true; break; }
      }
    }

    // --- #194 condition: wick through the top, close back below (pool still active)
    const strict = new Array(c.length).fill(false), loose = new Array(c.length).fill(false);
    for (const p of pools) {
      if (p.side !== "buyside") continue;
      const stop = p.brokenBarIdx !== null ? p.brokenBarIdx : c.length - 1;
      for (let j = p.createdBarIdx + 1; j <= stop; j++) {
        if (c[j].h < p.top) continue;
        if (c[j].c < p.bottom) strict[j] = true;
        if (c[j].c < p.top) loose[j] = true;
      }
    }
    const since = (f) => { const o = new Array(c.length).fill(Infinity); let last = -Infinity;
      for (let i = 0; i < c.length; i++) { if (f[i]) last = i; o[i] = i - last; } return o; };
    const sS = since(strict), sL = since(loose);

    const events = [];
    for (let i = 1; i < c.length; i++) if (q6[i] >= CEILING && q6[i - 1] < CEILING) events.push(i);

    const sets = {
      "(1) q6 alone": events,
      "(2) + above swept (<=50b)": events.filter((i) => aboveRecent[i]),
      "(3) complement of (2)": events.filter((i) => !aboveRecent[i]),
      "(4) + wick-reject LOOSE": events.filter((i) => sL[i] >= 1 && sL[i] <= RECENT_BARS),
      "(5) + wick-reject STRICT": events.filter((i) => sS[i] >= 1 && sS[i] <= RECENT_BARS),
    };
    perInst[inst] = { bars: c.length, events: events.length, cond: sets["(2) + above swept (<=50b)"].length };
    for (const [k, list] of Object.entries(sets)) {
      for (const side of ["long", "short"]) {
        for (const i of list) { const t = runTrade(c, atr, i + 1, side); if (t) add(k, side, t); }
      }
    }
    if (inst === "XRP") {
      console.log(`--- XRP ALONE (newly spent), ${TF}: ${c.length.toLocaleString()} bars, q6 ceiling events ${events.length}`);
      console.log("    arm                                     n    win%   net%/trade        t");
      for (const [k, list] of Object.entries(sets)) {
        for (const side of ["long", "short"]) {
          const g = list.map((i) => runTrade(c, atr, i + 1, side)).filter(Boolean);
          console.log(fmt(`${k}, ${side.toUpperCase()}`, g));
        }
      }
      console.log("");
    }
  }

  console.log("--- PER-INSTRUMENT POPULATIONS");
  for (const [k, v] of Object.entries(perInst)) {
    console.log(`    ${k.padEnd(5)} bars ${String(v.bars).padStart(6)}   q6 ceiling ${String(v.events).padStart(4)}   + above swept ${String(v.cond).padStart(4)}`);
  }

  console.log(`\n--- POOLED ${INSTRUMENTS.join("+")} ${TF}`);
  console.log("    arm                                     n    win%   net%/trade        t");
  for (const k of Object.keys(pool)) {
    for (const side of ["long", "short"]) console.log(fmt(`${k}, ${side.toUpperCase()}`, pool[k][side]));
  }

  console.log("\nHIS CLAIM HOLDS on 4h only if a conditioned SHORT arm is positive AND beats its own LONG.");
  console.log("If (2) tracks (1) and (3), the liquidity state is selecting nothing on this rung either.");
}

main().catch((e) => { console.error("Fatal:", e); process.exit(1); });
