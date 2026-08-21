#!/usr/bin/env node
// BREAKER TRADE CONSTRUCTION — turning #216's descriptive finding into a tradeable rule, or failing to.
//
// #216 established that mitigated order blocks are NOT dead: they beat matched placebos on reaction
// (Welch t = 2.93-12.03) and on same-bar rejection (z = 7.23-10.27) across two instrument groups, and
// they react with FLIPPED polarity -- iapaulo's breaker reading from 2026-08-18. That was DESCRIPTIVE.
//
// **#192 IS THE STANDING WARNING THIS TEST EXISTS TO HEED: liquidity pools cleared their null at
// z=3.27 and were still untradeable through a stop.** A contact effect and an edge are different
// things, and the gap between them is where most of this register's failures live.
//
// CONSTRUCTION -- the geometry is the block's own, not a number I picked:
//   mitigated BEARISH OB (price broke UP through it, returns DOWN)  -> now SUPPORT  -> LONG
//     entry  resting BUY limit at barHigh (the edge price meets first coming down)
//   mitigated BULLISH OB (price broke DOWN through it, returns UP)  -> now RESISTANCE -> SHORT
//     entry  resting SELL limit at barLow
//   A resting limit fills maker and cannot fill worse than its price (#200).
//
// TWO STOPS, both principled, neither tuned:
//   ATR         2.0x ATR(14) from entry -- the house standard, comparable to every other row
//   STRUCTURAL  beyond the block's FAR edge plus 0.25 ATR -- the stop the geometry itself implies:
//               if price closes through the whole block the breaker thesis is simply wrong
//   Target 2R on the realised risk in both cases, so the two are compared at equal R.
//
// CONTROLS, per the standing rules:
//   * a RANDOM null of the SAME SIDE, matched by count (#210) -- long trades against random longs,
//     short trades against random shorts, because in this corpus those baselines differ enormously
//   * per-rung, never pooled across rungs (#204)
//   * cluster t alongside naive t, since breaker touches can overlap (#204)
//
// 4h and 1h, ORIGINAL and FRESH instrument groups reported separately. Existing data only.

import { loadCandles } from "../../backtest/lib/load-candles.js";
import { computeSMC } from "./calc.js";
import { FEE_TIERS, REPRESENTATIVE_FUNDING_PCT_PER_HOUR } from "../../backtest/lib/costs.js";

const ATR_LEN = 14, R_MULT = 2, HOLD_BARS = 200, SLIP_STOP_ATR = 0.15;
const ATR_STOP_MULT = 2.0, STRUCT_BUFFER_ATR = 0.25;
const MAX_WAIT = 500, MIN_N = 60, SEEDS = 300;
const TAKER = FEE_TIERS.bitunix_futures_vip1.takerFeePct;
const MAKER = FEE_TIERS.bitunix_futures_vip1.makerFeePct;
const GROUPS = {
  "ORIGINAL BTC/ETH/SOL/XRP": ["BTC", "ETH", "SOL", "XRP"],
  "FRESH BNB/ADA/LTC/LINK": ["BNB", "ADA", "LTC", "LINK"],
};

const mean = (xs) => (xs.length ? xs.reduce((s, x) => s + x, 0) / xs.length : NaN);
const sd = (xs) => { const m = mean(xs); return Math.sqrt(mean(xs.map((x) => (x - m) ** 2))); };
const tOf = (xs) => { if (xs.length < 2) return NaN; const s = sd(xs) * Math.sqrt(xs.length / (xs.length - 1)); return s > 0 ? mean(xs) / (s / Math.sqrt(xs.length)) : NaN; };

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
const fund = (c, i, j) => REPRESENTATIVE_FUNDING_PCT_PER_HOUR * Math.max(0, (c[j].t - c[i].t) / 3600);

/** Trade from a maker limit fill at `entry`, with an explicit stop price. Target is 2R on real risk. */
function trade(c, atr, i, entry, stop, dir) {
  const a = atr[i];
  if (!Number.isFinite(a) || a <= 0) return null;
  const risk = Math.abs(entry - stop);
  if (risk <= 0) return null;
  const tgt = dir === "long" ? entry + R_MULT * risk : entry - R_MULT * risk;
  const end = Math.min(c.length - 1, i + HOLD_BARS);
  for (let j = i; j <= end; j++) {
    const b = c[j];
    const hitStop = dir === "long" ? b.l <= stop : b.h >= stop;
    const hitTgt = dir === "long" ? b.h >= tgt : b.l <= tgt;
    if (hitStop) {
      const fill = dir === "long" ? stop - SLIP_STOP_ATR * a : stop + SLIP_STOP_ATR * a;
      const raw = dir === "long" ? (fill - entry) / entry : (entry - fill) / entry;
      return { net: raw - MAKER - TAKER - fund(c, i, j), won: 0, entry: i, exit: j };
    }
    if (hitTgt) {
      const raw = dir === "long" ? (tgt - entry) / entry : (entry - tgt) / entry;
      return { net: raw - 2 * MAKER - fund(c, i, j), won: 1, entry: i, exit: j };
    }
  }
  if (end < i + HOLD_BARS) return null;
  const raw = dir === "long" ? (c[end].c - entry) / entry : (entry - c[end].c) / entry;
  return { net: raw - MAKER - TAKER - fund(c, i, end), won: raw > 0 ? 1 : 0, entry: i, exit: end };
}

