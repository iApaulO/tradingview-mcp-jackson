#!/usr/bin/env node
// MSS-ENTRY CONSTRUCTION -- iapaulo's entry ("mss seems to be the correct entry") with his criticism
// of #143 taken seriously: "well this would be great if it didnt give up half the trade from the start."
//
// MSS = bullish SWING-scope CHoCH (REFERENTS.md, #185/#205). The 19 Aug instance: MSS @65,474.46,
// price ran ~+14% while #143's construction would have banked 2R and left the rest. So the ENTRY is
// held fixed -- next bar open after the swing CHoCH confirms -- and the EXIT is swept:
//
//   R2   -- #143 frozen: 2R target @ 2.0x ATR stop            (the baseline he is criticising)
//   R3/R4/R6/R8 -- same stop, larger fixed targets
//   STRUCT -- NO target. Exit when the OPPOSITE swing CHoCH (bearish MSS) confirms, else 200-bar
//             mark-to-market. Stop stays at 2.0x ATR -- his complaint was the capped winner, not the
//             disaster stop, and removing the stop is not a discipline anyone should backtest.
//
// Scope decomposition: SWING CHoCH (the MSS) vs INTERNAL CHoCH separately -- #199 tested all CHoCHs
// pooled at ~zero gross, which may have buried a swing-only effect under the noisier internal ones.
//
// INFERENCE PER #204's ADOPTED RULES: per-rung (no 1h+4h pooling), maker costing (#200: maker entry
// -- the MSS entry IS a trigger order -- maker fixed-R targets; taker+0.15 ATR slip stops; taker
// structural/mtm exits), and CLUSTER t alongside naive t (overlapping holds chained into clusters).
//
// BTC/ETH/SOL/XRP on refreshed data (corpus through 2026-08-21). Nothing here is pre-registered;
// in-sample on all instruments; the R-sweep is 6 looks per cell and must be read with that in mind.

import { DatabaseSync } from "node:sqlite";
import { loadCandles } from "../../backtest/lib/load-candles.js";
import { FEE_TIERS, REPRESENTATIVE_FUNDING_PCT_PER_HOUR } from "../../backtest/lib/costs.js";
import { dbSuffix } from "../lib/instrument.js";

const ATR_LEN = 14, ATR_MULT = 2.0, HOLD_BARS = 200, SLIP_STOP_ATR = 0.15;
const TAKER = FEE_TIERS.bitunix_futures_vip1.takerFeePct;
const MAKER = FEE_TIERS.bitunix_futures_vip1.makerFeePct;
const MIN_N = 40;                      // swing events are rare; floor lowered and SAID rather than hidden
const INSTRUMENTS = ["BTC", "ETH", "SOL", "XRP"];
const TFS = ["1h", "4h"];
const R_SWEEP = [2, 3, 4, 6, 8];

const mean = (xs) => (xs.length ? xs.reduce((s, x) => s + x, 0) / xs.length : NaN);
const sd = (xs) => { const m = mean(xs); return Math.sqrt(mean(xs.map((x) => (x - m) ** 2))); };
const tOf = (xs) => { if (xs.length < 2) return NaN; const s = sd(xs) * Math.sqrt(xs.length / (xs.length - 1)); return s > 0 ? mean(xs) / (s / Math.sqrt(xs.length)) : NaN; };

function atrSeries(c, L) {
  const tr = c.map((x, i) => (i === 0 ? x.h - x.l : Math.max(x.h - x.l, Math.abs(x.h - c[i - 1].c), Math.abs(x.l - c[i - 1].c))));
  const o = new Array(c.length).fill(NaN);
  let s = 0; for (let i = 0; i < L; i++) s += tr[i];
  o[L - 1] = s / L;
  for (let i = L; i < c.length; i++) o[i] = (o[i - 1] * (L - 1) + tr[i]) / L;
  return o;
}

// long from idx; exit by fixed R target, structural bar, stop, or timeout. maker entry.
function sim(c, atr, idx, rMult, structExit) {
  if (idx >= c.length) return null;
  const a = atr[idx];
  if (!Number.isFinite(a) || a <= 0) return null;
  const e = c[idx].o, st = e - ATR_MULT * a;
  const tg = rMult ? e + rMult * ATR_MULT * a : Infinity;
  const end = Math.min(c.length - 1, idx + HOLD_BARS);
  for (let j = idx; j <= end; j++) {
    const b = c[j];
    if (b.l <= st) {
      const raw = (st - SLIP_STOP_ATR * a - e) / e;
      return { net: raw - MAKER - TAKER - fund(c, idx, j), entry: idx, exit: j, won: 0 };
    }
    if (b.h >= tg) {
      const raw = (tg - e) / e;
      return { net: raw - 2 * MAKER - fund(c, idx, j), entry: idx, exit: j, won: 1 };
    }
    if (structExit && structExit.has(j) && j > idx) {
      const raw = (b.c - e) / e;                      // exit at the close that confirms the opposite MSS
      return { net: raw - MAKER - TAKER - fund(c, idx, j), entry: idx, exit: j, won: raw > 0 ? 1 : 0 };
    }
  }
  if (end <= idx) return null;
  const raw = (c[end].c - e) / e;
  return { net: raw - MAKER - TAKER - fund(c, idx, end), entry: idx, exit: end, won: raw > 0 ? 1 : 0 };
}
const fund = (c, i, j) => REPRESENTATIVE_FUNDING_PCT_PER_HOUR * Math.max(0, (c[j].t - c[i].t) / 3600);

