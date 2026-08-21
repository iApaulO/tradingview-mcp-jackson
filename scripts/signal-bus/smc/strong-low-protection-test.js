#!/usr/bin/env node
// STRONG-LOW PROTECTION — the highest-value testable claim from the Photon source (#226).
//
// THE CLAIM [13:48-14:03]: a low that CAUSED a break of structure -- price rallied from it and took
// out a prior swing high -- becomes a STRONG low and is "protected", because of the capital required
// to have caused that break. A low that failed to do so is weak and is expected to be taken.
//
// This underpins the entire strong/weak scheme in the source AND LuxAlgo's own Strong/Weak High/Low
// labels, so it is worth settling properly.
//
// **THE CIRCULARITY TRAP, AND HOW THIS AVOIDS IT.** "Weak lows get breached more often" is nearly
// tautological: a low is classified weak partly BY being breached. Two design choices remove it:
//   1. The clock starts at the BOS CONFIRMATION BAR for every arm -- not at the low's formation. A
//      strong low has already survived until the BOS, and giving it that head start for free would
//      manufacture the result.
//   2. The control is DISTANCE-MATCHED. A level 5 ATR below price is breached far less often than one
//      1 ATR below, so an unmatched comparison measures distance, not protection. Each strong low's
//      distance d (in ATR at the BOS bar) is replayed at randomly drawn bars: level = close - d*ATR.
//      That is #210's random-entry logic applied to levels.
//
// ARMS
//   STRONG          low that caused a BOS; clock starts at the BOS bar
//   NON-STRONG      confirmed pivot low, still unbroken, that has NOT caused a BOS; clock starts at a
//                   matched reference bar. Reported for contrast, NOT as the primary control -- it
//                   carries residual circularity by construction.
//   MATCHED RANDOM  same distance d, random bars. THE PRIMARY CONTROL.
//
// Outcome: is the level breached (any bar's low <= level) within W bars of the clock start?
// If the claim is true, STRONG should be breached LESS than the distance-matched random level.
//
// Existing data only. 4h, nine instruments, per-rung (#204).

import { loadCandles } from "../../backtest/lib/load-candles.js";

const ATR_LEN = 14, PIVOT_LEFT = 5, PIVOT_RIGHT = 5;
const W = 100;              // forward horizon, bars
const MAX_WAIT = 300;       // how long a low may wait to cause a BOS before being called non-strong
const SEEDS = 400, MIN_N = 60;
const INSTRUMENTS = ["BTC", "ETH", "SOL", "XRP", "BNB", "ADA", "LTC", "LINK", "XLM"];

