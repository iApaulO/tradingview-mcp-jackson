#!/usr/bin/env node
// "SHARP TIPS PERFORM DIFFERENTLY THAN FLAT" -- oscillator turning-point CURVATURE.
//
// iapaulo: "the line going 1 direction is half the signal, returning is the other half, that's why
// sharp tips in the line perform differently than flat."
//
// This is a claim about SHAPE, and nothing in the register has ever tested shape. Every prior Boom
// Hunter row tested LEVEL (q1 <= 20, Quotient3 <= -0.9) or CROSSING (q1 crosses trigger, q5 crosses
// 50). Curvature at a turning point is a genuinely new feature class, which is the reason to run it.
//
// THE FRAMING DICTATES THE MEASURE, and it is the right one. "Going one direction" and "returning"
// are the two halves, so sharpness is the SUM of the approach slope and the return slope:
//
//     peak at i:  approach = (v[i] - v[i-W]) / W        return = (v[i] - v[i+W]) / W
//     sharpness   = approach + return      (both positive at a peak; a plateau gives ~0)
//
// **AND THE FRAMING ALSO EXPOSES THE TRAP: THE RETURN HALF IS IN THE FUTURE.** A tip's sharpness is
// NOT KNOWABLE AT THE TIP -- it requires W bars of hindsight to see the return leg. Scoring forward
// returns from the tip bar would be pure lookahead and would manufacture a large fake result. **All
// forward returns here therefore start at bar i+W, the first bar on which the tip's shape is
// actually established.** This costs the test most of the move it would otherwise appear to
// capture, which is precisely why it must be done.
//
// Lines tested: q1 (blue main oscillator), q4 (newly ported this session -- the missing half of the
// EOT2 red-wave pair, #146/#153 gap), q5 (yellow). q5 and q6 are heavily bound-saturated (#147:
// 68% of bars at the ceiling in our port, 88.8% live), so on q5 "flat" is the default state and
// sharp tips are the rare ones -- the same rarity-gate shape #147 identified.
//
// Peaks predict DOWN, troughs predict UP. Split at the median sharpness WITHIN each line and
// extremum type, so "sharp" and "flat" are equal-sized by construction and no threshold is tuned.
// Circular-shift null on the sharp/flat label, two-sided.

import { loadCandles } from "../../backtest/lib/load-candles.js";
import { computeBoomHunter } from "./calc.js";

const SHIFTS = 2000;
const HORIZONS = [1, 3, 6, 12];
const TFS = ["4h", "1h", "15m"];
const W = 3;            // half-window for the approach/return legs
const LINES = ["q1", "q4", "q5"];

