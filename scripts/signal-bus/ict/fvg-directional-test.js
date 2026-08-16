#!/usr/bin/env node
// Does a bullish FVG below price carry DIRECTIONAL predictive value, and what is the optimal read?
//
// Motivated by a live chart observation (2026-08-16): on BITUNIX:BTCUSDT.P 4h, price at 63,110.6
// sitting 41.8 above the top of a green (bullish) FVG spanning 63,045.1-63,068.8. The practitioner
// claim is that a bullish FVG below price is support and that price resting on it is bullish. That
// is a testable claim and it has never been tested in this project.
//
// PRIOR. #126's C-1 finding says domain 1 (price-derived structure) is saturated, so a NEW
// price-derived feature should be expected to add little. FVGs are as domain-1 as it gets. The
// test is still worth running because the claim is specific and directional, but a null result is
// the expected outcome and must not be talked around.
//
// DESIGN. For every bar, locate the NEAREST ACTIVE bullish FVG below the close and classify the
// bar's position relative to it, in ATR(14) units so the classification is scale-free across a
// nine-year sample spanning ~$200 to ~$100k:
//
//   on_top   0 <= (close - top) < 0.5 ATR   -- the live configuration being asked about
//   near     0.5 <= gap < 2.0 ATR
//   far      gap >= 2.0 ATR
//   inside   bottom <= close <= top         -- price trading INTO the gap
//
// The mirror is computed for bearish FVGs above price. Running BOTH sides is the whole point: crypto
// rose across this sample, so a bullish-only result is drift, not signal. A real effect must show up
// as bullish-supportive AND bearish-resistive.
//
// OUTCOME. Forward return from the classifying bar's close over H bars, expressed in ATR units so
// horizons and regimes are comparable. Reported as mean ATR-return and P(up).
//
// NULL. Circular shift of the STATE series against the return series, 2,000 shifts. This preserves
// the autocorrelation of both the states (FVGs persist for many bars) and the returns, which an
// i.i.d. permutation would destroy -- the same reasoning as every other null in this register.
// A two-sided p is reported, since a bullish FVG predicting DOWN would be just as informative.

import { DatabaseSync } from "node:sqlite";
import { loadCandles } from "../../backtest/lib/load-candles.js";
import { dbSuffix } from "../lib/instrument.js";

const SHIFTS = 2000;
const HORIZONS = [1, 3, 6, 12, 24];
const TFS = ["1d", "4h", "1h", "15m"];
const INSTRUMENTS = ["BTC", "ETH"];

