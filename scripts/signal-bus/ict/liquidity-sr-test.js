#!/usr/bin/env node
// QUEUE ITEM Q1 -- DO BUYSIDE/SELLSIDE LIQUIDITY POOLS ACT AS SUPPORT/RESISTANCE?
//
// REFERENT NOTE, because this project has been burned by exactly this: **"Q1" here is QUEUE.md item
// Q1, NOT Boom Hunter's q1 series.** Nothing in this file touches Boom Hunter. See REFERENTS.md.
//
// IAPAULO'S CLAIM (2026-08-19): "you said that buyside/sellside liquidity zone have no support
// resistance value and im saying that there is and it is integral." **He is right that I overreached
// and the register shows it.** Two things were tested and NEITHER is the S/R claim:
//   * EQH/EQL SWEEP -> REVERSAL, falsified -- and that row itself says to read it as "falsified *as
//     operationalized via EQH/EQL*", not as a blanket claim.
//   * Liquidity pools as STANDING TARGETS ("price runs to liquidity") -- the durable-pool-ahead
//     configuration is rare (#150s).
// Support/resistance is a THIRD question: does price APPROACHING an unbroken pool REACT at it? That
// is about the approach, not about what follows a sweep, and not about pools as objectives. I
// collapsed three questions into one negative. This tests the actual claim.
//
// CONSTRUCTION
//   Event: an ACTIVE pool whose near edge price has not yet reached, first touched from the
//   untouched side. Buyside pools sit ABOVE price (clusters of HIGHS, #190) so the near edge is
//   `bottom` and the approach is from below; sellside pools sit BELOW, near edge `top`, approach
//   from above. Pools are only eligible if price was on the untouched side at the pool's OWN
//   detection bar (`createdBarIdx`), and touches are counted from `createdBarIdx + 1` onward --
//   available_at discipline, nothing uses a pool before it could be known.
//
//   (a) IS THERE A REACTION AT ALL? Reaction is measured in the S/R direction: for a buyside pool
//   (resistance) a reaction is price going DOWN after the touch; for a sellside pool (support), UP.
//   Reported as mean signed reaction over W bars and as an immediate-rejection rate.
//
//   **THE CONTROL IS THE WHOLE TEST.** Price only reaches a level by travelling to it, and any level
//   price travels to shows structure. So each real pool is matched to PLACEBO levels: the same near
//   edge displaced by u x ATR (u ~ U[1,3], random sign, rejected if it lands back inside the real
//   band), touched from the same side, searched from the same bar. That holds constant the period,
//   the volatility, the approach direction and the fact that price had to get there -- leaving only
//   "is THIS level special". A pool that beats its placebo is doing something; one that matches it
//   is just a level price happened to reach.
//
//   (b) IS THE REACTION TRADEABLE? Fade the touch under #143's frozen construction -- SHORT at a
//   buyside pool, LONG at a sellside pool, entering at the next bar's open. **(a) can be real while
//   (b) is blocked and the verdict must keep them separate** -- that distinction is the thing I
//   collapsed last time, so it is reported as two independent lines and never merged.
//
// NOT stratified by pivotCount: `liquidity.js` sets MIN_CLUSTER = 3, so every pool it creates is
// already k>=3 and the stratification would be vacuous. Stated here so nobody reads a "k>=3 agrees
// with all pools" line as corroboration -- they are the same rows.
// BTC/ETH/SOL on 1h and 4h. XRP held in reserve -- pre-registration scorecard is 2 of 4.

import { loadCandles } from "../../backtest/lib/load-candles.js";
import { computeLiquidityPools } from "./liquidity.js";
import { FEE_TIERS, REPRESENTATIVE_FUNDING_PCT_PER_HOUR } from "../../backtest/lib/costs.js";

const ATR_LEN = 14, ATR_MULT = 2.0, R_MULT = 2, HOLD_BARS = 200;
const SLIP_ENTRY_ATR = 0.05, SLIP_STOP_ATR = 0.15, SLIP_TARGET_ATR = 0;
const TAKER = FEE_TIERS.bitunix_futures_vip1.takerFeePct;

const W = 12;               // reaction window, bars after first touch
const N_PLACEBO = 3;        // placebo levels per real pool
const MAX_WAIT = 500;       // give up looking for a touch after this many bars
const MIN_N = 60;
const SEED = 20260819;