function clusters(ts) {
  const out = []; let cur = [];
  for (const t of [...ts].sort((a, b) => a.entry - b.entry)) {
    if (cur.length && t.entry <= cur[cur.length - 1].exit) cur.push(t);
    else { if (cur.length) out.push(mean(cur.map((x) => x.net))); cur = [t]; }
  }
  if (cur.length) out.push(mean(cur.map((x) => x.net)));
  return out;
}

async function main() {
  console.log("BREAKER TRADE CONSTRUCTION — #216's descriptive finding put through a stop.");
  console.log("Broken bearish OB -> support -> LONG at barHigh.  Broken bullish OB -> resistance -> SHORT at barLow.");
  console.log("Resting limit = maker entry. Two stops: 2.0x ATR, and structural (far edge + 0.25 ATR). Target 2R.");
  console.log("#192 is the warning: liquidity pools cleared their null at z=3.27 and were still untradeable.\n");

  for (const tf of ["4h", "1h"]) {
    for (const [label, insts] of Object.entries(GROUPS)) {
      const A = { long: { atr: [], struct: [] }, short: { atr: [], struct: [] } };
      const nul = { long: new Array(SEEDS).fill(0).map(() => []), short: new Array(SEEDS).fill(0).map(() => []) };

      for (const inst of insts) {
        let c; try { c = await loadCandles(tf, inst); } catch { continue; }
        if (!c || c.length < 800) continue;
        const atr = atrSeries(c, ATR_LEN);
        const { orderBlocks } = computeSMC(c);
        let nL = 0, nS = 0;

        for (const ob of orderBlocks) {
          if (ob.mitigatedBarIdx === null) continue;
          const from = ob.mitigatedBarIdx + 1;
          const dir = ob.side === "bearish" ? "long" : "short";     // FLIPPED polarity
          const entry = ob.side === "bearish" ? ob.barHigh : ob.barLow;
          // first bar that trades to the limit price from the returning side
          let t = -1;
          const end = Math.min(c.length - 1, from + MAX_WAIT);
          for (let j = from; j <= end; j++) {
            if (dir === "long" ? c[j].l <= entry : c[j].h >= entry) { t = j; break; }
          }
          if (t < 0) continue;
          const a = atr[t];
          if (!Number.isFinite(a) || a <= 0) continue;

          const atrStop = dir === "long" ? entry - ATR_STOP_MULT * a : entry + ATR_STOP_MULT * a;
          const structStop = dir === "long" ? ob.barLow - STRUCT_BUFFER_ATR * a : ob.barHigh + STRUCT_BUFFER_ATR * a;
          const t1 = trade(c, atr, t, entry, atrStop, dir);
          const t2 = trade(c, atr, t, entry, structStop, dir);
          if (t1) { A[dir].atr.push(t1); if (dir === "long") nL++; else nS++; }
          if (t2) A[dir].struct.push(t2);
        }

        // same-side random nulls, matched by count, entering at the next bar's open (market)
        const pool = [];
        for (let i = ATR_LEN + 1; i < c.length - HOLD_BARS - 1; i++) pool.push(i);
        for (const [dir, n] of [["long", nL], ["short", nS]]) {
          for (let s = 0; s < SEEDS; s++) {
            const rnd = mulberry32(11000 + s * 7919 + inst.length + tf.length + dir.length);
            for (let k = 0; k < n; k++) {
              const ix = pool[Math.floor(rnd() * pool.length)];
              const e = c[ix + 1]?.o; const a = atr[ix + 1];
              if (!Number.isFinite(e) || !Number.isFinite(a) || a <= 0) continue;
              const st = dir === "long" ? e - ATR_STOP_MULT * a : e + ATR_STOP_MULT * a;
              const r = trade(c, atr, ix + 1, e, st, dir);
              if (r) nul[dir][s].push(r.net);
            }
          }
        }
      }

      console.log(`===== ${tf}  ${label}`);
      for (const dir of ["long", "short"]) {
        const mN = nul[dir].map(mean).filter(Number.isFinite).sort((a, b) => a - b);
        const pct = (v) => (mN.length ? mN.filter((x) => x < v).length / mN.length * 100 : NaN);
        console.log(`  ${dir === "long" ? "LONG  (broken bearish OB -> support)" : "SHORT (broken bullish OB -> resistance)"}   random-${dir} null ${(mean(mN) * 100).toFixed(4)}%`);
        for (const [name, g] of [["  ATR stop", A[dir].atr], ["  structural stop", A[dir].struct]]) {
          if (g.length < MIN_N) { console.log(`  ${name.padEnd(20)} n=${g.length} -- below n>=${MIN_N}`); continue; }
          const nets = g.map((x) => x.net), cl = clusters(g);
          console.log(`  ${name.padEnd(20)} n=${String(g.length).padStart(5)}  win ${((g.filter((x) => x.won).length / g.length) * 100).toFixed(1).padStart(5)}%  net ${(mean(nets) * 100).toFixed(4).padStart(10)}%  t ${tOf(nets).toFixed(2).padStart(6)}  cluster t ${tOf(cl).toFixed(2).padStart(6)}  vs null ${pct(mean(nets)).toFixed(1)}%`);
        }
      }
      console.log("");
    }
  }
  console.log("A breaker arm is real only if it is positive AND beats its SAME-SIDE random null.");
  console.log("Beating zero while matching the null means the market's drift did the work, not the level.");
}

main().catch((e) => { console.error("Fatal:", e); process.exit(1); });
