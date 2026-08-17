#!/usr/bin/env node
// WHAT IS THE EOT2 SATURATION STATE, AND DOES IT PREDICT ANYTHING?
//
// #159 found that 26% of Boom Hunter event rows have q3 EXACTLY equal to q4, and that 100% of those
// sit at a bound -- a consequence of the quotient being a Mobius transform `(x+K)/(Kx+1)`, which has
// fixed points at x = +/-1 for EVERY K. So q3 == q4 is an exact, cost-free detector of "EOT2 is
// railed", and it is now verified against the live chart (100.00% at-bound there too).
//
// iapaulo's question: does it move, does it have boundaries, and does it predict anything?
//
// THREE SEPARATE QUESTIONS, ANSWERED SEPARATELY.
//   1. DOES IT MOVE -- run-length distribution of saturated episodes, and how much of the series is
//      spent in each state. A state that never persists is a spike; one that persists is a regime.
//   2. BOUNDARIES -- the split between the upper rail (+110) and the lower rail (-10), and whether
//      the two are symmetric. #147 found q5/q6 are asymmetric (one pinned high, one pinned low), so
//      asymmetry here would not be surprising and must be measured, not assumed.
//   3. PREDICTIVE CAPACITY -- four distinct events, because they are NOT the same question:
//        enter_upper / enter_lower  -- the bar saturation begins
//        exit_upper  / exit_lower   -- the bar it ends (the #147 "rarity gate" shape: the
//                                     informative moment is the DEPARTURE from a saturated state,
//                                     not the state itself)
//      plus the in-state contrast (saturated vs not) for completeness.
//
// **The 26% figure from #159 was measured at EVENT bars only. This measures ALL bars, so the base
// rate here is the correct one and is expected to differ. Both are reported.**
//
// available_at: entering and exiting saturation are both knowable at the bar they occur -- no
// two-sided window, so unlike #158's tip sharpness there is no lookahead trap here.
//
// Null: circular shift of the state/event series against returns, 2,000 shifts, two-sided.

import { loadCandles } from "../../backtest/lib/load-candles.js";
import { computeBoomHunter } from "./calc.js";

const SHIFTS = 2000;
const HORIZONS = [1, 3, 6, 12, 24];
const TFS = ["4h", "1h", "15m"];
const TOL = 1e-9; // q3 and q4 coincide EXACTLY at a fixed point; this is float noise only

