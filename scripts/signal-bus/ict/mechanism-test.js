#!/usr/bin/env node
// WHAT IS THE MECHANISM? — discriminating between three explanations for the pivot-cluster effect.
//
// #222 removed the borrowed explanation: Osler's round-number stop clustering DOES NOT EXIST in
// crypto (edge -0.4pp, n~290k). So #192's liquidity pools and #216's breakers are an effect without
// a validated mechanism. Three candidates, and they make different predictions:
//
//   A  REAL RESTING LIQUIDITY at swing extremes. Traders do place stops beyond recent swing
//      highs/lows. Osler's mechanism keyed to pivots rather than round numbers.
//      PREDICTS: breaching a pool ACCELERATES the move (a cascade) relative to breaching a
//      comparable level with no cluster.
//
//   B  PRIOR-EXTREME / RANGE STRUCTURE. A pivot IS a local extreme by construction, so price
//      returning to it returns to a place a range boundary already sat.
//      PREDICTS: reaction is present, but CLUSTERING ADDS NOTHING -- a single isolated pivot
//      reacts as well as a 3-pivot cluster.
//
//   C  SELECTION ARTIFACT. A k>=3 cluster is by definition a level price visited repeatedly AND
//      reversed at; and #192's placebo sat 1-3 ATR away, possibly INSIDE the same range, making the
//      comparison "range edge vs range interior".
//      PREDICTS: cluster and single pivot BOTH beat a displaced placebo by a similar margin, i.e.
//      the placebo control was the weak part rather than the clustering being the strong part.
//
// TEST 1 -- CLUSTER vs ISOLATED PIVOT vs PLACEBO, at first touch.
//   Same pivot detection for both arms; the ONLY difference is whether another same-side pivot sits
//   within the cluster band. This is the control #192 never had: a level that is a genuine prior
//   extreme but NOT clustered. It separates A/B from each other and exposes C.
//
// TEST 2 -- POST-BREACH ACCELERATION (Osler's cascade prediction, the signature of real resting
//   orders). When price CLOSES through a level, does the next W bars' movement accelerate more after
//   breaching a CLUSTER than after breaching an ISOLATED pivot? Measured as forward displacement in
//   ATR units, in the breach direction.
//
// Metrics mirror #192 so the numbers are comparable: same-bar rejection rate (drift-immune) and
// W-bar signed reaction. Existing data only. 4h, nine instruments.

import { loadCandles } from "../../backtest/lib/load-candles.js";

const ATR_LEN = 14, PIVOT_LEFT = 5, PIVOT_RIGHT = 5, MARGIN_DIV = 2.5;
const W = 12, MAX_WAIT = 400, MIN_N = 60, SEED = 20260821;
const INSTRUMENTS = ["BTC", "ETH", "SOL", "XRP", "BNB", "ADA", "LTC", "LINK", "XLM"];

