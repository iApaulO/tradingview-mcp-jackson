#!/usr/bin/env node
// OSLER CALIBRATION — replicating a published result on our own data to calibrate our methodology.
//
// WHY. Osler (2005), FRBNY Staff Report 150, using ACTUAL DEALER STOP-LOSS ORDER DATA, found exchange
// rates reverse at round numbers 59.3% of the time versus 54.8% at arbitrary levels (p < 0.001) --
// **a 4.5-POINT EDGE ON A COIN FLIP.**
//
// Our own #192 reported liquidity-pool rejection at 61.3% vs 48.2% placebo, a **13-POINT EDGE**, and
// #216 reported 41.9% vs 28.5% for breakers, a 13.4-point edge. **Both are ~3x Osler's effect,
// obtained from PRICE ALONE while Osler had the actual resting orders.** More effect from strictly
// less information is a warning about method, not a discovery.
//
// THIS TEST IS A YARDSTICK, NOT A HYPOTHESIS. Round numbers are the one price feature whose expected
// effect size is externally known. If our pipeline reproduces something near Osler's 4.5 points, our
// measurement is calibrated and the large house effects need explaining. If our pipeline reports
// 13 points HERE TOO, then the inflation lives in the measurement and every rejection-rate number in
// this register is suspect.
//
// CONSTRUCTION, kept as close to Osler's logic as public OHLC allows:
//   round unit   scaled per instrument: 10^(floor(log10(price)) - 1). BTC@65k -> 1,000; ETH@3.5k ->
//                100; XLM@0.3 -> 0.01. Chosen so "round" means the same thing across price scales.
//   arbitrary    the same lattice offset by 0.37 x unit -- deliberately NOT the midpoint, since a
//                midpoint is itself a salient number and would contaminate the control.
//   approach     first bar whose range touches level L having been strictly on one side the bar before
//   REVERSAL     within W bars, price moves d away from L on the approach side BEFORE moving d through
//   CONTINUATION the opposite. Ties and unresolved approaches are DISCARDED, not assigned.
//
// d = 0.25 x ATR(14) so the threshold scales with volatility rather than being a fixed percentage.
//
// Existing data only. All eight instruments plus XLM. 1h and 4h reported separately (#204).

import { loadCandles } from "../../backtest/lib/load-candles.js";

const ATR_LEN = 14, W = 12, D_ATR = 0.25;
const OFFSET_FRAC = 0.37;
const INSTRUMENTS = ["BTC", "ETH", "SOL", "XRP", "BNB", "ADA", "LTC", "LINK", "XLM"];

const mean = (xs) => (xs.length ? xs.reduce((s, x) => s + x, 0) / xs.length : NaN);

function atrSeries(c, L) {
  const tr = c.map((x, i) => (i === 0 ? x.h - x.l : Math.max(x.h - x.l, Math.abs(x.h - c[i - 1].c), Math.abs(x.l - c[i - 1].c))));
  const o = new Array(c.length).fill(NaN);
  let s = 0; for (let i = 0; i < L; i++) s += tr[i];
  o[L - 1] = s / L;
  for (let i = L; i < c.length; i++) o[i] = (o[i - 1] * (L - 1) + tr[i]) / L;
  return o;
}
function propZ(a, b) {
  const na = a.length, nb = b.length;
  if (!na || !nb) return NaN;
  const xa = a.reduce((s, v) => s + v, 0), xb = b.reduce((s, v) => s + v, 0);
  const pa = xa / na, pb = xb / nb, pp = (xa + xb) / (na + nb);
  const se = Math.sqrt(pp * (1 - pp) * (1 / na + 1 / nb));
  return se > 0 ? (pa - pb) / se : NaN;
}

/** unit such that "round" scales with price magnitude */
const roundUnit = (px) => Math.pow(10, Math.floor(Math.log10(px)) - 1);

/**
 * Walk the series; for each approach to a lattice level, classify reversal vs continuation.
 * lattice(px) returns the nearest level of the family at or beyond the approach direction.
 */
