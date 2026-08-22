#!/usr/bin/env node
// THE MOMENTUM CONTROL — is Photon's method structural insight, or a dressed-up momentum filter?
//
// #229 found LTF bearish switches predict a further HTF decline 77.3% of the time versus 52.3% for a
// random bar -- a ~25-point gap. It also named the confound this test exists to settle:
//
//   **An LTF bearish structure break DEFINITIONALLY means price has just made a lower low. It is, by
//   construction, a statement that price has recently been falling.** Short-horizon momentum alone
//   predicts continued falling, so a plain "declined over the last N bars" filter with NO structural
//   content might reproduce most of that gap.
//
// The 25-point size is itself the tell: Osler got 4.5 points WITH proprietary dealer order data
// (#222), and Module 4's standing rule is that a retail-visible proxy claiming more should be treated
// as suspect on its face.
//
// **A FIRST VERSION OF THIS TEST WAS BROKEN AND ITS OUTPUT DISCARDED.** It matched each switch to a
// momentum-equivalent bar that had NO structure break within 3 bars. That exclusion is circular: LTF
// bearish breaks occur precisely WHEN PRICE FALLS, so excluding bars near a switch removes every
// sustained decline and leaves only V-shaped recoveries. The "control" was therefore selected AGAINST
// declining by construction, and duly reported 13.9-32.1% declines-first -- far BELOW #229's 52.3%
// random baseline, which is the tell that it was measuring the exclusion rather than momentum.
//
// THE CORRECTED DESIGN IS SIGNAL vs SIGNAL AT MATCHED FREQUENCY, which cannot be gamed by selection:
// build a PURE MOMENTUM signal -- fire when the MOM_LOOKBACK-bar return is below a threshold chosen so
// it fires the SAME NUMBER OF TIMES as the structure signal on that instrument -- and compare hit
// rates head to head. Both arms are signals; neither is a hand-picked control bar.
//
//   gap collapses  -> the method is a momentum filter with structural vocabulary
//   gap survives   -> structure carries information momentum does not
//
// Outcome measure is byte-identical to #229 (fall 1 ATR before rising 1 ATR, within 50 HTF bars,
// same stop-first tie-break), so the two rows are directly comparable.

import { loadCandles } from "../../backtest/lib/load-candles.js";
import { asOf } from "../lib/mtf-state.js";

const PIVOT_L = 5, PIVOT_R = 5, ATR_LEN = 14;
const MOVE_ATR = 1.0, WINDOW = 50;
const MOM_LOOKBACK = 6;      // HTF bars (24h on 4h) -- spans the LTF structure's formation
const MIN_N = 60;
const RUNG_SEC = { "4h": 14400, "1h": 3600, "15m": 900 };

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
function pivotLows(c) {
  const lo = [];
  for (let p = PIVOT_L; p < c.length - PIVOT_R; p++) {
    let isL = true;
    for (let k = p - PIVOT_L; k <= p + PIVOT_R; k++) { if (k !== p && c[k].l <= c[p].l) { isL = false; break; } }
    if (isL) lo.push({ confirm: p + PIVOT_R, price: c[p].l });
  }
  return lo;
}
function bearishBreaks(c) {
  const lo = pivotLows(c), out = [];
  let li = 0, lvl = NaN, crossed = true;
  for (let i = 1; i < c.length; i++) {
    while (li < lo.length && lo[li].confirm <= i) { lvl = lo[li].price; crossed = false; li++; }
    if (!Number.isNaN(lvl) && !crossed && c[i].c < lvl && c[i - 1].c >= lvl) { crossed = true; out.push(i); }
  }
  return out;
}
function declineFirst(H, atrH, i) {
  const a = atrH[i];
  if (!Number.isFinite(a) || a <= 0) return null;
  const ref = H[i].c, dn = ref - MOVE_ATR * a, up = ref + MOVE_ATR * a;
  const end = Math.min(H.length - 1, i + WINDOW);
  for (let j = i + 1; j <= end; j++) {
    if (H[j].l <= dn) return 1;                 // same stop-first tie-break as #229, deliberately
    if (H[j].h >= up) return 0;
  }
  return null;
}
const momAt = (H, atrH, i) => {
  const a = atrH[i];
  if (i < MOM_LOOKBACK || !Number.isFinite(a) || a <= 0) return null;
  return (H[i].c - H[i - MOM_LOOKBACK].c) / a;
};

