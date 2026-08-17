#!/usr/bin/env node
// q5 AT A RAIL + ALIGNED LIQUIDITY, AS AN R-MULTIPLE CONSTRUCTION under #143's frozen config.
//
// #168 established two things. First, the correction: #157 tested q1, not q5, so its 29-of-30
// refutation never touched iapaulo's actual claim. Second, the finding: q5 responds OPPOSITELY to
// q1 under the same buyside-liquidity condition -- `q5 at ceiling` + buyside was correct-signed at
// all five horizons on ETH 1h (n=509) with H=3 reaching p=0.0310, while the q1 version went the
// other way in 29 of 30 cells.
//
// #168 also declined to call that validation, for reasons that apply directly here: one significant
// cell in ~35 is what chance gives, BTC did not match ETH, adjacent horizons are overlapping
// windows, and **they were FORWARD RETURNS -- which have inverted under this exact construction
// twice already this session (#154 -> #155, #161 -> #162).** This is that test.
//
// THE TWO SIDES, as named:
//   SHORT -- q5 crosses INTO its ceiling (>=109.9) while price sits 0-2 ATR ABOVE a buyside pool,
//            i.e. the highs have been swept and the yellow line is railed.
//   LONG  -- the mirror: q5 crosses INTO its floor (<=-9.9) while price sits 0-2 ATR BELOW a
//            sellside pool.
//
// **THE MIRROR IS EXPECTED TO BE THIN AND THAT IS DISCLOSED IN ADVANCE, NOT DISCOVERED AFTERWARDS.**
// #147 established that q5 is pinned at its +110 ceiling on ~68% of bars in our port (88.8% live)
// and essentially never reaches its floor -- the floor-pinned series is q6, not q5. So the long side
// may fall below the population floor. If it does, the honest reading is that the mirror is
// UNTESTABLE on this construct, not that it failed, and a ceiling-only result carries the same
// one-sided caveat that sank #162 and #165.
//
// Null: circular shift of event TIMES against per-bar precomputed outcomes, side and count held
// fixed -- it asks whether these particular bars beat randomly-timed entries of the same side.

import { loadCandles } from "../../backtest/lib/load-candles.js";
import { computeBoomHunter } from "./calc.js";
import { computeLiquidityPools } from "../ict/liquidity.js";
import { FEE_TIERS, REPRESENTATIVE_FUNDING_PCT_PER_HOUR } from "../../backtest/lib/costs.js";

// ---- #143 frozen config, verbatim ----
const ATR_LEN = 14, ATR_MULT = 2.0, R_MULT = 2, HOLD_BARS = 200;
const SLIP_ENTRY_ATR = 0.05, SLIP_STOP_ATR = 0.15, SLIP_TARGET_ATR = 0;
const TAKER = FEE_TIERS.bitunix_futures_vip1.takerFeePct;
const ITERATIONS = 20000, SEED = 42, MIN_N = 60;

const CEIL = 109.9, FLOOR = -9.9, SWEEP_ATR = 2.0;
const TFS = ["4h", "1h"];