function rngf(s) {
  let a = s >>> 0;
  return () => { a |= 0; a = (a + 0x6d2b79f5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
function atr14(c) {
  const tr = c.map((x, i) => (i === 0 ? x.h - x.l : Math.max(x.h - x.l, Math.abs(x.h - c[i - 1].c), Math.abs(x.l - c[i - 1].c))));
  const o = new Array(c.length).fill(NaN);
  if (c.length < 14) return o;
  let a = tr.slice(0, 14).reduce((s, v) => s + v, 0) / 14;
  o[13] = a;
  for (let i = 14; i < c.length; i++) { a = (a * 13 + tr[i]) / 14; o[i] = a; }
  return o;
}
const median = (xs) => { const s = [...xs].sort((a, b) => a - b); return s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2; };

async function main() {
  console.log('SHARP vs FLAT oscillator tips. sharpness = approach slope + return slope.');
  console.log(`W=${W}. **Forward returns start at bar i+${W}, not at the tip** -- the return leg is future`);
  console.log("information and scoring from the tip would be lookahead. Peaks predict DOWN, troughs UP.");
  console.log(`Median split within each line/type. Circular-shift null, ${SHIFTS} shifts, two-sided.\n`);

  for (const inst of ["BTC", "ETH"]) {
    for (const tf of TFS) {
      const c = await loadCandles(tf, inst);
      const atr = atr14(c);
      const n = c.length;
      const { series } = computeBoomHunter(c);
      console.log(`===== ${inst} ${tf} -- ${n.toLocaleString()} bars`);

      for (const lineName of LINES) {
        const v = series[lineName];
        if (!v) { console.log(`  ${lineName}: not in series`); continue; }

        for (const [kind, isPeak, pred] of [["PEAK", true, "-"], ["TROUGH", false, "+"]]) {
          const tips = [];
          for (let i = W; i < n - W; i++) {
            let ext = true;
            for (let k = 1; k <= W; k++) {
              if (isPeak) { if (!(v[i] >= v[i - k] && v[i] >= v[i + k])) { ext = false; break; } }
              else { if (!(v[i] <= v[i - k] && v[i] <= v[i + k])) { ext = false; break; } }
            }
            if (!ext) continue;
            const app = isPeak ? (v[i] - v[i - W]) / W : (v[i - W] - v[i]) / W;
            const ret = isPeak ? (v[i] - v[i + W]) / W : (v[i + W] - v[i]) / W;
            const sharp = app + ret;
            if (!Number.isFinite(sharp)) continue;
            tips.push({ i, sharp });
          }
          if (tips.length < 120) { console.log(`  ${lineName} ${kind}: only ${tips.length} tips, skipped`); continue; }
          const med = median(tips.map((t) => t.sharp));
          const lab = new Int8Array(n);
          let nSharp = 0;
          for (const t of tips) { if (t.sharp > med) { lab[t.i] = 1; nSharp++; } }
          const flatN = tips.length - nSharp;
          if (nSharp < 40 || flatN < 40) { console.log(`  ${lineName} ${kind}: split too uneven (${nSharp}/${flatN})`); continue; }
          console.log(`  ${lineName} ${kind}  tips=${tips.length}  sharp=${nSharp}  flat=${flatN}  median sharpness=${med.toFixed(3)}  predicts ${pred}`);
          console.log("     H    mean SHARP    mean FLAT     contrast       p");
          for (const H of HORIZONS) {
            let ss = 0, ns = 0, sf = 0, nf = 0;
            for (const t of tips) {
              const b = t.i + W; // shape is only known here
              if (b + H >= n) continue;
              const a = atr[b];
              if (!Number.isFinite(a) || a <= 0) continue;
              const r = (c[b + H].c - c[b].c) / a;
              if (lab[t.i] === 1) { ss += r; ns++; } else { sf += r; nf++; }
            }
            if (!ns || !nf) continue;
            const ms = ss / ns, mf = sf / nf, obs = ms - mf;
            const rng = rngf(909 + H);
            let ge = 0;
            for (let k = 0; k < SHIFTS; k++) {
              const off = 1 + Math.floor(rng() * (n - 2));
              let s1 = 0, n1 = 0, s2 = 0, n2 = 0;
              for (const t of tips) {
                const b = t.i + W;
                if (b + H >= n) continue;
                const a = atr[b];
                if (!Number.isFinite(a) || a <= 0) continue;
                const r = (c[b + H].c - c[b].c) / a;
                if (lab[(t.i + off) % n] === 1) { s1 += r; n1++; } else { s2 += r; n2++; }
              }
              if (n1 && n2 && Math.abs(s1 / n1 - s2 / n2) >= Math.abs(obs)) ge++;
            }
            const p = ge / SHIFTS;
            console.log(
              `     ${String(H).padStart(2)}${ms.toFixed(4).padStart(13)}${mf.toFixed(4).padStart(13)}${obs.toFixed(4).padStart(13)}${p.toFixed(4).padStart(9)}${p < 0.05 ? " *" : ""}`,
            );
          }
          console.log("");
        }
      }
    }
  }
}

main().catch((e) => { console.error("Fatal:", e); process.exit(1); });