async function run(htf, ltf, instruments, label) {
  const sig = [], mom = [], sigMom = [], momMom = [];

  for (const inst of instruments) {
    let H, L;
    try { H = await loadCandles(htf, inst); L = await loadCandles(ltf, inst); } catch { continue; }
    if (!H || !L || H.length < 1000 || L.length < 2000) continue;
    const atrH = atrSeries(H, ATR_LEN);

    const switchBars = new Set();
    for (const b of bearishBreaks(L)) {
      const hi = asOf(H, RUNG_SEC[htf], L[b].t + RUNG_SEC[ltf]);
      if (hi >= MOM_LOOKBACK + ATR_LEN && hi < H.length - WINDOW - 1) switchBars.add(hi);
    }

    // every eligible bar with its momentum, for the frequency-matched threshold
    const eligible = [];
    for (let i = MOM_LOOKBACK + ATR_LEN; i < H.length - WINDOW - 1; i++) {
      const m = momAt(H, atrH, i);
      if (m !== null) eligible.push({ i, m });
    }
    if (!eligible.length || !switchBars.size) continue;

    // threshold so the momentum signal fires as often as the structure signal
    const sorted = [...eligible].sort((a, b) => a.m - b.m);
    const k = Math.min(sorted.length - 1, switchBars.size - 1);
    const thresh = sorted[k].m;

    for (const { i, m } of eligible) {
      if (switchBars.has(i)) {
        const r = declineFirst(H, atrH, i);
        if (r !== null) { sig.push(r); sigMom.push(m); }
      }
      if (m <= thresh) {
        const r = declineFirst(H, atrH, i);
        if (r !== null) { mom.push(r); momMom.push(m); }
      }
    }
  }

  const pc = (x) => (mean(x) * 100).toFixed(1);
  console.log(`===== ${label}`);
  console.log(`   LTF STRUCTURE switch             n=${String(sig.length).padStart(6)}   declines-first ${pc(sig)}%   median momentum ${med(sigMom).toFixed(2)} ATR`);
  console.log(`   PURE MOMENTUM, matched freq      n=${String(mom.length).padStart(6)}   declines-first ${pc(mom)}%   median momentum ${med(momMom).toFixed(2)} ATR`);
  if (sig.length >= MIN_N && mom.length >= MIN_N) {
    const gap = (mean(sig) - mean(mom)) * 100;
    console.log(`   RESIDUAL GAP ${gap >= 0 ? "+" : ""}${gap.toFixed(1)}pp   z=${propZ(sig, mom).toFixed(2)}`);
    console.log(`   (#229 measured +25pp against an unmatched random bar; that is the number this replaces)`);
  }
  console.log("");
}

async function main() {
  console.log("MOMENTUM CONTROL — structural insight, or a momentum filter in structural vocabulary?");
  console.log(`Structure signal vs a PURE ${MOM_LOOKBACK}-bar momentum signal firing the SAME number of times.`);
  console.log("Signal vs signal, not signal vs hand-picked control -- selection cannot game it.");
  console.log("");
  await run("4h", "1h", ["BTC", "ETH", "SOL", "XRP", "BNB", "ADA", "LTC", "LINK", "XLM"], "HTF 4h / LTF 1h");
  await run("4h", "15m", ["BTC", "ETH", "SOL", "XRP"], "HTF 4h / LTF 15m (his pairing)");
  console.log("Gap collapses to ~0  -> the method is momentum wearing structural vocabulary.");
  console.log("Gap largely survives -> structure carries information momentum does not.");
}

main().catch((e) => { console.error("Fatal:", e); process.exit(1); });
