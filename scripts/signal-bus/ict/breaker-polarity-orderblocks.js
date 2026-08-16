#!/usr/bin/env node
// BREAKER POLARITY, ORDER BLOCK EDITION -- the direct test of iapaulo's chart observation.
//
// Companion to breaker-polarity-test.js, which runs the same 2x2 on FVGs. This one is the direct
// match to what was actually being looked at: a BLUE box on the daily ICT chart, identified in #152
// as a bullish order block from 8/9 Mar drawn in `bullBrkCss` (#4785f9), i.e. already broken.
// Confirmed against SMC's own record: bullish OB, origin 2026-03-08, mitigated 2026-03-27.
//
// The convention was verified against sources rather than asserted from memory (house rule): a
// breaker block is a FAILED order block that flips polarity -- a bullish OB that price breaks
// through becomes bearish resistance, and vice versa. The standard rationale is that institutions
// used the return to the OB to exit rather than enter, then drove price through it.
//
// SO THE CLAIM IS A REQUIRED SIGN FLIP, not a vague "it changes character":
//
//                      approached from    predicts
//   bullish, ACTIVE    above (support)    positive
//   bullish, BROKEN    below (resistance) NEGATIVE   <- the breaker claim
//   bearish, ACTIVE    below (resistance) negative
//   bearish, BROKEN    above (support)    POSITIVE   <- the breaker claim
//
// Confirmed only if the BROKEN rows carry the OPPOSITE sign to the ACTIVE rows, on both sides and
// both instruments. A broken OB that keeps its original polarity, or does nothing, refutes it.
//
// SCOPE. Restricted to 4h and 1h to keep this cheap; the FVG companion covers 15m. Both `swing` and
// `internal` scopes are reported separately, because they are different objects -- swing OBs are the
// structurally significant ones and pooling them would let the far more numerous internal blocks
// dominate any average.
//
// Zone bounds are `bar_high`/`bar_low`; the break bar is `mitigated_bar_idx`.

import { DatabaseSync } from "node:sqlite";
import { loadCandles } from "../../backtest/lib/load-candles.js";
import { dbSuffix } from "../lib/instrument.js";

const SHIFTS = 2000;
const HORIZONS = [1, 3, 6, 12];
const TFS = ["4h", "1h"];
const BAND = 0.5;