function rngf(s) {
  let a = s >>> 0;
  return () => { a |= 0; a = (a + 0x6d2b79f5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
function atr14(c) {
  const tr = c.map((x, i) => (i === 0 ? x.h - x.l : Math.max(x.h - x.l, Math.abs(x.h - c[i - 1].c), Math.abs(x.l - c[i - 1].c))));
  const o = new Array(c.length).fill(NaN);
  if (c.length < 14) return o;
  let a = tr.slice(0, 14).reduce((s, v) => s + v, 0) / 14;
  o[13] = a;
  for (let i = 14; i < c.length; i++) { a = (a * 13 + tr[i]) / 14; o[i] = a; }
  return o;
}
const q = (xs, p) => { const s = [...xs].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor(p * s.length))]; };

function shiftTest(idxs, ret, n, seed) {
  // contrast: mean return at these bars vs mean return at all other valid bars
  let sa = 0, na = 0, sb = 0, nb = 0;
  const mark = new Uint8Array(n);
  for (const i of idxs) mark[i] = 1;
  for (let i = 0; i < n; i++) { const r = ret[i]; if (!Number.isFinite(r)) continue; if (mark[i]) { sa += r; na++; } else { sb += r; nb++; } }
  if (!na || !nb) return null;
  const obs = sa / na - sb / nb;
  const rng = rngf(seed);
  let ge = 0;
  for (let k = 0; k < SHIFTS; k++) {
    const off = 1 + Math.floor(rng() * (n - 2));
    let s1 = 0, n1 = 0, s2 = 0, n2 = 0;
    for (let i = 0; i < n; i++) { const r = ret[i]; if (!Number.isFinite(r)) continue; if (mark[(i + off) % n]) { s1 += r; n1++; } else { s2 += r; n2++; } }
    if (n1 && n2 && Math.abs(s1 / n1 - s2 / n2) >= Math.abs(obs)) ge++;
  }
  return { obs, mean: sa / na, base: sb / nb, n: na, p: ge / SHIFTS };
}

async function main() {
  console.log("EOT2 SATURATION (q3 == q4, exact Mobius fixed point) -- does it move, bound, predict?");
  console.log("Measured on ALL bars. #159's 26% was measured at EVENT bars only, so it differs by design.\n");

  for (const inst of ["BTC", "ETH"]) {
    for (const tf of TFS) {
      const c = await loadCandles(tf, inst);
      const atr = atr14(c);
      const n = c.length;
      const { series } = computeBoomHunter(c);
      const { q3, q4 } = series;

      // state: 0 = free, +1 = upper rail, -1 = lower rail
      const st = new Int8Array(n);
      for (let i = 0; i < n; i++) {
        if (!Number.isFinite(q3[i]) || !Number.isFinite(q4[i])) continue;
        if (Math.abs(q3[i] - q4[i]) > TOL) continue;
        st[i] = q3[i] > 50 ? 1 : -1;
      }
      const up = [...st].filter((v) => v === 1).length;
      const dn = [...st].filter((v) => v === -1).length;

      // run lengths
      const runs = { 1: [], "-1": [] };
      let cur = 0, len = 0;
      for (let i = 0; i < n; i++) {
        if (st[i] === cur) { if (cur !== 0) len++; continue; }
        if (cur !== 0 && len > 0) runs[cur].push(len);
        cur = st[i]; len = cur !== 0 ? 1 : 0;
      }
      if (cur !== 0 && len > 0) runs[cur].push(len);

      console.log(`===== ${inst} ${tf} -- ${n.toLocaleString()} bars`);
      console.log(`  saturated ${(((up + dn) / n) * 100).toFixed(2)}%   upper +110: ${((up / n) * 100).toFixed(2)}%   lower -10: ${((dn / n) * 100).toFixed(2)}%   ratio up:dn = ${(up / Math.max(1, dn)).toFixed(2)}`);
      for (const k of ["1", "-1"]) {
        const r = runs[k];
        if (!r.length) continue;
        console.log(`  ${k === "1" ? "upper" : "lower"} runs: ${r.length.toLocaleString()} episodes  mean ${(r.reduce((a, b) => a + b, 0) / r.length).toFixed(2)} bars  median ${q(r, 0.5)}  p90 ${q(r, 0.9)}  max ${Math.max(...r)}`);
      }

      // events
      const ev = { enter_upper: [], enter_lower: [], exit_upper: [], exit_lower: [] };
      for (let i = 1; i < n; i++) {
        if (st[i] === 1 && st[i - 1] !== 1) ev.enter_upper.push(i);
        if (st[i] === -1 && st[i - 1] !== -1) ev.enter_lower.push(i);
        if (st[i] !== 1 && st[i - 1] === 1) ev.exit_upper.push(i);
        if (st[i] !== -1 && st[i - 1] === -1) ev.exit_lower.push(i);
      }
      console.log("     event          H       n      mean(ATR)     base       excess       p");
      for (const [name, idxs] of Object.entries(ev)) {
        if (idxs.length < 60) { console.log(`     ${name.padEnd(13)} only ${idxs.length} events, skipped`); continue; }
        for (const H of HORIZONS) {
          const ret = new Array(n).fill(NaN);
          for (let i = 0; i < n - H; i++) { const a = atr[i]; if (Number.isFinite(a) && a > 0) ret[i] = (c[i + H].c - c[i].c) / a; }
          const r = shiftTest(idxs, ret, n, 2468 + H);
          if (!r) continue;
          console.log(
            `     ${name.padEnd(13)}${String(H).padStart(3)}${String(r.n).padStart(8)}${r.mean.toFixed(4).padStart(13)}${r.base.toFixed(4).padStart(11)}${r.obs.toFixed(4).padStart(12)}${r.p.toFixed(4).padStart(9)}${r.p < 0.05 ? " *" : ""}`,
          );
        }
      }
      console.log("");
    }
  }
}

main().catch((e) => { console.error("Fatal:", e); process.exit(1); });