const mean = (xs) => (xs.length ? xs.reduce((s, x) => s + x, 0) / xs.length : NaN);
const sd = (xs) => { const m = mean(xs); return Math.sqrt(mean(xs.map((x) => (x - m) ** 2))); };
function propZ(a, b) {
  const na = a.length, nb = b.length;
  if (!na || !nb) return NaN;
  const xa = a.reduce((s, v) => s + v, 0), xb = b.reduce((s, v) => s + v, 0);
  const pa = xa / na, pb = xb / nb, pp = (xa + xb) / (na + nb);
  const se = Math.sqrt(pp * (1 - pp) * (1 / na + 1 / nb));
  return se > 0 ? (pa - pb) / se : NaN;
}
function welch(a, b) {
  const na = a.length, nb = b.length;
  if (na < 2 || nb < 2) return NaN;
  const va = sd(a) ** 2 * na / (na - 1), vb = sd(b) ** 2 * nb / (nb - 1);
  return (mean(a) - mean(b)) / Math.sqrt(va / na + vb / nb);
}
function mulberry32(a) {
  return function () { a |= 0; a = (a + 0x6D2B79F5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
function atrSeries(c, L) {
  const tr = c.map((x, i) => (i === 0 ? x.h - x.l : Math.max(x.h - x.l, Math.abs(x.h - c[i - 1].c), Math.abs(x.l - c[i - 1].c))));
  const o = new Array(c.length).fill(NaN);
  let s = 0; for (let i = 0; i < L; i++) s += tr[i];
  o[L - 1] = s / L;
  for (let i = L; i < c.length; i++) o[i] = (o[i - 1] * (L - 1) + tr[i]) / L;
  return o;
}

/** Confirmed pivots, same geometry as ict/liquidity.js. side 1 = high, -1 = low. */
function pivots(c) {
  const out = [];
  for (let p = PIVOT_LEFT; p < c.length - PIVOT_RIGHT; p++) {
    let isH = true, isL = true;
    for (let k = p - PIVOT_LEFT; k <= p + PIVOT_RIGHT; k++) {
      if (k === p) continue;
      if (c[k].h >= c[p].h) isH = false;
      if (c[k].l <= c[p].l) isL = false;
    }
    // confirmed only once the right-hand bars exist
    if (isH) out.push({ idx: p, confirm: p + PIVOT_RIGHT, price: c[p].h, side: 1 });
    if (isL) out.push({ idx: p, confirm: p + PIVOT_RIGHT, price: c[p].l, side: -1 });
  }
  return out;
}

/** first bar at/after `from` that reaches `level` from `side` ("above" => approach from below) */
function firstTouch(c, from, level, approachFromBelow) {
  const end = Math.min(c.length - 1, from + MAX_WAIT);
  for (let j = from; j <= end; j++) {
    if (approachFromBelow ? c[j].h >= level : c[j].l <= level) return j;
  }
  return -1;
}
/** same-bar rejection + W-bar signed reaction, positive = level HELD */
function react(c, t, level, isResistance) {
  const k = Math.min(c.length - 1, t + W);
  if (k <= t) return null;
  const ret = (c[k].c - level) / level;
  return { signed: isResistance ? -ret : ret, rejected: isResistance ? (c[t].c < level ? 1 : 0) : (c[t].c > level ? 1 : 0) };
}

async function main() {
  console.log("MECHANISM TEST — is the pivot-cluster effect (A) resting liquidity, (B) prior-extreme");
  console.log("range structure, or (C) a selection artifact of the placebo control?\n");
  console.log("TEST 1: first touch of a CLUSTERED pivot vs an ISOLATED pivot vs a displaced PLACEBO.");
  console.log("The isolated-pivot arm is the control #192 never had -- a real prior extreme, not clustered.\n");

  const acc = { clus: { r: [], j: [] }, iso: { r: [], j: [] }, plac: { r: [], j: [] } };
  const casc = { clus: [], iso: [] };

  for (const inst of INSTRUMENTS) {
    let c; try { c = await loadCandles("4h", inst); } catch { continue; }
    if (!c || c.length < 2000) continue;
    const atr = atrSeries(c, ATR_LEN);
    const pv = pivots(c);
    const rnd = mulberry32(SEED + inst.length);

    for (let n = 0; n < pv.length; n++) {
      const p = pv[n];
      const a = atr[p.confirm];
      if (!Number.isFinite(a) || a <= 0) continue;
      const band = a / MARGIN_DIV;

      // clustered = at least 2 OTHER same-side pivots already confirmed within the band
      let others = 0;
      for (let m = 0; m < n; m++) {
        const q = pv[m];
        if (q.side !== p.side || q.confirm > p.confirm) continue;
        if (Math.abs(q.price - p.price) <= band) others++;
      }
      const clustered = others >= 2;
      const isResistance = p.side === 1;
      const from = p.confirm + 1;

      const t = firstTouch(c, from, p.price, isResistance);
      if (t < 0) continue;
      const r = react(c, t, p.price, isResistance);
      if (!r) continue;
      const bucket = clustered ? acc.clus : acc.iso;
      bucket.r.push(r.rejected); bucket.j.push(r.signed);

      // placebo displaced 1-3 ATR, same approach side -- #192's control, reproduced
      const u = 1 + 2 * rnd(), sgn = rnd() < 0.5 ? -1 : 1;
      const lvl = p.price + sgn * u * a;
      const tp = firstTouch(c, from, lvl, isResistance);
      if (tp >= 0) { const rp = react(c, tp, lvl, isResistance); if (rp) { acc.plac.r.push(rp.rejected); acc.plac.j.push(rp.signed); } }

      // TEST 2 -- cascade: find the bar that CLOSES through the level, measure forward displacement
      let br = -1;
      const end = Math.min(c.length - 1, from + MAX_WAIT);
      for (let j = from; j <= end; j++) {
        if (isResistance ? c[j].c > p.price : c[j].c < p.price) { br = j; break; }
      }
      if (br > 0 && br + W < c.length) {
        const disp = (isResistance ? (c[br + W].c - p.price) : (p.price - c[br + W].c)) / atr[br];
        if (Number.isFinite(disp)) (clustered ? casc.clus : casc.iso).push(disp);
      }
    }
  }

  const row = (name, b) => {
    if (b.r.length < MIN_N) return console.log(`  ${name.padEnd(26)} n=${b.r.length} -- below n>=${MIN_N}`);
    console.log(`  ${name.padEnd(26)} n=${String(b.r.length).padStart(6)}   rejection ${(mean(b.r) * 100).toFixed(1)}%   ${W}-bar reaction ${(mean(b.j) * 100).toFixed(4)}%`);
  };
  row("CLUSTERED pivot (k>=3)", acc.clus);
  row("ISOLATED pivot", acc.iso);
  row("PLACEBO (+/-1-3 ATR)", acc.plac);
  console.log("");
  console.log(`  clustered vs isolated : rejection z=${propZ(acc.clus.r, acc.iso.r).toFixed(2)}   reaction Welch t=${welch(acc.clus.j, acc.iso.j).toFixed(2)}`);
  console.log(`  isolated  vs placebo  : rejection z=${propZ(acc.iso.r, acc.plac.r).toFixed(2)}   reaction Welch t=${welch(acc.iso.j, acc.plac.j).toFixed(2)}`);
  console.log(`  clustered vs placebo  : rejection z=${propZ(acc.clus.r, acc.plac.r).toFixed(2)}   reaction Welch t=${welch(acc.clus.j, acc.plac.j).toFixed(2)}`);

  console.log("\nTEST 2: post-breach displacement in ATR units (Osler's cascade signature).");
  console.log(`  after breaching CLUSTERED  n=${casc.clus.length}  mean ${mean(casc.clus).toFixed(3)} ATR`);
  console.log(`  after breaching ISOLATED   n=${casc.iso.length}  mean ${mean(casc.iso).toFixed(3)} ATR`);
  console.log(`  cascade difference: Welch t=${welch(casc.clus, casc.iso).toFixed(2)}`);

  console.log("\nREAD IT THIS WAY:");
  console.log("  clustered >> isolated, and cascade larger after clusters -> (A) RESTING LIQUIDITY.");
  console.log("  clustered ~= isolated, both > placebo                    -> (B) PRIOR EXTREME; clustering is decorative.");
  console.log("  isolated ~= clustered ~ large vs placebo, no cascade     -> (C) the PLACEBO was the weak control.");
}

main().catch((e) => { console.error("Fatal:", e); process.exit(1); });
