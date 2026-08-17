#!/usr/bin/env node
// STRUCTURAL TEMPLATE MATCHER -- multi-timeframe, multi-event-type, spatially-constrained chains.
//
// WHY THIS EXISTS AND WHY NOTHING IN THE REGISTER COVERS IT. Three prior mechanisms combined
// signals, and none of them is this:
//   #137  co-occurrence -- the SAME event type across rungs, SIMULTANEOUSLY. Breadth works.
//   #135  cascade -- ordered, but still one event family.
//   #166  sequence -- ordering WITHIN one family (enter vs exit, ordinal position). Null.
// **What is untested is a HETEROGENEOUS TEMPLATE: different event types, on different timeframes,
// in a specific SPATIAL arrangement -- "a bearish OB ABOVE a bullish BOS", "a bullish OB AT OR
// UNDER the swing line". Nothing in this project encodes spatial relations between different event
// types at all, so #166's null does not apply here.** That distinction is the whole point; treating
// #166 as having closed this would repeat the C-1 over-generalisation error.
//
// THE OVERFITTING DANGER, STATED BEFORE ANY RESULT EXISTS. A multi-step template has many free
// parameters -- which rungs, how much price tolerance, how many bars between steps -- and on nine
// years it will match few instances. That combination is trivially tunable into looking brilliant.
// The guards, fixed here and not adjustable after seeing output:
//   * every window and tolerance is a NAMED CONSTANT declared in this file, not a CLI flag;
//   * the template is defined from iapaulo's OBSERVED instance (21 Jul -> 14 Aug 2026), not
//     discovered by search;
//   * if a template matches n < MIN_N, exactly ONE constraint may be relaxed, declared in advance
//     as RELAX_ORDER below, and only once;
//   * there is NO forward-return stage. #154->#155, #161->#162 and #168->#169 all showed a
//     forward-return contrast failing the R-multiple rebuild, so matched chains go straight to the
//     #143 frozen trade construction.
//
// available_at throughout: a chain is not observable until its LAST element is CONFIRMED, so entry
// is the bar after the final step's confirmation time. Order blocks use `created_time` (when the
// block is confirmed) for timing and `bar_high`/`bar_low` (the origin candle) for geometry -- using
// origin_time for timing would be lookahead.

import { DatabaseSync } from "node:sqlite";
import { loadCandles } from "../../backtest/lib/load-candles.js";
import { FEE_TIERS, REPRESENTATIVE_FUNDING_PCT_PER_HOUR } from "../../backtest/lib/costs.js";
import { dbSuffix } from "../lib/instrument.js";

// ---- #143 frozen trade construction, verbatim ----
const ATR_LEN = 14, ATR_MULT = 2.0, R_MULT = 2, HOLD_BARS = 200;
const SLIP_ENTRY_ATR = 0.05, SLIP_STOP_ATR = 0.15, SLIP_TARGET_ATR = 0;
const TAKER = FEE_TIERS.bitunix_futures_vip1.takerFeePct;
const ITERATIONS = 20000, SEED = 42, MIN_N = 60;

const BASE_TF = "1h";      // the rung iapaulo was reading; timing and entry resolve here
const H = 3600;

// ---- TEMPLATE T1 TOLERANCES -- declared before the scan, not adjustable afterwards ----
const T1 = {
  name: "trapped-break reversal",
  A_tfs: ["1h", "2h"],       // rung(s) carrying the bullish swing BOS
  W_AB_H: 72,                // supply must appear within 3 days of the bullish break
  W_BC_H: 720,               // the decline may take up to 30 days to reach a lower swing break
  W_D_H: 48,                 // penetration must recover within 2 days
  W_E_H: 48,                 // the bullish OB must confirm within 2 days of the recovery
};
// If T1 matches n < MIN_N, relax in THIS order, one step only:
const RELAX_ORDER = ["A_tfs -> add 4h", "W_BC_H -> 1440", "drop the scope=swing requirement on C"];

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