function rngf(s) {
  let a = s >>> 0;
  return () => { a |= 0; a = (a + 0x6d2b79f5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
function atr14(c) {
  const tr = c.map((x, i) => (i === 0 ? x.h - x.l : Math.max(x.h - x.l, Math.abs(x.h - c[i - 1].c), Math.abs(x.l - c[i - 1].c))));
  const out = new Array(c.length).fill(NaN);
  if (c.length < 14) return out;
  let a = tr.slice(0, 14).reduce((s, v) => s + v, 0) / 14;
  out[13] = a;
  for (let i = 14; i < c.length; i++) { a = (a * 13 + tr[i]) / 14; out[i] = a; }
  return out;
}

function classify(candles, atr, zones, side, phase) {
  const n = candles.length;
  const st = new Int8Array(n);
  const byStart = new Map();
  for (const z of zones) {
    const start = phase === "broken" ? z.mitigated_bar_idx : z.created_bar_idx;
    if (start == null || start >= n) continue;
    if (!byStart.has(start)) byStart.set(start, []);
    byStart.get(start).push(z);
  }
  let live = [];
  for (let i = 0; i < n; i++) {
    const add = byStart.get(i);
    if (add) live.push(...add);
    if (phase === "active" && live.length) live = live.filter((z) => z.mitigated_bar_idx == null || z.mitigated_bar_idx > i);
    const a = atr[i];
    if (!Number.isFinite(a) || a <= 0 || !live.length) continue;
    const px = candles[i].c;
    for (const z of live) {
      let d;
      if (phase === "active") d = side === "bullish" ? (px - z.bar_high) / a : (z.bar_low - px) / a;
      else d = side === "bullish" ? (z.bar_low - px) / a : (px - z.bar_high) / a;
      if (d >= 0 && d < BAND) { st[i] = 1; break; }
    }
  }
  return st;
}

async function main() {
  console.log("BREAKER POLARITY -- ORDER BLOCKS. Does a broken OB flip to the opposite role?");
  console.log("Confirmed ONLY if BROKEN rows carry the OPPOSITE sign to ACTIVE rows.");
  console.log(`Forward return in ATR(14). Circular-shift null, ${SHIFTS} shifts, two-sided.\n`);

  for (const inst of ["BTC", "ETH"]) {
    const db = new DatabaseSync(new URL(`../../../data/signal-bus/smc${dbSuffix(inst)}.db`, import.meta.url), { readOnly: true });
    for (const tf of TFS) {
      const candles = await loadCandles(tf, inst);
      const atr = atr14(candles);
      const n = candles.length;
      for (const scope of ["swing", "internal"]) {
        const rows = db.prepare(
          `SELECT side, bar_high, bar_low, created_bar_idx, mitigated_bar_idx FROM order_blocks WHERE timeframe = ? AND instrument = ? AND scope = ?`,
        ).all(tf, inst, scope);
        if (!rows.length) continue;
        const nb = rows.filter((r) => r.mitigated_bar_idx != null).length;
        console.log(`===== ${inst} ${tf} ${scope} -- ${rows.length.toLocaleString()} OBs, ${nb.toLocaleString()} broken`);
        console.log("   side     phase    H      n      mean fwd(ATR)   uncond    excess      p     predicted");
        for (const side of ["bullish", "bearish"]) {
          const zAll = rows.filter((r) => r.side === side);
          for (const phase of ["active", "broken"]) {
            const zs = phase === "broken" ? zAll.filter((z) => z.mitigated_bar_idx != null) : zAll;
            if (!zs.length) continue;
            const st = classify(candles, atr, zs, side, phase);
            const pred = phase === "active" ? (side === "bullish" ? "+" : "-") : (side === "bullish" ? "-" : "+");
            for (const H of HORIZONS) {
              const ret = new Array(n).fill(NaN);
              for (let i = 0; i < n - H; i++) { const a = atr[i]; if (Number.isFinite(a) && a > 0) ret[i] = (candles[i + H].c - candles[i].c) / a; }
              let us = 0, un = 0;
              for (let i = 0; i < n; i++) if (Number.isFinite(ret[i])) { us += ret[i]; un++; }
              const uncond = un ? us / un : NaN;
              let s = 0, cnt = 0;
              for (let i = 0; i < n; i++) if (st[i] === 1 && Number.isFinite(ret[i])) { s += ret[i]; cnt++; }
              if (cnt < 30) { console.log(`   ${side.padEnd(9)}${phase.padEnd(9)}${String(H).padStart(2)}${String(cnt).padStart(8)}   (n<30)`); continue; }
              const obs = s / cnt, dev = Math.abs(obs - uncond);
              const rng = rngf(4242 + H);
              let ge = 0;
              for (let k = 0; k < SHIFTS; k++) {
                const off = 1 + Math.floor(rng() * (n - 2));
                let s2 = 0, n2 = 0;
                for (let i = 0; i < n; i++) { if (st[(i + off) % n] !== 1) continue; const r = ret[i]; if (!Number.isFinite(r)) continue; s2 += r; n2++; }
                if (n2 && Math.abs(s2 / n2 - uncond) >= dev) ge++;
              }
              const p = ge / SHIFTS;
              const got = obs - uncond >= 0 ? "+" : "-";
              console.log(
                `   ${side.padEnd(9)}${phase.padEnd(9)}${String(H).padStart(2)}${String(cnt).padStart(8)}` +
                `${obs.toFixed(4).padStart(15)}${uncond.toFixed(4).padStart(10)}${(obs - uncond).toFixed(4).padStart(10)}` +
                `${p.toFixed(4).padStart(9)}${p < 0.05 ? "*" : " "}   want ${pred} got ${got}${p < 0.05 && got === pred ? "  <== MATCH" : ""}`,
              );
            }
          }
        }
        console.log("");
      }
    }
    db.close();
  }
}

main().catch((e) => { console.error("Fatal:", e); process.exit(1); });