const mean = (xs) => (xs.length ? xs.reduce((s, x) => s + x, 0) / xs.length : NaN);
const med = (xs) => { if (!xs.length) return NaN; const a = [...xs].sort((p, q) => p - q); return a[Math.floor(a.length / 2)]; };
function propZ(a, b) {
  const na = a.length, nb = b.length;
  if (!na || !nb) return NaN;
  const xa = a.reduce((s, v) => s + v, 0), xb = b.reduce((s, v) => s + v, 0);
  const pa = xa / na, pb = xb / nb, pp = (xa + xb) / (na + nb);
  const se = Math.sqrt(pp * (1 - pp) * (1 / na + 1 / nb));
  return se > 0 ? (pa - pb) / se : NaN;
}
function mulberry32(a) { return function () { a |= 0; a = (a + 0x6D2B79F5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
function atrSeries(c, L) {
  const tr = c.map((x, i) => (i === 0 ? x.h - x.l : Math.max(x.h - x.l, Math.abs(x.h - c[i - 1].c), Math.abs(x.l - c[i - 1].c))));
  const o = new Array(c.length).fill(NaN);
  let s = 0; for (let i = 0; i < L; i++) s += tr[i];
  o[L - 1] = s / L;
  for (let i = L; i < c.length; i++) o[i] = (o[i - 1] * (L - 1) + tr[i]) / L;
  return o;
}
function pivots(c) {
  const hi = [], lo = [];
  for (let p = PIVOT_LEFT; p < c.length - PIVOT_RIGHT; p++) {
    let isH = true, isL = true;
    for (let k = p - PIVOT_LEFT; k <= p + PIVOT_RIGHT; k++) {
      if (k === p) continue;
      if (c[k].h >= c[p].h) isH = false;
      if (c[k].l <= c[p].l) isL = false;
    }
    if (isH) hi.push({ confirm: p + PIVOT_RIGHT, price: c[p].h });
    if (isL) lo.push({ confirm: p + PIVOT_RIGHT, price: c[p].l });
  }
  return { hi, lo };
}
/** breached = any bar's LOW reaches `level` within `w` bars from `from` */
function breachedWithin(c, from, level, w) {
  const end = Math.min(c.length - 1, from + w);
  for (let j = from; j <= end; j++) if (c[j].l <= level) return 1;
  return end >= from + w ? 0 : null;   // null = ran off the data edge, discarded
}

async function main() {
  console.log("STRONG-LOW PROTECTION — Photon's claim [13:48]: a low that CAUSED a BOS is protected.");
  console.log("Circularity removed two ways: the clock starts at the BOS BAR for every arm, and the");
  console.log("control is DISTANCE-MATCHED (a level 5 ATR away is breached less than one 1 ATR away).");
  console.log(`Breach = any low reaching the level within ${W} bars. 4h, nine instruments.\n`);

  const strong = [], nonStrong = [], rnd0 = [];
  const dists = [];

  for (const inst of INSTRUMENTS) {
    let c; try { c = await loadCandles("4h", inst); } catch { continue; }
    if (!c || c.length < 2000) continue;
    const atr = atrSeries(c, ATR_LEN);
    const { hi, lo } = pivots(c);
    const rnd = mulberry32(51000 + inst.length);

    // pool of eligible random reference bars, reused for the matched control
    const pool = [];
    for (let i = ATR_LEN + 1; i < c.length - W - 1; i++) pool.push(i);

    for (const L of lo) {
      const start = L.confirm + 1;
      if (start >= c.length) continue;

      // the prior swing high standing at the moment this low confirms
      let priorHigh = null;
      for (const H of hi) { if (H.confirm <= L.confirm) priorHigh = H; else break; }
      if (!priorHigh) continue;

      // walk forward: does a BOS-up (close above the prior high) occur BEFORE the low is breached?
      let bosBar = -1, brokeFirst = false;
      const scanEnd = Math.min(c.length - 1, start + MAX_WAIT);
      for (let j = start; j <= scanEnd; j++) {
        if (c[j].l <= L.price) { brokeFirst = true; break; }        // low taken before any BOS
        if (c[j].c > priorHigh.price) { bosBar = j; break; }        // BOS-up confirmed -> STRONG
      }

      if (bosBar > 0) {
        const a = atr[bosBar];
        if (!Number.isFinite(a) || a <= 0) continue;
        const d = (c[bosBar].c - L.price) / a;                       // distance in ATR at the clock start
        if (!Number.isFinite(d) || d <= 0) continue;
        const res = breachedWithin(c, bosBar + 1, L.price, W);
        if (res === null) continue;
        strong.push(res); dists.push(d);

        // MATCHED RANDOM: same distance d, replayed at a random bar
        const ix = pool[Math.floor(rnd() * pool.length)];
        const ar = atr[ix];
        if (Number.isFinite(ar) && ar > 0) {
          const lvl = c[ix].c - d * ar;
          const rr = breachedWithin(c, ix + 1, lvl, W);
          if (rr !== null) rnd0.push(rr);
        }
      } else if (!brokeFirst) {
        // survived the scan window without causing a BOS and without being broken -> NON-STRONG
        const ref = Math.min(c.length - 1, scanEnd);
        const a = atr[ref];
        if (!Number.isFinite(a) || a <= 0) continue;
        const res = breachedWithin(c, ref + 1, L.price, W);
        if (res !== null) nonStrong.push(res);
      }
    }
  }

  const pc = (x) => (mean(x) * 100).toFixed(1);
  console.log(`  distance of strong lows below price at the BOS bar: median ${med(dists).toFixed(2)} ATR\n`);
  console.log(`  STRONG low breached within ${W} bars      n=${String(strong.length).padStart(6)}   ${pc(strong)}%`);
  console.log(`  MATCHED-RANDOM level (same distance)     n=${String(rnd0.length).padStart(6)}   ${pc(rnd0)}%`);
  console.log(`  NON-STRONG pivot low [contrast only]     n=${String(nonStrong.length).padStart(6)}   ${nonStrong.length >= MIN_N ? pc(nonStrong) + "%" : "below n>=" + MIN_N}`);
  console.log("");
  console.log(`  STRONG vs MATCHED-RANDOM : z = ${propZ(strong, rnd0).toFixed(2)}   (negative = strong lows breached LESS, i.e. protected)`);
  if (nonStrong.length >= MIN_N) console.log(`  STRONG vs NON-STRONG     : z = ${propZ(strong, nonStrong).toFixed(2)}   [contrast only -- carries residual circularity]`);
  console.log("\nThe claim holds only if STRONG is breached materially LESS than the distance-matched random level.");
  console.log("Osler's benchmark caps expectations: 4.5 points on a coin flip, with proprietary order data.");
}

main().catch((e) => { console.error("Fatal:", e); process.exit(1); });
