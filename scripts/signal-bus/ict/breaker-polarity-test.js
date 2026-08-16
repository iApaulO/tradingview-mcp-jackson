#!/usr/bin/env node
// DOES A BROKEN ZONE INVERT POLARITY? -- the breaker block claim, tested.
//
// iapaulo, from the chart: "once the liquidity zone is broken it becomes more the opposite of what
// it was, so it has a dynamic quality to it." That is the practitioner definition of a BREAKER
// BLOCK, arrived at independently, and it is a specific falsifiable claim rather than a vibe.
//
// WHY THIS IS NOT ALREADY ANSWERED BY #149. #149 tested FVG position states but filtered zones with
// `broken_bar_idx == null || broken_bar_idx > i` -- every zone left the sample the instant it broke.
// **The post-break state was excluded by construction, so #149 says nothing about it.** This is a
// genuine gap in that row and this test fills it rather than re-reading it.
//
// THE CLAIM, AS A 2x2 WITH A REQUIRED SIGN FLIP:
//
//                      approached from   inversion predicts   #149 found (unbroken)
//   bullish, ACTIVE    above (support)   positive             positive  (+0.0159, p=0.0000)
//   bullish, BROKEN    below (resist.)   NEGATIVE             not tested
//   bearish, ACTIVE    below (resist.)   negative             negative  (-0.0166, p=0.0000)
//   bearish, BROKEN    above (support)   POSITIVE             not tested
//
// The claim is confirmed only if the BROKEN rows carry the OPPOSITE sign to the ACTIVE rows. A
// broken zone that keeps behaving like its original polarity, or behaves like nothing at all,
// refutes it. Running both sides is mandatory for the same reason as #149: crypto rose across this
// sample, so a one-sided result is drift.
//
// A BROKEN ZONE IS APPROACHED FROM THE OTHER SIDE -- that is the whole point. A bullish zone breaks
// when price falls through it, so the retest necessarily comes from BELOW, and the geometry of the
// test state is the mirror of the active case, not a repeat of it.
//
// Null: circular shift of the state series against the return series, 2,000 shifts, two-sided --
// preserving the autocorrelation of both, as everywhere else in this register.

import { DatabaseSync } from "node:sqlite";
import { loadCandles } from "../../backtest/lib/load-candles.js";
import { dbSuffix } from "../lib/instrument.js";

const SHIFTS = 2000;
const HORIZONS = [1, 3, 6, 12];
const TFS = ["4h", "1h", "15m"];
const BAND = 0.5; // ATR units: "at" the zone edge

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

// state 1 = price at the retest edge of a zone in the given phase; 0 = not applicable.
// phase 'active': bullish tested from ABOVE, bearish tested from BELOW (the #149 geometry).
// phase 'broken': bullish tested from BELOW, bearish tested from ABOVE (the inverted geometry).
function classify(candles, atr, zones, side, phase) {
  const n = candles.length;
  const st = new Int8Array(n);
  const byCreate = new Map();
  for (const z of zones) {
    const start = phase === "broken" ? z.broken_bar_idx : z.created_bar_idx;
    if (start == null || start >= n) continue;
    if (!byCreate.has(start)) byCreate.set(start, []);
    byCreate.get(start).push(z);
  }
  let live = [];
  for (let i = 0; i < n; i++) {
    const add = byCreate.get(i);
    if (add) live.push(...add);
    if (phase === "active" && live.length) live = live.filter((z) => z.broken_bar_idx == null || z.broken_bar_idx > i);
    const a = atr[i];
    if (!Number.isFinite(a) || a <= 0 || !live.length) continue;
    const px = candles[i].c;
    for (const z of live) {
      let d;
      if (phase === "active") d = side === "bullish" ? (px - z.top) / a : (z.bottom - px) / a;
      else d = side === "bullish" ? (z.bottom - px) / a : (px - z.top) / a;
      if (d >= 0 && d < BAND) { st[i] = 1; break; }
    }
  }
  return st;
}

async function main() {
  console.log("BREAKER POLARITY -- does a broken zone invert?");
  console.log("Confirmed ONLY if the BROKEN rows carry the OPPOSITE sign to the ACTIVE rows.");
  console.log(`Forward return in ATR(14) units. Circular-shift null, ${SHIFTS} shifts, two-sided.\n`);

  for (const inst of ["BTC", "ETH"]) {
    const db = new DatabaseSync(new URL(`../../../data/signal-bus/ict${dbSuffix(inst)}.db`, import.meta.url), { readOnly: true });
    for (const tf of TFS) {
      const candles = await loadCandles(tf, inst);
      const atr = atr14(candles);
      const n = candles.length;
      const rows = db.prepare(`SELECT side, top, bottom, created_bar_idx, broken_bar_idx FROM fvg_zones WHERE timeframe = ? AND instrument = ?`).all(tf, inst);
      if (!rows.length) continue;

      const nBrokeBull = rows.filter((r) => r.side === "bullish" && r.broken_bar_idx != null).length;
      const nBrokeBear = rows.filter((r) => r.side === "bearish" && r.broken_bar_idx != null).length;
      console.log(`===== ${inst} ${tf} -- ${n.toLocaleString()} bars | broken zones: ${nBrokeBull.toLocaleString()} bull, ${nBrokeBear.toLocaleString()} bear`);
      console.log("   side     phase    H      n      mean fwd(ATR)   uncond    excess      p     predicted");

      for (const side of ["bullish", "bearish"]) {
        const zones = rows.filter((r) => r.side === side);
        for (const phase of ["active", "broken"]) {
          const zs = phase === "broken" ? zones.filter((z) => z.broken_bar_idx != null) : zones;
          if (!zs.length) continue;
          const st = classify(candles, atr, zs, side, phase);
          // sign the claim predicts for this cell
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
            const rng = rngf(777 + H);
            let ge = 0;
            for (let k = 0; k < SHIFTS; k++) {
              const off = 1 + Math.floor(rng() * (n - 2));
              let s2 = 0, n2 = 0;
              for (let i = 0; i < n; i++) { if (st[(i + off) % n] !== 1) continue; const r = ret[i]; if (!Number.isFinite(r)) continue; s2 += r; n2++; }
              if (n2 && Math.abs(s2 / n2 - uncond) >= dev) ge++;
            }
            const p = ge / SHIFTS;
            const gotSign = obs - uncond >= 0 ? "+" : "-";
            console.log(
              `   ${side.padEnd(9)}${phase.padEnd(9)}${String(H).padStart(2)}${String(cnt).padStart(8)}` +
              `${obs.toFixed(4).padStart(15)}${uncond.toFixed(4).padStart(10)}${(obs - uncond).toFixed(4).padStart(10)}` +
              `${p.toFixed(4).padStart(9)}${p < 0.05 ? "*" : " "}   want ${pred} got ${gotSign}${p < 0.05 && gotSign === pred ? "  <== MATCH" : ""}`,
            );
          }
        }
      }
      console.log("");
    }
    db.close();
  }
}

main().catch((e) => { console.error("Fatal:", e); process.exit(1); });
