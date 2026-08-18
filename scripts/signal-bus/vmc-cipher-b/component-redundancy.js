#!/usr/bin/env node
// MARKET CIPHER B -- COMPONENT REDUNDANCY MATRIX.
//
// The prerequisite for every synergy claim in the Cipher B programme. #45 caught ONE tautology by
// hand -- "Cipher A wt2 vs Cipher B wt2 is near-tautological, discard" -- and that catch was the
// difference between a real confluence finding and counting one measurement twice. Nothing since
// has checked the rest of the component set, so the #28 failure mode (r=0.9993, discarded) remains
// live for every untested pair.
//
// **#45's tautology is included as a POSITIVE CONTROL.** If this matrix does not independently flag
// Cipher A wt2 against Cipher B wt2 as near-duplicate, the method is wrong and no other cell in the
// output may be trusted. A redundancy test that cannot rediscover a known redundancy is not
// evidence about the unknown ones.
//
// TWO MEASURES, because they answer different questions and either alone misleads:
//   * PEARSON r -- linear redundancy. Catches "these are the same series rescaled".
//   * MUTUAL INFORMATION (quantile-binned, normalised by marginal entropy) -- nonlinear dependence.
//     Catches "these are deterministically related but not linearly", which r reports as ~0.
// A pair can show r near zero and still be information-redundant; reporting only r would license
// exactly the false-confluence claim this file exists to prevent.
//
// Components are taken as PER-BAR SERIES, not as event lists. Events are sparse and their
// co-occurrence is a different question (that is what #137's breadth machinery measures). Redundancy
// between the underlying continuous primitives is what determines whether two "confirming" signals
// are actually two observations.
//
// available_at is not at issue here: this measures the mutual dependence of contemporaneous series,
// makes no forward claim, and produces no signal.

import { loadCandles } from "../../backtest/lib/load-candles.js";
import { computeWaveTrend as wtB, computeMfi, computeStc } from "./calc.js";
import { computeWaveTrend as wtA } from "../vmc-cipher-a/calc.js";

const TFS = ["4h", "1h", "15m"];
const INSTRUMENTS = ["BTC", "ETH"];
const BINS = 12;                 // quantile bins for the MI estimate
const NEAR_DUPLICATE_R = 0.95;   // |r| at or above this is treated as the same measurement
const HIGH_MI = 0.50;            // normalised MI at or above this is heavy information overlap

const finite = (xs) => xs.filter(Number.isFinite);

function pearson(a, b) {
  const pairs = [];
  for (let i = 0; i < a.length; i++) if (Number.isFinite(a[i]) && Number.isFinite(b[i])) pairs.push([a[i], b[i]]);
  if (pairs.length < 50) return NaN;
  const n = pairs.length;
  const ma = pairs.reduce((s, p) => s + p[0], 0) / n;
  const mb = pairs.reduce((s, p) => s + p[1], 0) / n;
  let num = 0, da = 0, db = 0;
  for (const [x, y] of pairs) { const u = x - ma, v = y - mb; num += u * v; da += u * u; db += v * v; }
  return da > 0 && db > 0 ? num / Math.sqrt(da * db) : NaN;
}

// Quantile binning rather than equal-width: several of these series are heavily bound-saturated
// (STC lives at 0 and 100), and equal-width bins would put almost every observation in one bucket
// and report near-zero MI for series that are in fact tightly coupled.
function quantileBin(xs, bins) {
  const s = finite(xs).slice().sort((p, q) => p - q);
  if (s.length < bins * 5) return null;
  const cuts = [];
  for (let k = 1; k < bins; k++) cuts.push(s[Math.floor((k / bins) * s.length)]);
  return (v) => {
    if (!Number.isFinite(v)) return -1;
    let i = 0;
    while (i < cuts.length && v > cuts[i]) i++;
    return i;
  };
}

