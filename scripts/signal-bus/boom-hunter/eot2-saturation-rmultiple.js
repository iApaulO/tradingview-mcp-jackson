#!/usr/bin/env node
// #161 REBUILT AS AN R-MULTIPLE CONSTRUCTION under #143's frozen configuration.
//
// #161 found that the EOT2 saturation state (q3 == q4, the exact Mobius fixed-point detector for
// "EOT2 is railed") predicts continuation in the direction of the rail: 26 of 120 cells at p<0.05
// against ~6 expected, every one sign-consistent, AND the mirror working on both instruments --
// the only bidirectional survivor of this entire session. Its cost check cleared on 1h and 4h.
//
// That cost check was FEES ONLY. #155 is the standing warning: #154 cleared a fee-only check by a
// comfortable margin and then, under this exact construction with slippage and funding, turned out
// to move a losing signal to break-even rather than produce a profitable one. The forward-return
// contrast is not the strategy; this is.
//
// PRE-DECLARED SCOPE, fixed in #161 BEFORE this ran and honoured here: **1h and 4h only, both
// directions.** 15m was excluded in advance on cost-scaling grounds (a similar ATR-denominated
// excess is worth far less money on a finer rung, and all 8 of its cells failed the fee-only check).
// Running it now and reporting it only if it happened to pass would be selection, so it is not run.
//
// SIDE MAPPING follows #161's measured signs, not an assumption: the UPPER rail predicts up and the
// LOWER rail predicts down, on BOTH entry and exit. So upper-rail events are long and lower-rail
// events are short.
//
// NULL. Outcomes are precomputed for every bar and every side, so the null can circular-shift the
// EVENT TIMES while holding the side mix and the trade count fixed -- it asks whether these
// particular bars beat randomly-timed entries of the same construction. Precomputing also makes
// 20,000 iterations tractable; simulating trades inside the loop would be ~14M simulations per cell.
//
// available_at: the event is known at its own bar; entry is the NEXT bar's open, as in #143/#155.

import { loadCandles } from "../../backtest/lib/load-candles.js";
import { computeBoomHunter } from "./calc.js";
import { FEE_TIERS, REPRESENTATIVE_FUNDING_PCT_PER_HOUR } from "../../backtest/lib/costs.js";

// ---- #143 frozen config, verbatim ----
const ATR_LEN = 14, ATR_MULT = 2.0, R_MULT = 2, HOLD_BARS = 200;
const SLIP_ENTRY_ATR = 0.05, SLIP_STOP_ATR = 0.15, SLIP_TARGET_ATR = 0;
const TAKER = FEE_TIERS.bitunix_futures_vip1.takerFeePct;
const ITERATIONS = 20000, SEED = 42;
const MIN_N = 60;

const TFS = ["4h", "1h"];   // pre-declared in #161; 15m deliberately excluded
const TOL = 1e-9;

