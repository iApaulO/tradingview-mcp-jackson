#!/usr/bin/env node
// THE TIMING CLAIM — does the LTF switch LEAD the HTF pullback, or merely coincide with it?
//
// Photon's claim (#226, [16:31-17:34]): after an HTF break of structure, the LOWER timeframe switching
// bearish tells you the HTF pullback is starting. **This is the practical heart of the whole method.**
// If the LTF switch merely coincides with the HTF turn -- or lags it -- the method provides no timing
// advantage and the entire multi-timeframe apparatus is decorative.
//
// THE MEASURE: at the moment the LTF switches bearish, HOW MUCH OF THE PULLBACK IS STILL AHEAD?
//   pullback  = HTF swing high H down to the subsequent trough L
//   elapsed   = (H - close at the LTF switch) / (H - L)
//   REMAINING = 1 - elapsed        <- the fraction still capturable
// Remaining ~1.0 means the signal fires at the top and the whole move is ahead. Remaining ~0.0 means
// it fires at the bottom and the move is already over.
//
// NO LOOKAHEAD IN THE SIGNAL. H and L are used only to MEASURE how good the timing was -- they are
// the evaluation yardstick, not inputs to the signal. The LTF switch itself is computed from closed
// bars only, through the shared `asOf` primitive, so no rung sees past its own close.
//
// CONTROLS, because "remaining is positive" is not on its own impressive:
//   OUR-INTERNAL  the HTF's own internal-structure bearish break -- can the LTF beat a signal we
//                 already have on the SAME chart? If not, the extra timeframe earns nothing.
//   RANDOM        a uniformly drawn bar between H and L. A coin-flip entry captures ~50% on average,
//                 so ANY signal must beat ~0.5 to be worth its complexity.
//
// HTF/LTF pairs: 4h/1h on all nine instruments; 4h/15m on the four with 15m data, which is closer to
// his stated 4H/M15 ratio (16x rather than 4x).

import { loadCandles } from "../../backtest/lib/load-candles.js";
import { asOf } from "../lib/mtf-state.js";

const PIVOT_L = 5, PIVOT_R = 5, ATR_LEN = 14;
const MIN_PULLBACK_ATR = 1.0;     // ignore trivial wiggles
const MAX_SCAN = 200;             // bars to look for the trough
const SEEDS = 1, MIN_N = 60;
const RUNG_SEC = { "4h": 14400, "1h": 3600, "15m": 900 };

const mean = (xs) => (xs.length ? xs.reduce((s, x) => s + x, 0) / xs.length : NaN);
const med = (xs) => { if (!xs.length) return NaN; const a = [...xs].sort((p, q) => p - q); return a[Math.floor(a.length / 2)]; };
const sd = (xs) => { const m = mean(xs); return Math.sqrt(mean(xs.map((x) => (x - m) ** 2))); };
function welch(a, b) {
  const na = a.length, nb = b.length;
  if (na < 2 || nb < 2) return NaN;
  const va = sd(a) ** 2 * na / (na - 1), vb = sd(b) ** 2 * nb / (nb - 1);
  return (mean(a) - mean(b)) / Math.sqrt(va / na + vb / nb);
}
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
  for (let p = PIVOT_L; p < c.length - PIVOT_R; p++) {
    let isH = true, isL = true;
    for (let k = p - PIVOT_L; k <= p + PIVOT_R; k++) {
      if (k === p) continue;
      if (c[k].h >= c[p].h) isH = false;
      if (c[k].l <= c[p].l) isL = false;
    }
    if (isH) hi.push({ bar: p, confirm: p + PIVOT_R, price: c[p].h });
    if (isL) lo.push({ bar: p, confirm: p + PIVOT_R, price: c[p].l });
  }
  return { hi, lo };
}
/** bars where structure breaks DOWN: close under the most recent confirmed pivot low */
function bearishBreaks(c) {
  const { lo } = pivots(c);
  const out = [];
  let li = 0, lvl = NaN, crossed = true;
  for (let i = 1; i < c.length; i++) {
    while (li < lo.length && lo[li].confirm <= i) { lvl = lo[li].price; crossed = false; li++; }
    if (!Number.isNaN(lvl) && !crossed && c[i].c < lvl && c[i - 1].c >= lvl) { crossed = true; out.push(i); }
  }
  return out;
}

