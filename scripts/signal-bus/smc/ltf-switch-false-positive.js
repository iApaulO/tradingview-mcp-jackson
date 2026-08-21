#!/usr/bin/env node
// FALSE-POSITIVE RATE OF THE LTF BEARISH SWITCH — the honest completion of #228.
//
// #228 measured how much of an HTF pullback remains when the LTF switches bearish, and found real
// timing skill (66.9% remaining on 4h/15m vs 51.6% random, t=32.67). **But it conditioned on episodes
// where a pullback ACTUALLY OCCURRED.** A signal with excellent timing on the occasions it is right
// can still be useless if it fires constantly. This counts EVERY switch, including the ones #228
// never saw.
//
// THE TEST: from each LTF bearish switch, does HTF price fall by MOVE_ATR before it rises by MOVE_ATR?
//   HIT   declines first  -> the switch anticipated something
//   MISS  advances first  -> false positive
//   unresolved within the window is DISCARDED, not scored either way
//
// **THE BASELINE IS NOT 50%.** In a corpus that rose 13x-96x, "declines first" happens less than half
// the time at random -- #210 established that drift makes naive thresholds misleading. So the control
// is a matched random bar measured identically, and the signal must beat THAT, not 0.5.
//
// TWO POPULATIONS, because the naive reading and his actual claim differ:
//   ALL SWITCHES     every LTF bearish structure break. The naive version.
//   IN CONTEXT       only switches occurring while the HTF is BULLISH and has broken structure up --
//                    which is the situation his method actually describes [16:24-17:34]. A signal is
//                    allowed to be selective; judging it outside its stated context would be unfair.
//
// Also reported: SWITCHES PER PULLBACK EPISODE. If five switches fire per genuine HTF pullback, the
// timing skill in #228 is being bought with four false alarms, and that ratio is the practical cost.
//
// available_at enforced via the shared `asOf`: an LTF switch is only usable once its bar has CLOSED.

import { loadCandles } from "../../backtest/lib/load-candles.js";
import { asOf } from "../lib/mtf-state.js";

const PIVOT_L = 5, PIVOT_R = 5, ATR_LEN = 14;
const MOVE_ATR = 1.0;        // the move that decides hit vs miss
const WINDOW = 50;           // HTF bars allowed to resolve
const MIN_PULLBACK_ATR = 1.0;
const MAX_SCAN = 200;
const MIN_N = 60;
const RUNG_SEC = { "4h": 14400, "1h": 3600, "15m": 900 };

const mean = (xs) => (xs.length ? xs.reduce((s, x) => s + x, 0) / xs.length : NaN);
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
/** HTF bullish state: last confirmed structure event was an upward break */
function bullishState(c) {
  const { hi, lo } = pivots(c);
  const st = new Array(c.length).fill(0);
  let hi_i = 0, lo_i = 0, hLvl = NaN, hCross = true, lLvl = NaN, lCross = true, cur = 0;
  for (let i = 1; i < c.length; i++) {
    while (hi_i < hi.length && hi[hi_i].confirm <= i) { hLvl = hi[hi_i].price; hCross = false; hi_i++; }
    while (lo_i < lo.length && lo[lo_i].confirm <= i) { lLvl = lo[lo_i].price; lCross = false; lo_i++; }
    if (!Number.isNaN(hLvl) && !hCross && c[i].c > hLvl && c[i - 1].c <= hLvl) { hCross = true; cur = 1; }
    if (!Number.isNaN(lLvl) && !lCross && c[i].c < lLvl && c[i - 1].c >= lLvl) { lCross = true; cur = -1; }
    st[i] = cur;
  }
  return st;
}
/** does HTF fall MOVE_ATR before rising MOVE_ATR, starting at bar i? */
function declineFirst(H, atrH, i) {
  const a = atrH[i];
  if (!Number.isFinite(a) || a <= 0) return null;
  const ref = H[i].c, dn = ref - MOVE_ATR * a, up = ref + MOVE_ATR * a;
  const end = Math.min(H.length - 1, i + WINDOW);
  for (let j = i + 1; j <= end; j++) {
    if (H[j].l <= dn) return 1;
    if (H[j].h >= up) return 0;
  }
  return null;
}