const mean = (xs) => (xs.length ? xs.reduce((s, x) => s + x, 0) / xs.length : null);
function mulberry32(seed) {
  let a = seed >>> 0;
  return function () { a |= 0; a = (a + 0x6d2b79f5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
function atrSeries(c, length) {
  const tr = c.map((x, i) => (i === 0 ? x.h - x.l : Math.max(x.h - x.l, Math.abs(x.h - c[i - 1].c), Math.abs(x.l - c[i - 1].c))));
  const out = new Array(c.length).fill(NaN);
  if (c.length < length) return out;
  let s = 0; for (let i = 0; i < length; i++) s += tr[i];
  out[length - 1] = s / length;
  for (let i = length; i < c.length; i++) out[i] = (out[i - 1] * (length - 1) + tr[i]) / length;
  return out;
}

// Full #143 trade, evaluated at entry bar `idx`.
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
    if (hitStop) {
      const fill = side === "long" ? stop - SLIP_STOP_ATR * a : stop + SLIP_STOP_ATR * a;
      pnl = side === "long" ? (fill - entry) / entry : (entry - fill) / entry;
      hours = (b.t - c[idx].t) / 3600; won = 0; break;
    }
    if (hitTarget) {
      const fill = side === "long" ? target - SLIP_TARGET_ATR * a : target + SLIP_TARGET_ATR * a;
      pnl = side === "long" ? (fill - entry) / entry : (entry - fill) / entry;
      hours = (b.t - c[idx].t) / 3600; won = 1; break;
    }
  }
  if (pnl === null) {
    if (end <= idx) return null;
    const b = c[end];
    const fill = side === "long" ? b.c - SLIP_ENTRY_ATR * a : b.c + SLIP_ENTRY_ATR * a;
    pnl = side === "long" ? (fill - entry) / entry : (entry - fill) / entry;
    hours = (b.t - c[idx].t) / 3600; won = pnl > 0 ? 1 : 0;
  }
  return { net: pnl - 2 * TAKER - REPRESENTATIVE_FUNDING_PCT_PER_HOUR * Math.max(0, hours), won };
}

async function main() {
  console.log("#161 REBUILT AS R-MULTIPLE -- #143 frozen config, full slippage and funding.");
  console.log(`${R_MULT}R @ ${ATR_MULT}x ATR(${ATR_LEN}) | hold<=${HOLD_BARS} | MTM | slip ${SLIP_ENTRY_ATR}/${SLIP_STOP_ATR} ATR | taker ${(TAKER * 100).toFixed(3)}% | funding`);
  console.log("Scope pre-declared in #161: 1h and 4h only, both directions. 15m excluded in advance.");
  console.log(`Null: circular shift of event TIMES, side mix and trade count held fixed, ${ITERATIONS} iters.`);
  console.log(`2R breakeven win rate is 33.3% before costs.\n`);

  for (const inst of ["BTC", "ETH"]) {
    for (const tf of TFS) {
      const c = await loadCandles(tf, inst);
      const atr = atrSeries(c, ATR_LEN);
      const n = c.length;
      const { series } = computeBoomHunter(c);
      const { q3, q4 } = series;

      const st = new Int8Array(n);
      for (let i = 0; i < n; i++) {
        if (!Number.isFinite(q3[i]) || !Number.isFinite(q4[i])) continue;
        if (Math.abs(q3[i] - q4[i]) > TOL) continue;
        st[i] = q3[i] > 50 ? 1 : -1;
      }

      // Precompute the outcome of a #143 trade entered at EVERY bar, both sides.
      const netL = new Float64Array(n).fill(NaN), wonL = new Int8Array(n);
      const netS = new Float64Array(n).fill(NaN), wonS = new Int8Array(n);
      for (let i = 0; i < n; i++) {
        const L = runTrade(c, atr, i, "long");
        if (L) { netL[i] = L.net; wonL[i] = L.won; }
        const S = runTrade(c, atr, i, "short");
        if (S) { netS[i] = S.net; wonS[i] = S.won; }
      }

      const ev = { enter_upper: [], exit_upper: [], enter_lower: [], exit_lower: [] };
      for (let i = 1; i < n; i++) {
        if (st[i] === 1 && st[i - 1] !== 1) ev.enter_upper.push(i);
        if (st[i] !== 1 && st[i - 1] === 1) ev.exit_upper.push(i);
        if (st[i] === -1 && st[i - 1] !== -1) ev.enter_lower.push(i);
        if (st[i] !== -1 && st[i - 1] === -1) ev.exit_lower.push(i);
      }
      const SIDE = { enter_upper: "long", exit_upper: "long", enter_lower: "short", exit_lower: "short" };

      console.log(`===== ${inst} ${tf} -- ${n.toLocaleString()} bars`);
      console.log("   event         side     n    win%      net%/trade     null net%    p");

      const combos = Object.entries(ev).map(([k, v]) => [k, v]);
      combos.push(["ALL_upper(long)", [...ev.enter_upper, ...ev.exit_upper].sort((a, b) => a - b)]);
      combos.push(["ALL_lower(short)", [...ev.enter_lower, ...ev.exit_lower].sort((a, b) => a - b)]);

      for (const [name, idxs] of combos) {
        const side = SIDE[name] || (name.includes("upper") ? "long" : "short");
        const NET = side === "long" ? netL : netS, WON = side === "long" ? wonL : wonS;
        const entries = idxs.map((i) => i + 1).filter((e) => e < n && Number.isFinite(NET[e]));
        if (entries.length < MIN_N) { console.log(`   ${name.padEnd(17)}${side.padEnd(7)}${String(entries.length).padStart(5)}  below n>=${MIN_N} floor, INCONCLUSIVE`); continue; }
        const obs = mean(entries.map((e) => NET[e]));
        const win = entries.reduce((s, e) => s + WON[e], 0) / entries.length;

        const rnd = mulberry32(SEED);
        let ge = 0, nullSum = 0;
        for (let k = 0; k < ITERATIONS; k++) {
          const off = 1 + Math.floor(rnd() * (n - 2));
          let s2 = 0, n2 = 0;
          for (const e of entries) {
            const j = (e + off) % n;
            const v = NET[j];
            if (Number.isFinite(v)) { s2 += v; n2++; }
          }
          if (!n2) continue;
          const m = s2 / n2;
          nullSum += m;
          if (m >= obs) ge++;
        }
        const p = ge / ITERATIONS;
        console.log(
          `   ${name.padEnd(17)}${side.padEnd(7)}${String(entries.length).padStart(5)}${(win * 100).toFixed(1).padStart(8)}%` +
          `${(obs * 100).toFixed(4).padStart(14)}%${((nullSum / ITERATIONS) * 100).toFixed(4).padStart(13)}%${p.toFixed(4).padStart(8)}` +
          `${p < 0.05 ? " *" : ""}${obs > 0 ? "  [profitable]" : "  [loses]"}`,
        );
      }
      console.log("");
    }
  }
}

main().catch((e) => { console.error("Fatal:", e); process.exit(1); });