const mean = (xs) => (xs.length ? xs.reduce((s, x) => s + x, 0) / xs.length : NaN);
function mulberry32(seed) {
  let a = seed >>> 0;
  return function () { a |= 0; a = (a + 0x6d2b79f5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
function atrSeries(c, L) {
  const tr = c.map((x, i) => (i === 0 ? x.h - x.l : Math.max(x.h - x.l, Math.abs(x.h - c[i - 1].c), Math.abs(x.l - c[i - 1].c))));
  const o = new Array(c.length).fill(NaN);
  let s = 0; for (let i = 0; i < L; i++) s += tr[i];
  o[L - 1] = s / L;
  for (let i = L; i < c.length; i++) o[i] = (o[i - 1] * (L - 1) + tr[i]) / L;
  return o;
}
function runTrade(c, atr, idx, side) {
  const a = atr[idx];
  if (!Number.isFinite(a) || a <= 0) return null;
  const risk = ATR_MULT * a;
  const e = side === "long" ? c[idx].o + SLIP_ENTRY_ATR * a : c[idx].o - SLIP_ENTRY_ATR * a;
  const stop = side === "long" ? e - risk : e + risk;
  const tgt = side === "long" ? e + R_MULT * risk : e - R_MULT * risk;
  const end = Math.min(c.length - 1, idx + HOLD_BARS);
  let pnl = null, hours = 0, won = 0;
  for (let j = idx; j <= end; j++) {
    const b = c[j];
    const hs = side === "long" ? b.l <= stop : b.h >= stop;
    const ht = side === "long" ? b.h >= tgt : b.l <= tgt;
    if (hs) { const f = side === "long" ? stop - SLIP_STOP_ATR * a : stop + SLIP_STOP_ATR * a;
      pnl = side === "long" ? (f - e) / e : (e - f) / e; hours = (b.t - c[idx].t) / 3600; won = 0; break; }
    if (ht) { const f = side === "long" ? tgt - SLIP_TARGET_ATR * a : tgt + SLIP_TARGET_ATR * a;
      pnl = side === "long" ? (f - e) / e : (e - f) / e; hours = (b.t - c[idx].t) / 3600; won = 1; break; }
  }
  if (pnl === null) {
    if (end <= idx) return null;
    const b = c[end];
    const f = side === "long" ? b.c - SLIP_ENTRY_ATR * a : b.c + SLIP_ENTRY_ATR * a;
    pnl = side === "long" ? (f - e) / e : (e - f) / e;
    hours = (b.t - c[idx].t) / 3600; won = pnl > 0 ? 1 : 0;
  }
  return { net: pnl - 2 * TAKER - REPRESENTATIVE_FUNDING_PCT_PER_HOUR * Math.max(0, hours), won };
}

async function main() {
  console.log("q5 AT A RAIL + ALIGNED LIQUIDITY -- R-multiple, #143 frozen config.");
  console.log(`${R_MULT}R @ ${ATR_MULT}x ATR(${ATR_LEN}) | hold<=${HOLD_BARS} | MTM | slip ${SLIP_ENTRY_ATR}/${SLIP_STOP_ATR} | taker ${(TAKER * 100).toFixed(3)}% + funding`);
  console.log("SHORT = q5 into ceiling + price above buyside.  LONG = q5 into floor + price below sellside.");
  console.log(`2R breakeven is 33.3% before costs. Population floor n>=${MIN_N}.\n`);

  for (const inst of ["BTC", "ETH"]) {
    for (const tf of TFS) {
      const c = await loadCandles(tf, inst);
      const n = c.length;
      const atr = atrSeries(c, ATR_LEN);
      const { series } = computeBoomHunter(c);
      const q5 = series.q5;
      const { pools } = computeLiquidityPools(c);
      const ps = pools.filter((p) => p.createdBarIdx != null).sort((a, b) => a.createdBarIdx - b.createdBarIdx);

      // liquidity condition per bar, available_at clean
      const near = { buyside: new Uint8Array(n), sellside: new Uint8Array(n) };
      {
        let k = 0; const live = [];
        for (let i = 0; i < n; i++) {
          while (k < ps.length && ps[k].createdBarIdx <= i) live.push(ps[k++]);
          const a = atr[i];
          if (!Number.isFinite(a) || a <= 0) continue;
          const px = c[i].c;
          for (const p of live) {
            const d = p.side === "buyside" ? (px - p.top) / a : (p.bottom - px) / a;
            if (d >= 0 && d <= SWEEP_ATR) near[p.side][i] = 1;
          }
        }
      }

      // precompute both sides at every bar so the null is a lookup
      const NET = { long: new Float64Array(n).fill(NaN), short: new Float64Array(n).fill(NaN) };
      const WON = { long: new Int8Array(n), short: new Int8Array(n) };
      for (let i = 0; i < n; i++) for (const s of ["long", "short"]) {
        const t = runTrade(c, atr, i, s);
        if (t) { NET[s][i] = t.net; WON[s][i] = t.won; }
      }

      const evShort = [], evLong = [];
      for (let i = 1; i < n; i++) {
        if (q5[i] >= CEIL && q5[i - 1] < CEIL && near.buyside[i]) evShort.push(i);
        if (q5[i] <= FLOOR && q5[i - 1] > FLOOR && near.sellside[i]) evLong.push(i);
      }

      console.log(`===== ${inst} ${tf} -- ${n.toLocaleString()} bars`);
      for (const [label, evs, side] of [["SHORT  q5->ceiling + buyside", evShort, "short"],
                                        ["LONG   q5->floor + sellside", evLong, "long"]]) {
        const entries = evs.map((i) => i + 1).filter((e) => e < n && Number.isFinite(NET[side][e]));
        if (entries.length < MIN_N) {
          console.log(`   ${label}   n=${entries.length}  -- below n>=${MIN_N} floor, INCONCLUSIVE (not a failure)`);
          continue;
        }
        const obs = mean(entries.map((e) => NET[side][e]));
        const win = entries.reduce((s, e) => s + WON[side][e], 0) / entries.length;
        const rnd = mulberry32(SEED);
        let ge = 0, nullSum = 0;
        for (let k = 0; k < ITERATIONS; k++) {
          const off = 1 + Math.floor(rnd() * (n - 2));
          let s2 = 0, n2 = 0;
          for (const e of entries) { const v = NET[side][(e + off) % n]; if (Number.isFinite(v)) { s2 += v; n2++; } }
          if (!n2) continue;
          nullSum += s2 / n2;
          if (s2 / n2 >= obs) ge++;
        }
        const p = ge / ITERATIONS;
        console.log(
          `   ${label}   n=${String(entries.length).padStart(5)}  win ${(win * 100).toFixed(1).padStart(5)}%` +
          `  net ${(obs * 100).toFixed(4).padStart(9)}%/trade   null ${((nullSum / ITERATIONS) * 100).toFixed(4).padStart(9)}%   p=${p.toFixed(4)}` +
          `${p < 0.05 ? " *" : ""}${obs > 0 ? "  [profitable]" : "  [loses]"}`,
        );
      }
      console.log("");
    }
  }
}

main().catch((e) => { console.error("Fatal:", e); process.exit(1); });
