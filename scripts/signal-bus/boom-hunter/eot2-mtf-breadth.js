#!/usr/bin/env node
// IS EOT2 SATURATION AN MTF CO-OCCURRENCE PHENOMENON? -- breadth across the 8-rung ladder.
//
// iapaulo: "are we looking at mtf co-occurring values?"
//
// #137 established that the informative multi-timeframe variable in this project is BREADTH OF
// AGREEMENT -- how many rungs agree inside a window -- not the ORDER they fire in, and #143
// pre-registered that result on SOL. #162 left the EOT2 saturation finding as a long-only 4h signal
// with the drift question unresolved. Breadth is the natural next lens because it is the one MTF
// mechanism this project has actually validated.
//
// **THE INDEPENDENCE PROBLEM IS DIFFERENT HERE AND MUST BE STATED BEFORE ANY NUMBER IS READ.** In
// #150 the risk was two DIFFERENT constructs (liquidity breaks, SMC structure) turning out to be the
// same event. Here the risk is one construct measured on NESTED windows: a 4h bar literally contains
// four 1h bars, so if EOT2 is railed on 4h the 1h rungs inside it are mechanically likely to be
// railed too. **Overlap is therefore GUARANTEED and a high co-occurrence rate proves nothing.** The
// only meaningful question is whether BREADTH CARRIES INFORMATION BEYOND THE BASE RUNG'S OWN STATE
// -- which is why this reports the K>=2 / K>=3 contrast CONDITIONAL on the base rung already being
// railed, not the unconditional co-occurrence rate.
//
// available_at, the #135 discipline: a rung contributes only its last bar CLOSED at or before the
// base bar's OPEN. A coarser rung's currently-forming bar is not knowable and must never be used.
//
// This is a FORWARD-RETURN study. #155 and #162 both showed forward-return findings shrinking or
// inverting under the #143 R-multiple construction, so nothing here is a strategy result and the
// R-multiple rebuild is mandatory before any claim. Reported as structure, not as edge.

import { loadCandles } from "../../backtest/lib/load-candles.js";
import { computeBoomHunter } from "./calc.js";

const SHIFTS = 2000;
const HORIZONS = [6, 12, 24];
const TOL = 1e-9;
const BASE = "4h"; // #162 located the surviving effect here
const LADDER = ["1w", "1d", "4h", "3h", "2h", "1h", "15m", "5m"];

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
function satState(candles) {
  const { series } = computeBoomHunter(candles);
  const { q3, q4 } = series;
  const n = candles.length;
  const st = new Int8Array(n);
  for (let i = 0; i < n; i++) {
    if (!Number.isFinite(q3[i]) || !Number.isFinite(q4[i])) continue;
    if (Math.abs(q3[i] - q4[i]) > TOL) continue;
    st[i] = q3[i] > 50 ? 1 : -1;
  }
  return st;
}

