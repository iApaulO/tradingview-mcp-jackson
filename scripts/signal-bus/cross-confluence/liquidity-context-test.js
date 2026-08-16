#!/usr/bin/env node
// Does a K>=3 co-occurrence cluster do better when it is travelling TOWARD untapped liquidity?
//
// WHY THIS FORM AND NOT INTEGRATION. #150 blocked the obvious route. Rule (a) -- letting liquidity
// fill an empty rung inside the cluster -- needs a DIRECTIONAL liquidity event, which forces the
// pool BREAK encoding, and breaks are 6-8x co-incident with SMC structure events at 100% directional
// agreement: one market event counted twice. Restricting to the subset rule (a) would admit failed
// harder against OTHER rungs (up to 59.9pp excess, p=0.0000). Wiring it would have inflated K
// exactly where clusters form and manufactured a fake improvement in the only validated mechanism.
//
// What #148 DID clear is pool CREATION -- independent on both the time axis and the joint
// time-price axis, on both instruments. So the non-redundant content of this construct is WHERE the
// liquidity sits, not when it breaks. This test uses only that: the cluster population, its
// direction and its trade construction are all UNCHANGED, and liquidity enters solely as a
// description of the terrain ahead of an already-formed trade.
//
// **K IS NEVER MODIFIED. `lib/cooccurrence.js` is imported read-only and not touched.** That is the
// whole point -- #137's validated variable keeps its meaning, and this can only ever be a
// conditioning result on top of it, never a redefinition of it.
//
// THE ICT CLAIM BEING TESTED, stated so it can fail: "price runs to liquidity". If true, a cluster
// firing with an untapped pool sitting at or beyond its 2R target should reach that target more
// often -- the pool is a magnet drawing price through the objective. A cluster whose path is
// interrupted by a pool SHORT of target should stall against it and do worse.
//
// AVAILABLE_AT. A pool qualifies only if it was created at or before the entry bar AND is still
// untapped as of that bar (not touched, not broken). A pool that gets swept later is exactly the
// thing being predicted and must not be visible at entry.
//
// Trade construction is #143's frozen configuration, copied rather than re-derived, so the numbers
// are directly comparable to #143/#145. Buckets are compared with a circular-shift null on the
// bucket labels, which preserves both the autocorrelation of the label series and of the returns.

import { loadCandles } from "../../backtest/lib/load-candles.js";
import { FEE_TIERS, REPRESENTATIVE_FUNDING_PCT_PER_HOUR } from "../../backtest/lib/costs.js";
import { loadStructureEvents, buildCooccurrenceClusters } from "./lib/cooccurrence.js";
import { computeLiquidityPools } from "../ict/liquidity.js";

// ---- #143 frozen config, verbatim ----
const CLUSTER_MULT = 1, ATR_LEN = 14, ATR_MULT = 2.0, R_MULT = 2, HOLD_BARS = 200;
const SLIP_ENTRY_ATR = 0.05, SLIP_STOP_ATR = 0.15, SLIP_TARGET_ATR = 0;
const TAKER = FEE_TIERS.bitunix_futures_vip1.takerFeePct;
const ITERATIONS = 20000, SEED = 42;

// Target sits at R_MULT * ATR_MULT = 4.0 ATR from entry. That constant is what defines "short of
// target" vs "at or beyond", so it is derived, not chosen.
const TARGET_ATR = R_MULT * ATR_MULT;
const SEARCH_ATR = 12; // how far ahead to look for a pool at all; beyond this it is not "terrain"

