#!/usr/bin/env node
// "PRICE ABOVE BUYSIDE LIQUIDITY + THE BLUE LINE JUMPS TO THE TOP -> BEARISH MOVE"
//
// iapaulo's claim, and the one he asked to be pushed on hardest. Tested as a strict directional
// prediction with a mandatory mirror.
//
// WHICH LINE IS BLUE, resolved from source rather than assumed: `osccol = input.color(color.blue)`
// belongs to the EOT 1 (Main Oscillator) group (Pine line 25) and is applied to q1 at line 369 with
// linewidth 2. **The blue line is q1.** q6 is also blue (line 263) but is the optional "Downward
// Boom Line" gated behind `showdboom`; q3/q4 are red, q5 is yellow. This agrees with #146, which
// already resolved "the blue line fires to the top" as q1 running to its 110 ceiling.
//
// THE MECHANISM IS COHERENT, WHICH IS WHY IT IS WORTH TESTING PROPERLY. Buyside liquidity is a
// cluster of HIGHS. For price to sit ABOVE it, those highs must already have been taken -- a
// liquidity sweep. q1 at its ceiling is extreme overbought. Sweep plus exhaustion is a specific,
// falsifiable reversal setup, and unlike everything in #149-#155 it is a BEARISH claim -- the side
// that has failed in every test this session, which makes it worth more, not less.
//
// WHY THIS IS NOT CLOSED BY #151. That row closed liquidity as a cluster MEMBER (#150) and as
// CONTEXT for an already-formed cluster trade (#151). Neither tested liquidity position as a
// condition on an OSCILLATOR event. Under #154's restatement -- domain 1 is exhausted as a source
// of standalone signals, not as a source of conditions on other domains -- this is open.
//
// DESIGN. Event = q1 crossing UP through TOP_LEVEL (the "jump to the top"). Condition = an existing
// buyside pool whose top sits 0..SWEEP_ATR below the close, i.e. price is above swept highs.
// Outcome = forward return; the claim predicts NEGATIVE. Contrast is WITH-condition minus
// WITHOUT-condition inside the same event family, so the oscillator event is held constant and only
// the liquidity position varies.
//
// THE MIRROR IS MANDATORY AND IS THE REAL TEST: q1 crossing DOWN through BOT_LEVEL with price BELOW
// a sellside pool should be BULLISH. A claim that works in one direction only is the drift signature
// this session has applied to every other row, and #155 is a live example of exactly that failure.
//
// available_at: the pool must be created at or before the event bar. Forward returns start at the
// event bar's close.

import { loadCandles } from "../../backtest/lib/load-candles.js";
import { computeBoomHunter } from "./calc.js";
import { computeLiquidityPools } from "../ict/liquidity.js";

const SHIFTS = 2000;
const HORIZONS = [1, 3, 6, 12, 24];
const TFS = ["4h", "1h", "15m"];
const TOP_LEVEL = 100;   // q1 ceiling is 110; >=100 is "at the top"
const BOT_LEVEL = 0;     // q1 floor is -10; <=0 is "at the bottom"
const SWEEP_ATR = 2.0;   // how far above the swept pool price may sit and still count

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