// Normalised MI: I(X;Y) / min(H(X), H(Y)). 0 = independent, 1 = one series determines the other.
function normalisedMI(a, b) {
  const fa = quantileBin(a, BINS), fb = quantileBin(b, BINS);
  if (!fa || !fb) return NaN;
  const joint = new Map();
  const pa = new Array(BINS).fill(0), pb = new Array(BINS).fill(0);
  let n = 0;
  for (let i = 0; i < a.length; i++) {
    if (!Number.isFinite(a[i]) || !Number.isFinite(b[i])) continue;
    const x = fa(a[i]), y = fb(b[i]);
    if (x < 0 || y < 0) continue;
    joint.set(x * BINS + y, (joint.get(x * BINS + y) || 0) + 1);
    pa[x]++; pb[y]++; n++;
  }
  if (n < 200) return NaN;
  let hx = 0, hy = 0, mi = 0;
  for (let i = 0; i < BINS; i++) {
    if (pa[i]) { const p = pa[i] / n; hx -= p * Math.log2(p); }
    if (pb[i]) { const p = pb[i] / n; hy -= p * Math.log2(p); }
  }
  for (const [k, c] of joint) {
    const p = c / n, x = Math.floor(k / BINS), y = k % BINS;
    const px = pa[x] / n, py = pb[y] / n;
    if (p > 0 && px > 0 && py > 0) mi += p * Math.log2(p / (px * py));
  }
  const denom = Math.min(hx, hy);
  return denom > 0 ? mi / denom : NaN;
}

async function main() {
  console.log("MARKET CIPHER B -- COMPONENT REDUNDANCY MATRIX");
  console.log("Prerequisite for every synergy claim: two 'confirming' components that are the same");
  console.log("measurement produce false confluence (#28's r=0.9993, discarded; #45's Cipher A/B wt2).");
  console.log(`|r| >= ${NEAR_DUPLICATE_R} = near-duplicate.  normalised MI >= ${HIGH_MI} = heavy information overlap.`);
  console.log("POSITIVE CONTROL: cipherA_wt2 vs wt2 is KNOWN redundant (#45). If it is not flagged, distrust the rest.\n");

  for (const inst of INSTRUMENTS) {
    for (const tf of TFS) {
      const c = await loadCandles(tf, inst);
      if (!c.length) continue;
      const B = wtB(c), A = wtA(c);
      const stc = computeStc(c);
      const series = {
        wt2: B.wt2,
        wt1: B.wt1,
        wt_cross: B.wt1.map((v, i) => (Number.isFinite(v) && Number.isFinite(B.wt2[i]) ? v - B.wt2[i] : NaN)),
        mfi: computeMfi(c),
        stc: Array.isArray(stc) ? stc : stc.stc || stc.values || [],
        cipherA_wt2: A.wt2,
      };
      const names = Object.keys(series).filter((k) => finite(series[k]).length > 500);

      console.log(`===== ${inst} ${tf}  (${c.length.toLocaleString()} bars)`);
      console.log("  pair                          Pearson r    norm MI    verdict");
      const flagged = [];
      for (let i = 0; i < names.length; i++) {
        for (let j = i + 1; j < names.length; j++) {
          const a = names[i], b = names[j];
          const r = pearson(series[a], series[b]);
          const mi = normalisedMI(series[a], series[b]);
          let verdict = "independent";
          if (Number.isFinite(r) && Math.abs(r) >= NEAR_DUPLICATE_R) verdict = "NEAR-DUPLICATE";
          else if (Number.isFinite(mi) && mi >= HIGH_MI) verdict = "heavy overlap";
          else if (Number.isFinite(mi) && mi >= 0.20) verdict = "partial overlap";
          if (verdict !== "independent") flagged.push(`${a}~${b}`);
          console.log(
            `  ${(a + " ~ " + b).padEnd(30)}${(Number.isFinite(r) ? r.toFixed(4) : "n/a").padStart(9)}` +
            `${(Number.isFinite(mi) ? mi.toFixed(4) : "n/a").padStart(11)}    ${verdict}`,
          );
        }
      }
      const controlHit = flagged.some((f) => f.includes("cipherA_wt2"));
      console.log(`  CONTROL: cipherA_wt2 flagged? ${controlHit ? "YES -- method reproduces #45" : "NO -- METHOD SUSPECT, distrust this block"}\n`);
    }
  }
  console.log("Reading this: NEAR-DUPLICATE pairs must never be counted as independent confirmation.");
  console.log("'heavy overlap' pairs may still add something, but a confluence claim built on them");
  console.log("needs the independence check run first -- the #150 precedent, where 100% directional");
  console.log("agreement meant one event was being counted twice.");
}

main().catch((e) => { console.error("Fatal:", e); process.exit(1); });