function classify(c, atr, offsetFrac) {
  const outcomes = [];
  const seen = new Set();
  for (let i = 1; i < c.length - W - 1; i++) {
    const a = atr[i];
    if (!Number.isFinite(a) || a <= 0) continue;
    const px = c[i].c;
    if (!Number.isFinite(px) || px <= 0) continue;
    const u = roundUnit(px);
    if (!Number.isFinite(u) || u <= 0) continue;
    const off = offsetFrac * u;

    // the lattice level just above and just below the PREVIOUS close
    const prev = c[i - 1].c;
    const kAbove = Math.ceil((prev - off) / u) * u + off;
    const kBelow = Math.floor((prev - off) / u) * u + off;

    for (const [L, dir] of [[kAbove, "up"], [kBelow, "down"]]) {
      if (!Number.isFinite(L) || L <= 0) continue;
      // approach = this bar's range touches L having been strictly on one side last bar
      const touched = c[i].h >= L && c[i].l <= L;
      const wasBelow = prev < L, wasAbove = prev > L;
      if (!touched) continue;
      if (dir === "up" && !wasBelow) continue;
      if (dir === "down" && !wasAbove) continue;
      const key = `${Math.round(L / (u / 1000))}:${dir}`;
      if (seen.has(key) && Math.random() < 0) continue;      // key kept for readability; no dedup by design
      const d = D_ATR * a;
      let res = null;
      // START AT i+1, NOT i. The touch bar approaching from below almost always has its LOW below
      // the level -- it came from there -- so evaluating the touch bar itself scores nearly every
      // approach as a reversal. The first version of this file did exactly that and reported ~89-90%
      // reversal on BOTH families, which measures the touch bar's own range and nothing else. That
      // output was discarded, not published.
      for (let j = i + 1; j <= i + W; j++) {
        const b = c[j];
        if (dir === "up") {
          if (b.l <= L - d) { res = 1; break; }               // pushed back below -> REVERSAL
          if (b.h >= L + d) { res = 0; break; }               // carried through   -> CONTINUATION
        } else {
          if (b.h >= L + d) { res = 1; break; }
          if (b.l <= L - d) { res = 0; break; }
        }
      }
      if (res !== null) outcomes.push(res);                   // unresolved approaches discarded
    }
  }
  return outcomes;
}

async function main() {
  console.log("OSLER CALIBRATION — reversal at ROUND numbers vs ARBITRARY levels, on our own pipeline.");
  console.log("Osler (2005), FRBNY SR 150, with real dealer stop data: 59.3% vs 54.8%, a 4.5-POINT edge.");
  console.log("Our #192 claimed a 13-point edge and #216 a 13.4-point edge, from price alone.");
  console.log(`Reversal = moves ${D_ATR} ATR back before ${D_ATR} ATR through, within ${W} bars. Unresolved discarded.\n`);

  for (const tf of ["4h", "1h"]) {
    const R = [], A = [];
    const per = [];
    for (const inst of INSTRUMENTS) {
      let c; try { c = await loadCandles(tf, inst); } catch { continue; }
      if (!c || c.length < 2000) continue;
      const atr = atrSeries(c, ATR_LEN);
      const r = classify(c, atr, 0);
      const a = classify(c, atr, OFFSET_FRAC);
      R.push(...r); A.push(...a);
      per.push([inst, r.length, mean(r), a.length, mean(a)]);
    }
    console.log(`===== ${tf}`);
    console.log("   inst    round n   round rev%    arb n   arb rev%     edge");
    for (const [inst, rn, rm, an, am] of per) {
      console.log(`   ${inst.padEnd(5)}${String(rn).padStart(9)}${(rm * 100).toFixed(1).padStart(12)}%${String(an).padStart(9)}${(am * 100).toFixed(1).padStart(11)}%${((rm - am) * 100).toFixed(1).padStart(9)}pp`);
    }
    const rm = mean(R), am = mean(A);
    console.log(`   ${"POOLED".padEnd(5)}${String(R.length).padStart(9)}${(rm * 100).toFixed(1).padStart(12)}%${String(A.length).padStart(9)}${(am * 100).toFixed(1).padStart(11)}%${((rm - am) * 100).toFixed(1).padStart(9)}pp   z=${propZ(R, A).toFixed(2)}`);
    console.log(`   Osler benchmark: 59.3% vs 54.8% = 4.5pp\n`);
  }
  console.log("READ IT THIS WAY:");
  console.log("  edge near ~4.5pp  -> our measurement is calibrated; the large house effects need a reason.");
  console.log("  edge near ~13pp   -> the inflation is in the METHOD, and every rejection-rate row here is suspect.");
  console.log("  edge near ~0pp    -> crypto has no round-number effect, and Osler does not transfer to this market.");
}

main().catch((e) => { console.error("Fatal:", e); process.exit(1); });