async function main() {
  console.log("EOT2 SATURATION AS AN MTF BREADTH VARIABLE -- base rung " + BASE + ".");
  console.log("Rungs are NESTED, so co-occurrence is structurally guaranteed and proves nothing.");
  console.log("The real question is whether breadth adds anything GIVEN the base rung is railed.\n");

  for (const inst of ["BTC", "ETH"]) {
    const base = await loadCandles(BASE, inst);
    const atr = atr14(base);
    const n = base.length;
    const baseSt = satState(base);

    // Other rungs, aligned by available_at: last CLOSED bar at or before the base bar's open.
    const others = [];
    for (const tf of LADDER) {
      if (tf === BASE) continue;
      const c = await loadCandles(tf, inst);
      if (!c.length) continue;
      const st = satState(c);
      const times = c.map((x) => x.t);
      const dur = tf === "1w" ? 604800 : tf === "1d" ? 86400 : tf === "3h" ? 10800 : tf === "2h" ? 7200 : tf === "1h" ? 3600 : tf === "15m" ? 900 : 300;
      const aligned = new Int8Array(n);
      let k = 0;
      for (let i = 0; i < n; i++) {
        const openT = base[i].t;
        while (k + 1 < times.length && times[k + 1] + dur <= openT) k++;
        aligned[i] = times[k] + dur <= openT ? st[k] : 0;
      }
      others.push({ tf, aligned });
    }

    // pairwise redundancy against the base rung (Jaccard on the signed state)
    console.log(`===== ${inst}  (${n.toLocaleString()} ${BASE} bars)`);
    console.log("  redundancy vs base rung (agreement on signed state, and Jaccard on 'railed at all'):");
    for (const o of others) {
      let agree = 0, both = 0, either = 0, valid = 0;
      for (let i = 0; i < n; i++) {
        valid++;
        if (baseSt[i] !== 0 && o.aligned[i] !== 0) { both++; if (baseSt[i] === o.aligned[i]) agree++; }
        if (baseSt[i] !== 0 || o.aligned[i] !== 0) either++;
      }
      console.log(`    ${o.tf.padEnd(4)}  both-railed ${(both / valid * 100).toFixed(2)}%   jaccard ${(both / Math.max(1, either) * 100).toFixed(1)}%   sign-agreement when both railed ${(both ? (agree / both * 100).toFixed(1) : "-")}%`);
    }

    // breadth K: how many rungs (including base) share the base rung's sign
    const K = new Int8Array(n);
    for (let i = 0; i < n; i++) {
      if (baseSt[i] === 0) { K[i] = 0; continue; }
      let k = 1;
      for (const o of others) if (o.aligned[i] === baseSt[i]) k++;
      K[i] = k;
    }
    const dist = {};
    for (let i = 0; i < n; i++) if (baseSt[i] !== 0) dist[K[i]] = (dist[K[i]] || 0) + 1;
    const railed = Object.values(dist).reduce((a, b) => a + b, 0);
    console.log(`  breadth distribution GIVEN base railed (n=${railed.toLocaleString()}): ` +
      Object.keys(dist).sort((a, b) => a - b).map((k) => `K=${k}:${dist[k]} (${(dist[k] / railed * 100).toFixed(1)}%)`).join("  "));

    // Does breadth add anything given the base is railed? Directional return = sign * fwd move.
    console.log("   H   bucket        n      mean dir-return(ATR)    p vs K=1");
    for (const H of HORIZONS) {
      const ret = new Array(n).fill(NaN);
      for (let i = 0; i < n - H; i++) { const a = atr[i]; if (Number.isFinite(a) && a > 0) ret[i] = (base[i + H].c - base[i].c) / a; }
      const buckets = { "K=1 (base only)": [], "K=2-3": [], "K>=4": [] };
      const idxOf = { "K=1 (base only)": [], "K=2-3": [], "K>=4": [] };
      for (let i = 0; i < n; i++) {
        if (baseSt[i] === 0 || !Number.isFinite(ret[i])) continue;
        const dr = baseSt[i] * ret[i]; // directional: + means the rail's direction paid
        const b = K[i] === 1 ? "K=1 (base only)" : K[i] <= 3 ? "K=2-3" : "K>=4";
        buckets[b].push(dr); idxOf[b].push(i);
      }
      const m1 = buckets["K=1 (base only)"];
      for (const [name, arr] of Object.entries(buckets)) {
        if (arr.length < 30) { console.log(`   ${String(H).padStart(2)}  ${name.padEnd(15)}${String(arr.length).padStart(5)}   (n<30)`); continue; }
        const mu = arr.reduce((a, b) => a + b, 0) / arr.length;
        let p = "-";
        if (name !== "K=1 (base only)" && m1.length >= 30) {
          const obs = mu - m1.reduce((a, b) => a + b, 0) / m1.length;
          const pool = [...idxOf[name].map((i) => ({ v: baseSt[i] * ret[i], hi: 1 })), ...idxOf["K=1 (base only)"].map((i) => ({ v: baseSt[i] * ret[i], hi: 0 }))];
          const rng = rngf(1717 + H);
          let ge = 0;
          for (let s = 0; s < SHIFTS; s++) {
            const off = 1 + Math.floor(rng() * (pool.length - 2));
            let sa = 0, na = 0, sb = 0, nb = 0;
            for (let i = 0; i < pool.length; i++) {
              const lab = pool[(i + off) % pool.length].hi;
              if (lab) { sa += pool[i].v; na++; } else { sb += pool[i].v; nb++; }
            }
            if (na && nb && Math.abs(sa / na - sb / nb) >= Math.abs(obs)) ge++;
          }
          p = (ge / SHIFTS).toFixed(4);
        }
        console.log(`   ${String(H).padStart(2)}  ${name.padEnd(15)}${String(arr.length).padStart(5)}${mu.toFixed(4).padStart(20)}${String(p).padStart(12)}${p !== "-" && Number(p) < 0.05 ? " *" : ""}`);
      }
    }
    console.log("");
  }
}

main().catch((e) => { console.error("Fatal:", e); process.exit(1); });