async function run(htf, ltf, instruments, label) {
  const rem = { ltf: [], internal: [], random: [] };
  const lagBars = [];
  let episodes = 0;

  for (const inst of instruments) {
    let H, L;
    try { H = await loadCandles(htf, inst); L = await loadCandles(ltf, inst); } catch { continue; }
    if (!H || !L || H.length < 1000 || L.length < 2000) continue;
    const atrH = atrSeries(H, ATR_LEN);
    const ph = pivots(H);
    const ltfBreaks = bearishBreaks(L);          // LTF bearish switches, bar indices on L
    const htfInternal = bearishBreaks(H);        // our own same-chart internal break, for contrast

    for (const peak of ph.hi) {
      // the trough that follows this HTF swing high, before price exceeds the high again
      let troughIdx = -1, troughPx = Infinity;
      const end = Math.min(H.length - 1, peak.bar + MAX_SCAN);
      for (let j = peak.bar + 1; j <= end; j++) {
        if (H[j].h > peak.price) break;                      // run resumed; pullback over
        if (H[j].l < troughPx) { troughPx = H[j].l; troughIdx = j; }
      }
      if (troughIdx < 0) continue;
      const drop = peak.price - troughPx;
      const a = atrH[peak.bar];
      if (!Number.isFinite(a) || a <= 0 || drop < MIN_PULLBACK_ATR * a) continue;
      episodes++;

      const peakTime = H[peak.bar].t, troughTime = H[troughIdx].t;
      const remainingAt = (px) => (px - troughPx) / drop;    // 1 at the peak, 0 at the trough

      // --- LTF bearish switch: first one whose bar CLOSES after the peak bar closes
      let sIdx = -1;
      for (const b of ltfBreaks) {
        const closeT = L[b].t + RUNG_SEC[ltf];
        if (closeT > peakTime + RUNG_SEC[htf] && L[b].t <= troughTime) { sIdx = b; break; }
      }
      if (sIdx >= 0) {
        rem.ltf.push(remainingAt(L[sIdx].c));
        lagBars.push((L[sIdx].t - peakTime) / RUNG_SEC[htf]);
      }

      // --- our own HTF internal break, same window
      const iBar = htfInternal.find((b) => b > peak.bar && b <= troughIdx);
      if (iBar !== undefined) rem.internal.push(remainingAt(H[iBar].c));

      // --- random bar inside the pullback window
      if (troughIdx > peak.bar + 1) {
        const rb = peak.bar + 1 + Math.floor(((peak.bar * 2654435761) % 1000) / 1000 * (troughIdx - peak.bar - 1));
        rem.random.push(remainingAt(H[rb].c));
      }
    }
  }

  console.log(`===== ${label}   pullback episodes ${episodes}`);
  const row = (n, xs) => {
    if (xs.length < MIN_N) return console.log(`   ${n.padEnd(34)} n=${xs.length} -- below n>=${MIN_N}`);
    console.log(`   ${n.padEnd(34)} n=${String(xs.length).padStart(6)}   mean remaining ${(mean(xs) * 100).toFixed(1)}%   median ${(med(xs) * 100).toFixed(1)}%`);
  };
  row(`LTF (${ltf}) bearish switch`, rem.ltf);
  row(`HTF internal break [our own]`, rem.internal);
  row(`RANDOM bar in the pullback`, rem.random);
  if (rem.ltf.length >= MIN_N && rem.random.length >= MIN_N)
    console.log(`   LTF vs RANDOM   Welch t=${welch(rem.ltf, rem.random).toFixed(2)}`);
  if (rem.ltf.length >= MIN_N && rem.internal.length >= MIN_N)
    console.log(`   LTF vs OUR INTERNAL   Welch t=${welch(rem.ltf, rem.internal).toFixed(2)}`);
  if (lagBars.length) console.log(`   lag from HTF peak to LTF switch: median ${med(lagBars).toFixed(1)} ${htf} bars`);
  console.log("");
}

async function main() {
  console.log("THE TIMING CLAIM — does the LTF bearish switch LEAD the HTF pullback or merely coincide?");
  console.log("Measure: fraction of the pullback STILL AHEAD when the signal fires (1.0 = at the top, 0.0 = at the bottom).");
  console.log("Signal uses closed bars only; the peak and trough are the evaluation yardstick, not inputs.");
  console.log("A random bar inside the pullback captures ~50% by construction -- that is the bar to beat.\n");
  await run("4h", "1h", ["BTC", "ETH", "SOL", "XRP", "BNB", "ADA", "LTC", "LINK", "XLM"], "HTF 4h / LTF 1h  (4x ratio, all nine)");
  await run("4h", "15m", ["BTC", "ETH", "SOL", "XRP"], "HTF 4h / LTF 15m (16x ratio, his stated pairing)");
  console.log("The method earns its complexity only if the LTF switch leaves materially MORE than ~50%");
  console.log("of the pullback ahead, AND beats the internal break we already compute on the HTF itself.");
}

main().catch((e) => { console.error("Fatal:", e); process.exit(1); });