// ---- the matcher ----
function matchT1(ev, obs, base, cfg) {
  const funnel = { A: 0, B: 0, C: 0, D: 0, E: 0 };
  const chains = [];
  const times = base.map((b) => b.t);
  const idxAtOrAfter = (t) => { let lo = 0, hi = times.length - 1, r = -1;
    while (lo <= hi) { const m = (lo + hi) >> 1; if (times[m] >= t) { r = m; hi = m - 1; } else lo = m + 1; } return r; };

  const A_list = ev.filter((e) => e.type === "BOS" && e.side === "bullish" && e.scope === "swing" && cfg.A_tfs.includes(e.timeframe));
  const B_list = obs.filter((o) => o.side === "bearish" && o.scope === "swing");
  const C_list = ev.filter((e) => e.type === "BOS" && e.side === "bearish" && e.scope === "swing");
  const E_list = obs.filter((o) => o.side === "bullish");

  for (const A of A_list) {
    funnel.A++;
    // B: bearish swing OB confirmed after A, within W_AB, whose BODY sits strictly ABOVE A's price
    const B = B_list.find((o) => o.created_time > A.time && o.created_time <= A.time + cfg.W_AB_H * H && o.bar_low > A.price);
    if (!B) continue;
    funnel.B++;
    // C: bearish swing BOS after B, within W_BC, at a price BELOW A -- the break has failed downward
    const C = C_list.find((e) => e.time > B.created_time && e.time <= B.created_time + cfg.W_BC_H * H && e.price < A.price);
    if (!C) continue;
    funnel.C++;
    // D: on the base rung, price penetrates C.price then RECOVERS (closes back above) within W_D
    const start = idxAtOrAfter(C.time);
    if (start < 0) continue;
    let penIdx = -1;
    for (let i = start; i < base.length && base[i].t <= C.time + cfg.W_BC_H * H; i++) {
      if (base[i].l < C.price) { penIdx = i; break; }
    }
    if (penIdx < 0) continue;
    let recIdx = -1;
    for (let i = penIdx; i < base.length && base[i].t <= base[penIdx].t + cfg.W_D_H * H; i++) {
      if (base[i].c > C.price) { recIdx = i; break; }
    }
    if (recIdx < 0) continue;
    funnel.D++;
    // E: bullish OB confirmed AT OR AFTER the recovery, within W_E, sitting AT OR UNDER C's price.
    // BUG FIX 2026-08-17: the original window was recT +/- W_E, which admitted blocks confirmed up
    // to 48h BEFORE the recovery. That contradicts the template's own wording -- the recovery is
    // what PRODUCES the block -- and let through chains whose final element had nothing to do with
    // the preceding steps. available_at was never violated (entry is after both), but the SEMANTICS
    // were wrong, so the pre-fix numbers describe a different pattern than the one declared.
    // This is a correction to make the code match the stated spec, NOT a tolerance change.
    const recT = base[recIdx].t;
    const E = E_list.find((o) => o.created_time >= recT && o.created_time <= recT + cfg.W_E_H * H && o.bar_low <= C.price);
    if (!E) continue;
    funnel.E++;
    // chain completes at the LAST confirmation among the recovery bar and E
    const completeT = Math.max(recT, E.created_time);
    const entryIdx = idxAtOrAfter(completeT + 1);
    if (entryIdx < 0 || entryIdx >= base.length) continue;
    chains.push({ A, B, C, recT, E, completeT, entryIdx });
  }
  // one chain per completion bar -- overlapping A's must not inflate n
  const seen = new Set(); const uniq = [];
  for (const ch of chains.sort((a, b) => a.entryIdx - b.entryIdx)) {
    if (seen.has(ch.entryIdx)) continue;
    seen.add(ch.entryIdx); uniq.push(ch);
  }
  return { chains: uniq, funnel };
}