const mean = (xs) => (xs.length ? xs.reduce((s, x) => s + x, 0) / xs.length : null);
function mulberry32(seed) {
  let a = seed >>> 0;
  return function () { a |= 0; a = (a + 0x6d2b79f5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
function atrSeries(candles, length) {
  const tr = candles.map((c, i) => (i === 0 ? c.h - c.l : Math.max(c.h - c.l, Math.abs(c.h - candles[i - 1].c), Math.abs(c.l - candles[i - 1].c))));
  const out = new Array(candles.length).fill(NaN);
  if (candles.length < length) return out;
  let s = 0; for (let i = 0; i < length; i++) s += tr[i];
  out[length - 1] = s / length;
  for (let i = length; i < candles.length; i++) out[i] = (out[i - 1] * (length - 1) + tr[i]) / length;
  return out;
}

async function buildTrades(instrument) {
  const clusters = buildCooccurrenceClusters(loadStructureEvents(instrument), { mult: CLUSTER_MULT });
  const byRung = new Map();
  for (const c of clusters) {
    if (!byRung.has(c.outcomeRung)) byRung.set(c.outcomeRung, []);
    byRung.get(c.outcomeRung).push(c);
  }
  const trades = [];
  for (const [rung, list] of byRung) {
    const candles = await loadCandles(rung, instrument);
    const atr = atrSeries(candles, ATR_LEN);
    const times = candles.map((x) => x.t);
    const { pools } = computeLiquidityPools(candles);
    // Index pools by creation bar for a linear sweep of "what exists yet".
    const poolsSorted = pools.filter((p) => p.createdBarIdx != null).sort((a, b) => a.createdBarIdx - b.createdBarIdx);

    for (const c of list) {
      let lo = 0, hi = times.length - 1, idx = -1;
      while (lo <= hi) { const m = (lo + hi) >> 1; if (times[m] > c.knownAtTime) { idx = m; hi = m - 1; } else lo = m + 1; }
      if (idx < 0 || idx >= candles.length) continue;
      const a = atr[idx];
      if (!Number.isFinite(a) || a <= 0) continue;
      const side = c.direction === "bullish" ? "long" : "short";
      const risk = ATR_MULT * a;
      const entry = side === "long" ? candles[idx].o + SLIP_ENTRY_ATR * a : candles[idx].o - SLIP_ENTRY_ATR * a;
      const stop = side === "long" ? entry - risk : entry + risk;
      const target = side === "long" ? entry + R_MULT * risk : entry - R_MULT * risk;

      const end = Math.min(candles.length - 1, idx + HOLD_BARS);
      let pnl = null, hours = 0, won = 0;
      for (let j = idx; j <= end; j++) {
        const b = candles[j];
        const hitStop = side === "long" ? b.l <= stop : b.h >= stop;
        const hitTarget = side === "long" ? b.h >= target : b.l <= target;
        if (hitStop) {
          const fill = side === "long" ? stop - SLIP_STOP_ATR * a : stop + SLIP_STOP_ATR * a;
          pnl = side === "long" ? (fill - entry) / entry : (entry - fill) / entry;
          hours = (b.t - candles[idx].t) / 3600; won = 0; break;
        }
        if (hitTarget) {
          const fill = side === "long" ? target - SLIP_TARGET_ATR * a : target + SLIP_TARGET_ATR * a;
          pnl = side === "long" ? (fill - entry) / entry : (entry - fill) / entry;
          hours = (b.t - candles[idx].t) / 3600; won = 1; break;
        }
      }
      if (pnl === null) {
        if (end <= idx) continue;
        const b = candles[end];
        const fill = side === "long" ? b.c - SLIP_ENTRY_ATR * a : b.c + SLIP_ENTRY_ATR * a;
        pnl = side === "long" ? (fill - entry) / entry : (entry - fill) / entry;
        hours = (b.t - candles[idx].t) / 3600; won = pnl > 0 ? 1 : 0;
      }
      const net = pnl - 2 * TAKER - REPRESENTATIVE_FUNDING_PCT_PER_HOUR * Math.max(0, hours);

      // ---- LIQUIDITY TERRAIN AHEAD, strictly available_at ----
      // long  -> nearest UNTAPPED BUYSIDE pool whose bottom is above entry
      // short -> nearest UNTAPPED SELLSIDE pool whose top is below entry
      let distAtr = null;
      for (const p of poolsSorted) {
        if (p.createdBarIdx > idx) break;                       // does not exist yet
        if (p.firstTouchBarIdx != null && p.firstTouchBarIdx <= idx) continue; // already tapped
        if (p.brokenBarIdx != null && p.brokenBarIdx <= idx) continue;         // already broken
        if (side === "long") {
          if (p.side !== "buyside" || p.bottom <= entry) continue;
          const d = (p.bottom - entry) / a;
          if (distAtr === null || d < distAtr) distAtr = d;
        } else {
          if (p.side !== "sellside" || p.top >= entry) continue;
          const d = (entry - p.top) / a;
          if (distAtr === null || d < distAtr) distAtr = d;
        }
      }
      const bucket =
        distAtr === null || distAtr > SEARCH_ATR ? "no_pool"
          : distAtr < TARGET_ATR ? "pool_short_of_target"
            : "pool_at_or_beyond";

      trades.push({ K: c.K, rung, entryTime: candles[idx].t, net, won, bucket, distAtr });
    }
  }
  return trades.sort((a, b) => a.entryTime - b.entryTime);
}

// Circular-shift null on bucket labels against the net series.
function shiftTest(pool, labelOf, iterations, seed) {
  const vals = pool.map((t) => t.net);
  const lab = pool.map(labelOf);
  const obs = (() => {
    const A = [], B = [];
    for (let i = 0; i < lab.length; i++) (lab[i] ? A : B).push(vals[i]);
    return A.length && B.length ? mean(A) - mean(B) : null;
  })();
  if (obs === null) return { obs: null, p: null };
  const rnd = mulberry32(seed);
  let ge = 0;
  for (let k = 0; k < iterations; k++) {
    const off = 1 + Math.floor(rnd() * (lab.length - 2));
    const A = [], B = [];
    for (let i = 0; i < lab.length; i++) (lab[(i + off) % lab.length] ? A : B).push(vals[i]);
    if (A.length && B.length && Math.abs(mean(A) - mean(B)) >= Math.abs(obs)) ge++;
  }
  return { obs, p: ge / iterations };
}

async function main() {
  console.log("K>=3 CLUSTERS vs LIQUIDITY TERRAIN AHEAD -- does price run to liquidity?");
  console.log(`#143 frozen construction. Target sits at ${TARGET_ATR.toFixed(1)} ATR; buckets derive from that.`);
  console.log("K is NOT modified. Liquidity is a description of terrain, never a cluster member.\n");

  for (const inst of ["BTC", "ETH", "SOL"]) {
    let trades;
    try { trades = await buildTrades(inst); }
    catch (e) { console.log(`${inst}: ${e.message}\n`); continue; }

    const k3 = trades.filter((t) => t.K >= 3);
    console.log(`##### ${inst} -- ${trades.length.toLocaleString()} trades total, ${k3.length} at K>=3`);
    if (k3.length < 30) { console.log("  (K>=3 population too small)\n"); continue; }

    console.log("  bucket                    n     win%      net%/trade    mean dist(ATR)");
    for (const b of ["no_pool", "pool_short_of_target", "pool_at_or_beyond"]) {
      const g = k3.filter((t) => t.bucket === b);
      if (!g.length) { console.log(`  ${b.padEnd(24)}${String(0).padStart(4)}       --`); continue; }
      const ds = g.map((t) => t.distAtr).filter((d) => d != null);
      console.log(
        `  ${b.padEnd(24)}${String(g.length).padStart(4)}` +
        `${(g.filter((t) => t.won).length / g.length * 100).toFixed(1).padStart(9)}%` +
        `${(mean(g.map((t) => t.net)) * 100).toFixed(4).padStart(15)}%` +
        `${(ds.length ? mean(ds).toFixed(2) : "-").padStart(17)}`,
      );
    }

    // The pre-stated ICT hypothesis: at_or_beyond should beat short_of_target.
    const contrast = k3.filter((t) => t.bucket !== "no_pool");
    if (contrast.length >= 30) {
      const r = shiftTest(contrast, (t) => (t.bucket === "pool_at_or_beyond" ? 1 : 0), ITERATIONS, SEED);
      console.log(`  at_or_beyond MINUS short_of_target: ${r.obs === null ? "n/a" : (r.obs * 100).toFixed(4) + "pp"}  p=${r.p === null ? "n/a" : r.p.toFixed(4)}${r.p !== null && r.p < 0.05 ? " *" : ""}  (n=${contrast.length})`);
    }
    // And the weaker claim: does having ANY untapped pool ahead beat having none?
    const r2 = shiftTest(k3, (t) => (t.bucket !== "no_pool" ? 1 : 0), ITERATIONS, SEED + 1);
    console.log(`  any_pool_ahead MINUS no_pool:       ${r2.obs === null ? "n/a" : (r2.obs * 100).toFixed(4) + "pp"}  p=${r2.p === null ? "n/a" : r2.p.toFixed(4)}${r2.p !== null && r2.p < 0.05 ? " *" : ""}\n`);
  }
}

main().catch((e) => { console.error("Fatal:", e); process.exit(1); });