function clusters(trades) {
  const out = []; let cur = [];
  for (const t of [...trades].sort((a, b) => a.entry - b.entry)) {
    if (cur.length && t.entry <= cur[cur.length - 1].exit) cur.push(t);
    else { if (cur.length) out.push(mean(cur.map((x) => x.net))); cur = [t]; }
  }
  if (cur.length) out.push(mean(cur.map((x) => x.net)));
  return out;
}

async function main() {
  console.log("MSS ENTRY (bullish SWING CHoCH, next bar open, maker) -- EXIT SWEEP.");
  console.log("His criticism: the 2R cap gives up the trade. Entry fixed, exit varied. Per-rung, cluster t.");
  console.log(`Stop 2.0x ATR(${ATR_LEN}) in every arm. STRUCT = hold until the OPPOSITE swing CHoCH confirms.`);
  console.log(`Population floor n>=${MIN_N} (swing events are rare; the lowered floor is stated, not hidden).\n`);

  for (const tf of TFS) {
    for (const scope of ["swing", "internal"]) {
      // gather trades per arm across instruments (kept per-instrument for clustering)
      const arms = {};
      let nEvents = 0;
      for (const inst of INSTRUMENTS) {
        const c = await loadCandles(tf, inst);
        if (c.length < 1000) continue;
        const atr = atrSeries(c, ATR_LEN);
        const idxOf = new Map(c.map((x, i) => [x.t, i]));
        const db = new DatabaseSync(new URL(`../../../data/signal-bus/smc${dbSuffix(inst)}.db`, import.meta.url), { readOnly: true });
        const longs = db.prepare("SELECT time FROM structure_events WHERE timeframe=? AND instrument=? AND type='CHOCH' AND side='bullish' AND scope=? ORDER BY time")
          .all(tf, inst, scope).map((r) => idxOf.get(r.time)).filter((v) => v !== undefined);
        const opp = new Set(db.prepare("SELECT time FROM structure_events WHERE timeframe=? AND instrument=? AND type='CHOCH' AND side='bearish' AND scope=? ORDER BY time")
          .all(tf, inst, scope).map((r) => idxOf.get(r.time)).filter((v) => v !== undefined));
        db.close();
        nEvents += longs.length;
        for (const i of longs) {
          for (const r of R_SWEEP) {
            const t = sim(c, atr, i + 1, r, null);
            if (t) (arms[`R${r}`] ??= []).push({ ...t, series: inst });
          }
          const t = sim(c, atr, i + 1, null, opp);
          if (t) (arms["STRUCT"] ??= []).push({ ...t, series: inst });
        }
      }
      console.log(`===== ${tf}  ${scope.toUpperCase()} bullish CHoCH${scope === "swing" ? "  (THE MSS)" : ""}   events ${nEvents}`);
      console.log("    exit        n    win%   net%/trade   naive t   clusters  cl-net%    CLUSTER t");
      for (const k of [...R_SWEEP.map((r) => `R${r}`), "STRUCT"]) {
        const g = arms[k] || [];
        if (g.length < MIN_N) { console.log(`    ${k.padEnd(7)}${String(g.length).padStart(6)}   below n>=${MIN_N}`); continue; }
        const nets = g.map((x) => x.net);
        const cl = [];
        for (const inst of INSTRUMENTS) cl.push(...clusters(g.filter((x) => x.series === inst)));
        console.log(
          `    ${k.padEnd(7)}${String(g.length).padStart(6)}${((g.filter((x) => x.won).length / g.length) * 100).toFixed(1).padStart(8)}%` +
          `${(mean(nets) * 100).toFixed(4).padStart(12)}%${tOf(nets).toFixed(2).padStart(9)}${String(cl.length).padStart(10)}` +
          `${(mean(cl) * 100).toFixed(4).padStart(10)}%${tOf(cl).toFixed(2).padStart(11)}`);
      }
      console.log("");
    }
  }
  console.log("HIS CLAIM HOLDS if a larger-R or STRUCT exit beats R2 on the SWING rows with a defensible");
  console.log("cluster t. The R-sweep is 6 looks per cell -- a single marginal winner among them is noise.");
}

main().catch((e) => { console.error("Fatal:", e); process.exit(1); });