const TFS = ["1h", "4h"];
const INSTRUMENTS = ["BTC", "ETH", "SOL"];

const mean = (xs) => (xs.length ? xs.reduce((s, x) => s + x, 0) / xs.length : NaN);
const sd = (xs) => { const m = mean(xs); return Math.sqrt(mean(xs.map((x) => (x - m) ** 2))); };

function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function atrSeries(c, L) {
  const tr = c.map((x, i) => (i === 0 ? x.h - x.l : Math.max(x.h - x.l, Math.abs(x.h - c[i - 1].c), Math.abs(x.l - c[i - 1].c))));
  const o = new Array(c.length).fill(NaN);
  let s = 0; for (let i = 0; i < L; i++) s += tr[i];
  o[L - 1] = s / L;
  for (let i = L; i < c.length; i++) o[i] = (o[i - 1] * (L - 1) + tr[i]) / L;
  return o;
}

// First bar after `from` where price reaches `level` from the given side.
function firstTouch(c, from, level, side) {
  const end = Math.min(c.length - 1, from + MAX_WAIT);
  for (let j = from; j <= end; j++) {
    if (side === "buyside" ? c[j].h >= level : c[j].l <= level) return j;
  }
  return -1;
}

// Reaction in the S/R direction over W bars, plus whether the touch bar closed back on the
// approach side (an immediate rejection).
function reaction(c, t, level, side) {
  const k = Math.min(c.length - 1, t + W);
  if (k <= t) return null;
  const ret = (c[k].c - level) / level;
  return {
    signed: side === "buyside" ? -ret : ret,        // >0 means the level held
    rejected: side === "buyside" ? (c[t].c < level ? 1 : 0) : (c[t].c > level ? 1 : 0),
  };
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

// Two-proportion z for real-vs-placebo immediate-rejection rate.
function propZ(a, b) {
  const na = a.length, nb = b.length;
  if (!na || !nb) return NaN;
  const xa = a.reduce((s, v) => s + v, 0), xb = b.reduce((s, v) => s + v, 0);
  const pa = xa / na, pb = xb / nb, pp = (xa + xb) / (na + nb);
  const se = Math.sqrt(pp * (1 - pp) * (1 / na + 1 / nb));
  return se > 0 ? (pa - pb) / se : NaN;
}

// Welch t for real-vs-placebo mean reaction.
function welch(a, b) {
  const na = a.length, nb = b.length;
  if (na < 2 || nb < 2) return NaN;
  const va = sd(a) ** 2 * na / (na - 1), vb = sd(b) ** 2 * nb / (nb - 1);
  return (mean(a) - mean(b)) / Math.sqrt(va / na + vb / nb);
}

async function main() {
  console.log("QUEUE Q1 -- DO LIQUIDITY POOLS ACT AS SUPPORT/RESISTANCE?");
  console.log('("Q1" = QUEUE.md item Q1, NOT Boom Hunter q1. Nothing here touches Boom Hunter.)');
  console.log("Buyside pools = clusters of HIGHS above price (resistance); sellside = lows below (support).");
  console.log(`Reaction measured over W=${W} bars in the S/R direction. Each pool matched to ${N_PLACEBO} placebo`);
  console.log("levels at +/- 1-3 ATR, touched from the same side, searched from the same bar.");
  console.log(`Tradeability = fade the touch, ${R_MULT}R @ ${ATR_MULT}x ATR(${ATR_LEN}). XRP held in reserve.\n`);

  const pooled = {};
  for (const tf of TFS) pooled[tf] = { rej: [], prej: [], real: [], plac: [] };

  for (const inst of INSTRUMENTS) {
    for (const tf of TFS) {
      const c = await loadCandles(tf, inst);
      if (c.length < 1000) continue;
      const atr = atrSeries(c, ATR_LEN);
      const { pools } = computeLiquidityPools(c);
      const rnd = mulberry32(SEED);

      const acc = { all: { real: [], plac: [], rej: [], prej: [], trades: [] } };

      for (const p of pools) {
        const i0 = p.createdBarIdx;
        if (!Number.isFinite(atr[i0]) || atr[i0] <= 0) continue;
        const edge = p.side === "buyside" ? p.bottom : p.top;
        // price must be on the untouched side when the pool is detected
        if (p.side === "buyside" ? !(c[i0].c < edge) : !(c[i0].c > edge)) continue;

        const t = firstTouch(c, i0 + 1, edge, p.side);
        if (t < 0) continue;
        const r = reaction(c, t, edge, p.side);
        if (!r) continue;

        // placebos: same side, same search start, displaced 1-3 ATR
        const plac = [];
        for (let m = 0; m < N_PLACEBO; m++) {
          const u = 1 + 2 * rnd();
          const sgn = rnd() < 0.5 ? -1 : 1;
          const lvl = edge + sgn * u * atr[i0];
          if (lvl > p.bottom && lvl < p.top) continue;          // inside the real band
          if (p.side === "buyside" ? !(c[i0].c < lvl) : !(c[i0].c > lvl)) continue;
          const tp = firstTouch(c, i0 + 1, lvl, p.side);
          if (tp < 0) continue;
          const rp = reaction(c, tp, lvl, p.side);
          if (rp) plac.push(rp);
        }

        const trade = runTrade(c, atr, t + 1, p.side === "buyside" ? "short" : "long");
        for (const b of ["all"]) {
          acc[b].real.push(r.signed);
          acc[b].rej.push(r.rejected);
          for (const q of plac) { acc[b].plac.push(q.signed); acc[b].prej.push(q.rejected); }
          if (trade) acc[b].trades.push(trade);
        }
      }

      console.log(`===== ${inst} ${tf}   pools ${pools.length.toLocaleString()}   eligible first-touches ${acc.all.real.length.toLocaleString()}   (all are k>=3 by construction)`);
      for (const [name, a] of [["all pools", acc.all]]) {
        if (a.real.length < MIN_N) { console.log(`    ${name.padEnd(11)} n=${a.real.length} -- below n>=${MIN_N}`); continue; }
        const t = welch(a.real, a.plac);
        console.log(
          `    ${name.padEnd(11)} n=${String(a.real.length).padStart(5)}` +
          `   (a) reaction ${(mean(a.real) * 100).toFixed(4)}%  vs placebo ${(mean(a.plac) * 100).toFixed(4)}%  (n=${a.plac.length})  Welch t=${t.toFixed(2)}` +
          `   reject-rate ${(mean(a.rej) * 100).toFixed(1)}% vs ${(mean(a.prej) * 100).toFixed(1)}%  z=${propZ(a.rej, a.prej).toFixed(2)}`);
        const tr = a.trades;
        console.log(
          `    ${" ".repeat(11)}      ` +
          `   (b) fade the touch: n=${tr.length}  ` +
          (tr.length < MIN_N ? `below n>=${MIN_N}`
            : `win ${((tr.filter((x) => x.won).length / tr.length) * 100).toFixed(1)}%  net ${(mean(tr.map((x) => x.net)) * 100).toFixed(4)}%/trade`));
      }
      for (const k of ["rej", "prej", "real", "plac"]) pooled[tf][k].push(...acc.all[k]);
      console.log("");
    }
  }

  console.log("===== POOLED ACROSS BTC/ETH/SOL, per rung");
  console.log("     (the rung split is POST-HOC -- it was not specified before the per-cell results were seen)");
  for (const tf of TFS) {
    const a = pooled[tf];
    console.log(
      `  ${tf}  n=${String(a.real.length).padStart(5)}` +
      `   reaction ${(mean(a.real) * 100).toFixed(4)}% vs placebo ${(mean(a.plac) * 100).toFixed(4)}%  Welch t=${welch(a.real, a.plac).toFixed(2)}` +
      `   |  reject ${(mean(a.rej) * 100).toFixed(1)}% vs ${(mean(a.prej) * 100).toFixed(1)}%  z=${propZ(a.rej, a.prej).toFixed(2)}`);
  }
  console.log("");
  console.log("(a) beating placebo = the level is doing something. (b) > 0 = it is tradeable as a fade.");
  console.log("These are SEPARATE verdicts. (a) real with (b) blocked is a coherent, common outcome here.");
}

main().catch((e) => { console.error("Fatal:", e); process.exit(1); });