async function run(htf, ltf, instruments, label) {
  const all = [], ctx = [], rnd = [];
  let episodes = 0, switchesInCtx = 0;

  for (const inst of instruments) {
    let H, L;
    try { H = await loadCandles(htf, inst); L = await loadCandles(ltf, inst); } catch { continue; }
    if (!H || !L || H.length < 1000 || L.length < 2000) continue;
    const atrH = atrSeries(H, ATR_LEN);
    const bull = bullishState(H);
    const breaks = bearishBreaks(L);
    const rng = mulberry32(61000 + inst.length);

    for (const b of breaks) {
      const closeT = L[b].t + RUNG_SEC[ltf];          // usable only once the LTF bar has closed
      const hi = asOf(H, RUNG_SEC[htf], closeT);      // last HTF bar closed by then
      if (hi < ATR_LEN + 1 || hi >= H.length - WINDOW - 1) continue;
      const r = declineFirst(H, atrH, hi);
      if (r === null) continue;
      all.push(r);
      if (bull[hi] === 1) { ctx.push(r); switchesInCtx++; }
    }

    // matched random baseline, same count as the in-context arm
    const pool = [];
    for (let i = ATR_LEN + 1; i < H.length - WINDOW - 1; i++) pool.push(i);
    for (let k = 0; k < switchesInCtx; k++) {
      const ix = pool[Math.floor(rng() * pool.length)];
      const r = declineFirst(H, atrH, ix);
      if (r !== null) rnd.push(r);
    }

    // genuine HTF pullback episodes, for the switches-per-episode ratio
    const ph = pivots(H);
    for (const peak of ph.hi) {
      let trough = Infinity;
      const end = Math.min(H.length - 1, peak.bar + MAX_SCAN);
      for (let j = peak.bar + 1; j <= end; j++) {
        if (H[j].h > peak.price) break;
        if (H[j].l < trough) trough = H[j].l;
      }
      const a = atrH[peak.bar];
      if (Number.isFinite(a) && a > 0 && peak.price - trough >= MIN_PULLBACK_ATR * a) episodes++;
    }
  }

  const pc = (x) => (mean(x) * 100).toFixed(1);
  console.log(`===== ${label}`);
  console.log(`   ALL LTF switches            n=${String(all.length).padStart(6)}   declines-first ${pc(all)}%`);
  console.log(`   IN CONTEXT (HTF bullish)    n=${String(ctx.length).padStart(6)}   declines-first ${ctx.length >= MIN_N ? pc(ctx) + "%" : "below floor"}`);
  console.log(`   MATCHED RANDOM baseline     n=${String(rnd.length).padStart(6)}   declines-first ${rnd.length >= MIN_N ? pc(rnd) + "%" : "below floor"}`);
  if (ctx.length >= MIN_N && rnd.length >= MIN_N) console.log(`   IN CONTEXT vs RANDOM   z=${propZ(ctx, rnd).toFixed(2)}`);
  if (all.length >= MIN_N && rnd.length >= MIN_N) console.log(`   ALL        vs RANDOM   z=${propZ(all, rnd).toFixed(2)}`);
  console.log(`   genuine HTF pullback episodes ${episodes}   |   in-context switches ${switchesInCtx}   ->  ${(switchesInCtx / Math.max(1, episodes)).toFixed(2)} switches per episode`);
  console.log("");
}

async function main() {
  console.log("FALSE-POSITIVE RATE — every LTF bearish switch, including the ones #228 never saw.");
  console.log(`HIT = HTF falls ${MOVE_ATR} ATR before rising ${MOVE_ATR} ATR, within ${WINDOW} HTF bars. Unresolved discarded.`);
  console.log("Baseline is NOT 50%: in a corpus that rose 13x-96x, declines-first is rarer at random (#210).\n");
  await run("4h", "1h", ["BTC", "ETH", "SOL", "XRP", "BNB", "ADA", "LTC", "LINK", "XLM"], "HTF 4h / LTF 1h");
  await run("4h", "15m", ["BTC", "ETH", "SOL", "XRP"], "HTF 4h / LTF 15m (his pairing)");
  console.log("The signal is usable only if it beats the matched random baseline. Switches-per-episode");
  console.log("is the practical cost: #228's timing skill is bought with every false alarm above 1.0.");
}

main().catch((e) => { console.error("Fatal:", e); process.exit(1); });