async function main() {
  console.log('CLAIM: "price above buyside liquidity + the blue line (q1) jumps to the top -> bearish"');
  console.log(`Event: q1 crosses UP through ${TOP_LEVEL}. Condition: a buyside pool 0..${SWEEP_ATR} ATR BELOW the close.`);
  console.log("Mirror (mandatory): q1 crosses DOWN through 0 with a sellside pool above -> bullish.");
  console.log(`Forward return in ATR(14). Circular-shift null on the condition, ${SHIFTS} shifts, two-sided.\n`);

  for (const inst of ["BTC", "ETH"]) {
    for (const tf of TFS) {
      const c = await loadCandles(tf, inst);
      const atr = atr14(c);
      const n = c.length;
      const { series } = computeBoomHunter(c);
      const q1 = series.q1;
      const { pools } = computeLiquidityPools(c);
      const poolsByCreate = pools.filter((p) => p.createdBarIdx != null).sort((a, b) => a.createdBarIdx - b.createdBarIdx);

      console.log(`===== ${inst} ${tf} -- ${n.toLocaleString()} bars`);

      for (const [label, side, predSign] of [["SWEEP-UP  (q1->top, buyside below)", "buyside", "-"],
                                             ["SWEEP-DN  (q1->bottom, sellside above)", "sellside", "+"]]) {
        // events
        const ev = [];
        for (let i = 1; i < n; i++) {
          const up = side === "buyside";
          const crossed = up
            ? q1[i - 1] < TOP_LEVEL && q1[i] >= TOP_LEVEL
            : q1[i - 1] > BOT_LEVEL && q1[i] <= BOT_LEVEL;
          if (crossed) ev.push(i);
        }
        if (ev.length < 60) { console.log(`  ${label}: only ${ev.length} events, skipped`); continue; }

        // condition series: is price sitting beyond a same-side pool, within SWEEP_ATR?
        const cond = new Int8Array(n);
        {
          let k = 0;
          const live = [];
          for (let i = 0; i < n; i++) {
            while (k < poolsByCreate.length && poolsByCreate[k].createdBarIdx <= i) live.push(poolsByCreate[k++]);
            const a = atr[i];
            if (!Number.isFinite(a) || a <= 0) continue;
            const px = c[i].c;
            for (const p of live) {
              if (p.side !== side) continue;
              const d = side === "buyside" ? (px - p.top) / a : (p.bottom - px) / a;
              if (d >= 0 && d <= SWEEP_ATR) { cond[i] = 1; break; }
            }
          }
        }
        const nWith = ev.filter((i) => cond[i] === 1).length;
        console.log(`  ${label}   events=${ev.length}  with=${nWith}  without=${ev.length - nWith}   predicts ${predSign}`);
        if (nWith < 30 || ev.length - nWith < 30) { console.log("     (a bucket is below the n>=30 floor, skipped)\n"); continue; }
        console.log("     H     mean WITH   mean WITHOUT    contrast       p      absolute WITH");
        for (const H of HORIZONS) {
          const ret = new Array(n).fill(NaN);
          for (let i = 0; i < n - H; i++) { const a = atr[i]; if (Number.isFinite(a) && a > 0) ret[i] = (c[i + H].c - c[i].c) / a; }
          let sw = 0, nw = 0, so = 0, no = 0;
          for (const i of ev) { const r = ret[i]; if (!Number.isFinite(r)) continue; if (cond[i] === 1) { sw += r; nw++; } else { so += r; no++; } }
          if (!nw || !no) continue;
          const mw = sw / nw, mo = so / no, obs = mw - mo;
          const rng = rngf(555 + H);
          let ge = 0;
          for (let k2 = 0; k2 < SHIFTS; k2++) {
            const off = 1 + Math.floor(rng() * (n - 2));
            let s1 = 0, n1 = 0, s2 = 0, n2 = 0;
            for (const i of ev) { const r = ret[i]; if (!Number.isFinite(r)) continue; if (cond[(i + off) % n] === 1) { s1 += r; n1++; } else { s2 += r; n2++; } }
            if (n1 && n2 && Math.abs(s1 / n1 - s2 / n2) >= Math.abs(obs)) ge++;
          }
          const p = ge / SHIFTS;
          const got = obs >= 0 ? "+" : "-";
          const absGot = mw >= 0 ? "+" : "-";
          console.log(
            `     ${String(H).padStart(2)}${mw.toFixed(4).padStart(13)}${mo.toFixed(4).padStart(15)}${obs.toFixed(4).padStart(12)}` +
            `${p.toFixed(4).padStart(9)}${p < 0.05 ? "*" : " "}   ${mw.toFixed(4)} (${absGot})` +
            `${p < 0.05 && got === predSign ? "  <== CONTRAST MATCHES" : ""}` +
            `${absGot === predSign ? "  [abs sign OK]" : "  [abs sign WRONG]"}`,
          );
        }
        console.log("");
      }
    }
  }
}

main().catch((e) => { console.error("Fatal:", e); process.exit(1); });
