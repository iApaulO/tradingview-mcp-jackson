#!/usr/bin/env node
// #154 REBUILT AS AN R-MULTIPLE CONSTRUCTION under #143's frozen configuration.
//
// #154 found that a Boom Hunter BULL signal conditioned on an ACTIVE bullish FVG within 0.5 ATR
// beats the same signal without one, on both instruments, clearing the 0.100% taker round trip.
// That row listed six reasons it was not promotable, and this script addresses the two that a
// backtest can address:
//
//   * #154 was a FORWARD-RETURN study -- no stop, no target, no hold limit, no mark-to-market --
//     so it was not comparable to #138-#145 and could not be read as a strategy result.
//   * Its cost check applied taker fees ONLY, omitting the 0.05/0.15 ATR asymmetric slippage and
//     the funding carry that #142/#143 established as mandatory. BTC 15m cleared by 0.0217pp,
//     which slippage would plausibly erase.
//
// The configuration below is #143's, copied verbatim rather than re-derived, so these numbers sit
// on the same footing as #143/#145. **Nothing here is swept.** The one structural difference from
// #143 is the trigger: clusters there, Boom Hunter signals here. The zone remains a CONDITION.
//
// THE BEAR SIDE IS THE POINT OF THIS RUN AS MUCH AS THE COSTS. #154's mirror was weak -- 1 of 7
// significant cells -- and every prior row in this session treated a missing mirror as the drift
// signature. That standard does not relax because the result is favourable. A mechanism that only
// works long is either drift or is not the mechanism claimed, so BEAR is reported at equal weight
// and a long-only outcome should be read as a FAILURE of the stated mechanism, not a partial win.
//
// available_at: signal fires at bar i, entry is bar i+1's open. A zone qualifies only if created
// at or before bar i and not ended at or before it.

import { DatabaseSync } from "node:sqlite";
import { loadCandles } from "../../backtest/lib/load-candles.js";
import { FEE_TIERS, REPRESENTATIVE_FUNDING_PCT_PER_HOUR } from "../../backtest/lib/costs.js";
import { dbSuffix } from "../lib/instrument.js";

// ---- #143 frozen config, verbatim ----
const ATR_LEN = 14, ATR_MULT = 2.0, R_MULT = 2, HOLD_BARS = 200;
const SLIP_ENTRY_ATR = 0.05, SLIP_STOP_ATR = 0.15, SLIP_TARGET_ATR = 0;
const TAKER = FEE_TIERS.bitunix_futures_vip1.takerFeePct;
const ITERATIONS = 20000, SEED = 42;
const MIN_N = 60; // #143's population floor

const BAND = 0.5;
const TFS = ["4h", "1h", "15m"];
const BULL_TYPES = ["continuation", "long_blue", "long_lime", "long_enter4", "long_yellow"];
const BEAR_TYPES = ["break_short", "bearish_continuation"];