async function main() {
  console.log("STRUCTURAL TEMPLATE MATCHER -- T1 '" + T1.name + "'");
  console.log("Chain: bullish swing BOS  ->  bearish swing OB ABOVE it  ->  bearish swing BOS BELOW it");
  console.log("       ->  penetrate + recover that line  ->  bullish OB AT OR UNDER it.  Entry: long.");
  console.log(`Tolerances (declared, not adjustable): A on ${T1.A_tfs.join("/")}, W_AB=${T1.W_AB_H}h, W_BC=${T1.W_BC_H}h, W_D=${T1.W_D_H}h, W_E=${T1.W_E_H}h`);
  console.log(`Trade: #143 frozen -- ${R_MULT}R @ ${ATR_MULT}x ATR(${ATR_LEN}), hold<=${HOLD_BARS}, slip ${SLIP_ENTRY_ATR}/${SLIP_STOP_ATR}, taker+funding.`);
  console.log("No forward-return stage. Matched chains go straight to the trade construction.\n");

  for (const inst of ["BTC", "ETH"]) {
    const db = new DatabaseSync(new URL(`../../../data/signal-bus/smc${dbSuffix(inst)}.db`, import.meta.url), { readOnly: true });
    const ev = db.prepare("SELECT timeframe, type, side, scope, price, time FROM structure_events WHERE instrument = ? ORDER BY time").all(inst);
    const obs = db.prepare("SELECT timeframe, side, scope, bar_high, bar_low, created_time, origin_time FROM order_blocks WHERE instrument = ? AND created_time IS NOT NULL ORDER BY created_time").all(inst);
    db.close();

    const base = await loadCandles(BASE_TF, inst);
    const atr = atrSeries(base, ATR_LEN);
    const { chains, funnel } = matchT1(ev, obs, base, T1);

    console.log(`===== ${inst}  (${ev.length.toLocaleString()} structure events, ${obs.length.toLocaleString()} order blocks, ${base.length.toLocaleString()} ${BASE_TF} bars)`);
    console.log(`  funnel:  A ${funnel.A}  ->  B(OB above) ${funnel.B}  ->  C(lower break) ${funnel.C}  ->  D(pen+recover) ${funnel.D}  ->  E(OB under) ${funnel.E}   unique completions: ${chains.length}`);

    if (chains.length) {
      const last = chains[chains.length - 1];
      console.log(`  most recent chain: A ${new Date(last.A.time * 1000).toISOString().slice(0, 16)} @${last.A.price.toFixed(1)} (${last.A.timeframe})` +
        ` | B ${new Date(last.B.created_time * 1000).toISOString().slice(0, 16)} ${last.B.bar_low.toFixed(1)}-${last.B.bar_high.toFixed(1)}` +
        ` | C ${new Date(last.C.time * 1000).toISOString().slice(0, 16)} @${last.C.price.toFixed(1)} (${last.C.timeframe})` +
        ` | recover ${new Date(last.recT * 1000).toISOString().slice(0, 16)}` +
        ` | E ${new Date(last.E.created_time * 1000).toISOString().slice(0, 16)} ${last.E.bar_low.toFixed(1)}-${last.E.bar_high.toFixed(1)}`);
    }

    if (chains.length < MIN_N) {
      console.log(`  n=${chains.length} is below the n>=${MIN_N} floor -> INCONCLUSIVE, not a failure.`);
      console.log(`  Declared relaxation order (one step only): ${RELAX_ORDER.join("  |  ")}\n`);
      continue;
    }

    const taken = [];
    for (const ch of chains) {
      const t = runTrade(base, atr, ch.entryIdx, "long");
      if (t) taken.push({ bar: ch.entryIdx, ...t });
    }
    if (taken.length < MIN_N) { console.log(`  only ${taken.length} tradeable -> INCONCLUSIVE\n`); continue; }
    const obs2 = mean(taken.map((t) => t.net));
    const win = taken.filter((t) => t.won).length / taken.length;

    // null: same count of randomly-timed long entries on the same rung
    const NET = new Float64Array(base.length).fill(NaN);
    for (let i = 0; i < base.length; i++) { const t = runTrade(base, atr, i, "long"); if (t) NET[i] = t.net; }
    const valid = []; for (let i = 0; i < base.length; i++) if (Number.isFinite(NET[i])) valid.push(i);
    const rnd = mulberry32(SEED);
    let ge = 0, nsum = 0;
    for (let k = 0; k < ITERATIONS; k++) {
      let s = 0;
      for (let j = 0; j < taken.length; j++) s += NET[valid[Math.floor(rnd() * valid.length)]];
      const m = s / taken.length; nsum += m;
      if (m >= obs2) ge++;
    }
    const p = ge / ITERATIONS;
    console.log(`  TRADES n=${taken.length}  win ${(win * 100).toFixed(1)}%  net ${(obs2 * 100).toFixed(4)}%/trade   random-entry null ${((nsum / ITERATIONS) * 100).toFixed(4)}%   p=${p.toFixed(4)}${p < 0.05 ? " *" : ""}${obs2 > 0 ? "  [profitable]" : "  [loses]"}\n`);
  }
}

main().catch((e) => { console.error("Fatal:", e); process.exit(1); });