function rngf(s) {
  let a = s >>> 0;
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
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

// State code per bar for one side. 0 = no qualifying zone (excluded), 1 on_top, 2 near, 3 far, 4 inside.
function classify(candles, atr, zones, side) {
  const n = candles.length;
  const state = new Int8Array(n);
  // Bucket zones by creation bar so the sweep stays linear.
  const openAt = new Map();
  for (const z of zones) {
    if (z.created_bar_idx == null || z.created_bar_idx >= n) continue;
    if (!openAt.has(z.created_bar_idx)) openAt.set(z.created_bar_idx, []);
    openAt.get(z.created_bar_idx).push(z);
  }
  let active = [];
  for (let i = 0; i < n; i++) {
    const add = openAt.get(i);
    if (add) active.push(...add);
    // A zone stops being a reference once it is broken.
    if (active.length) active = active.filter((z) => z.broken_bar_idx == null || z.broken_bar_idx > i);
    const a = atr[i];
    if (!Number.isFinite(a) || a <= 0 || !active.length) { state[i] = 0; continue; }
    const px = candles[i].c;

    // bullish: nearest zone BELOW price (highest top <= px). bearish: nearest ABOVE (lowest bottom >= px).
    let best = null;
    for (const z of active) {
      if (side === "bullish") {
        if (z.top <= px) { if (!best || z.top > best.top) best = z; }
        else if (z.bottom <= px && px <= z.top) { best = z; break; }
      } else {
        if (z.bottom >= px) { if (!best || z.bottom < best.bottom) best = z; }
        else if (z.bottom <= px && px <= z.top) { best = z; break; }
      }
    }
    if (!best) { state[i] = 0; continue; }
    if (px >= best.bottom && px <= best.top) { state[i] = 4; continue; }
    const gap = side === "bullish" ? (px - best.top) / a : (best.bottom - px) / a;
    state[i] = gap < 0.5 ? 1 : gap < 2.0 ? 2 : 3;
  }
  return state;
}

const LABEL = { 1: "on_top", 2: "near", 3: "far", 4: "inside" };

function meanBy(state, ret, code) {
  let s = 0, n = 0, up = 0;
  for (let i = 0; i < state.length; i++) {
    if (state[i] !== code) continue;
    const r = ret[i];
    if (!Number.isFinite(r)) continue;
    s += r; n++; if (r > 0) up++;
  }
  return { mean: n ? s / n : NaN, n, pUp: n ? up / n : NaN };
}

async function main() {
  console.log("FVG DIRECTIONAL VALUE -- is a bullish FVG below price actually supportive?");
  console.log(`Forward return in ATR(14) units. Null: circular shift of state vs return, ${SHIFTS} shifts, two-sided.`);
  console.log("Bearish mirror computed throughout: a bullish-only result is drift, not signal.\n");

  for (const inst of INSTRUMENTS) {
    const db = new DatabaseSync(new URL(`../../../data/signal-bus/ict${dbSuffix(inst)}.db`, import.meta.url), { readOnly: true });
    for (const tf of TFS) {
      const candles = await loadCandles(tf, inst);
      const atr = atr14(candles);
      const n = candles.length;

      const rows = db.prepare(
        `SELECT side, top, bottom, created_bar_idx, broken_bar_idx FROM fvg_zones WHERE timeframe = ? AND instrument = ?`,
      ).all(tf, inst);
      if (!rows.length) { console.log(`${inst} ${tf}: no fvg_zones rows\n`); continue; }

      const bull = rows.filter((r) => r.side === "bullish");
      const bear = rows.filter((r) => r.side === "bearish");
      console.log(`===== ${inst} ${tf} -- ${n.toLocaleString()} bars, ${bull.length.toLocaleString()} bullish / ${bear.length.toLocaleString()} bearish FVGs`);

      for (const [side, zones] of [["bullish", bull], ["bearish", bear]]) {
        if (!zones.length) continue;
        const state = classify(candles, atr, zones, side);
        // Unconditional reference over the same bars that carry ANY state.
        console.log(`  ${side} FVG ${side === "bullish" ? "below" : "above"} price` +
          `  (a supportive/resistive read predicts ${side === "bullish" ? "POSITIVE" : "NEGATIVE"} forward return)`);
        console.log("    H   state      n        mean fwd(ATR)   uncond    excess     P(up)    p(2-sided)");

        for (const H of HORIZONS) {
          const ret = new Array(n).fill(NaN);
          for (let i = 0; i < n - H; i++) {
            const a = atr[i];
            if (Number.isFinite(a) && a > 0) ret[i] = (candles[i + H].c - candles[i].c) / a;
          }
          let us = 0, un = 0;
          for (let i = 0; i < n; i++) if (state[i] !== 0 && Number.isFinite(ret[i])) { us += ret[i]; un++; }
          const uncond = un ? us / un : NaN;

          for (const code of [1, 4]) { // on_top (the live case) and inside
            const obs = meanBy(state, ret, code);
            if (obs.n < 30) { console.log(`    ${String(H).padStart(2)}  ${LABEL[code].padEnd(8)}${String(obs.n).padStart(7)}   (n<30, skipped)`); continue; }
            const rng = rngf(1234 + H + code);
            let ge = 0;
            const obsDev = Math.abs(obs.mean - uncond);
            for (let k = 0; k < SHIFTS; k++) {
              const off = 1 + Math.floor(rng() * (n - 2));
              let s2 = 0, n2 = 0;
              for (let i = 0; i < n; i++) {
                if (state[(i + off) % n] !== code) continue;
                const r = ret[i];
                if (!Number.isFinite(r)) continue;
                s2 += r; n2++;
              }
              if (n2 && Math.abs(s2 / n2 - uncond) >= obsDev) ge++;
            }
            const p = ge / SHIFTS;
            console.log(
              `    ${String(H).padStart(2)}  ${LABEL[code].padEnd(8)}${String(obs.n).padStart(7)}` +
              `${obs.mean.toFixed(4).padStart(15)}${uncond.toFixed(4).padStart(10)}` +
              `${(obs.mean - uncond).toFixed(4).padStart(10)}${(obs.pUp * 100).toFixed(1).padStart(9)}%` +
              `${p.toFixed(4).padStart(11)}${p < 0.05 ? " *" : ""}`,
            );
          }
        }
        console.log("");
      }
    }
    db.close();
  }
}

main().catch((e) => { console.error("Fatal:", e); process.exit(1); });