const mean = (xs) => (xs.length ? xs.reduce((s, x) => s + x, 0) / xs.length : null);
function mulberry32(seed) {
  let a = seed >>> 0;
  return function () { a |= 0; a = (a + 0x6d2b79f5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
function atrSeries(c, length) {
  const tr = c.map((x, i) => (i === 0 ? x.h - x.l : Math.max(x.h - x.l, Math.abs(x.h - c[i - 1].c), Math.abs(x.l - c[i - 1].c))));
  const out = new Array(c.length).fill(NaN);
  if (c.length < length) return out;
  let s = 0; for (let i = 0; i < length; i++) s += tr[i];
  out[length - 1] = s / length;
  for (let i = length; i < c.length; i++) out[i] = (out[i - 1] * (length - 1) + tr[i]) / length;
  return out;
}

function zoneState(candles, atr, zones, dir) {
  const n = candles.length;
  const st = new Int8Array(n);
  const byC = new Map();
  for (const z of zones) {
    if (z.created_bar_idx == null || z.created_bar_idx >= n) continue;
    if (!byC.has(z.created_bar_idx)) byC.set(z.created_bar_idx, []);
    byC.get(z.created_bar_idx).push(z);
  }
  let live = [];
  for (let i = 0; i < n; i++) {
    const add = byC.get(i);
    if (add) live.push(...add);
    if (live.length) live = live.filter((z) => z.end_idx == null || z.end_idx > i);
    const a = atr[i];
    if (!Number.isFinite(a) || a <= 0 || !live.length) continue;
    const px = candles[i].c;
    for (const z of live) {
      const d = dir === "bull" ? (px - z.top) / a : (z.bottom - px) / a;
      if (d >= 0 && d < BAND) { st[i] = 1; break; }
    }
  }
  return st;
}

function runTrade(candles, atr, idx, side) {
  const a = atr[idx];
  if (!Number.isFinite(a) || a <= 0) return null;
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
    if (end <= idx) return null;
    const b = candles[end];
    const fill = side === "long" ? b.c - SLIP_ENTRY_ATR * a : b.c + SLIP_ENTRY_ATR * a;
    pnl = side === "long" ? (fill - entry) / entry : (entry - fill) / entry;
    hours = (b.t - candles[idx].t) / 3600; won = pnl > 0 ? 1 : 0;
  }
  return { net: pnl - 2 * TAKER - REPRESENTATIVE_FUNDING_PCT_PER_HOUR * Math.max(0, hours), won };
}

async function main() {
  console.log("#154 REBUILT AS R-MULTIPLE -- #143 frozen config, full slippage and funding.");
  console.log(`${R_MULT}R @ ${ATR_MULT}x ATR(${ATR_LEN}) | hold<=${HOLD_BARS} | MTM | slip ${SLIP_ENTRY_ATR}/${SLIP_STOP_ATR} ATR | taker ${(TAKER * 100).toFixed(3)}% | funding`);
  console.log("BEAR reported at equal weight: a long-only outcome is a FAILURE of the stated mechanism.\n");

  for (const inst of ["BTC", "ETH"]) {
    const bh = new DatabaseSync(new URL(`../../../data/signal-bus/boom-hunter${dbSuffix(inst)}.db`, import.meta.url), { readOnly: true });
    const ict = new DatabaseSync(new URL(`../../../data/signal-bus/ict${dbSuffix(inst)}.db`, import.meta.url), { readOnly: true });
    for (const tf of TFS) {
      const candles = await loadCandles(tf, inst);
      const atr = atrSeries(candles, ATR_LEN);
      const n = candles.length;
      const idxOf = new Map(candles.map((c, i) => [c.t, i]));
      console.log(`===== ${inst} ${tf}`);

      for (const [fam, types, dir, side] of [["BULL", BULL_TYPES, "bull", "long"], ["BEAR", BEAR_TYPES, "bear", "short"]]) {
        const ph = types.map(() => "?").join(",");
        const sig = [...new Set(bh.prepare(`SELECT DISTINCT time FROM events WHERE timeframe = ? AND instrument = ? AND type IN (${ph})`).all(tf, inst, ...types).map((r) => idxOf.get(r.time)).filter((v) => v !== undefined))].sort((a, b) => a - b);
        const zones = ict.prepare(`SELECT top, bottom, created_bar_idx, broken_bar_idx AS end_idx FROM fvg_zones WHERE timeframe = ? AND instrument = ? AND side = ?`).all(tf, inst, dir === "bull" ? "bullish" : "bearish");
        if (!zones.length || sig.length < MIN_N) { console.log(`  ${fam}: insufficient (${sig.length} signals)`); continue; }
        const st = zoneState(candles, atr, zones, dir);

        // Keep the outcome bound to its signal bar. The null relabels bars, so a parallel
        // (bar, outcome) list is required -- walking two split arrays by index desynchronises
        // as soon as one trade is dropped.
        const taken = [];
        for (const i of sig) {
          const e = i + 1; // entry next bar open
          if (e >= n) continue;
          const t = runTrade(candles, atr, e, side);
          if (!t) continue;
          taken.push({ bar: i, net: t.net, won: t.won });
        }
        const wit = taken.filter((t) => st[t.bar] === 1);
        const wo = taken.filter((t) => st[t.bar] !== 1);
        const stat = (g) => (g.length ? `n=${String(g.length).padStart(5)}  win ${(g.filter((t) => t.won).length / g.length * 100).toFixed(1).padStart(5)}%  net ${(mean(g.map((t) => t.net)) * 100).toFixed(4).padStart(9)}%` : "n=0");
        console.log(`  ${fam} WITH zone     ${stat(wit)}`);
        console.log(`  ${fam} WITHOUT zone  ${stat(wo)}`);
        if (wit.length < MIN_N) { console.log(`  ${fam} -> WITH population ${wit.length} below the n>=${MIN_N} floor: INCONCLUSIVE\n`); continue; }

        // circular-shift null on the zone-state labels, evaluated at the same signal bars
        const obs = mean(wit.map((t) => t.net)) - mean(wo.map((t) => t.net));
        const rnd = mulberry32(SEED);
        let ge = 0;
        // Pure relabelling: outcomes are fixed to their bars, only the zone label moves.
        for (let k = 0; k < ITERATIONS; k++) {
          const off = 1 + Math.floor(rnd() * (n - 2));
          let s1 = 0, n1 = 0, s2 = 0, n2 = 0;
          for (const t of taken) {
            if (st[(t.bar + off) % n] === 1) { s1 += t.net; n1++; } else { s2 += t.net; n2++; }
          }
          if (n1 && n2 && Math.abs(s1 / n1 - s2 / n2) >= Math.abs(obs)) ge++;
        }
        const p = ge / ITERATIONS;
        const pred = "+"; // a helping condition should raise net expectancy on BOTH sides
        const got = obs >= 0 ? "+" : "-";
        console.log(`  ${fam} contrast (WITH - WITHOUT): ${(obs * 100).toFixed(4)}pp   p=${p.toFixed(4)}${p < 0.05 ? " *" : ""}   want ${pred} got ${got}${p < 0.05 && got === pred ? "  <== HOLDS" : ""}\n`);
      }
    }
    bh.close(); ict.close();
  }
}

main().catch((e) => { console.error("Fatal:", e); process.exit(1); });
