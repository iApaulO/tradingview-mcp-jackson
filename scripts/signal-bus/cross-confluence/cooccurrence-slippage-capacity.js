#!/usr/bin/env node
// SLIPPAGE AND CAPACITY MODELLING for the K>=3 co-occurrence construction.
//
// WHY. #141 refuted the survivorship explanation for the 66-76% win rates (hold-limit sweep flat
// 50->800 bars, mark-to-market identical to drop) and named slippage as the most likely remaining
// inflator, for a specific reason: a K>=3 cluster REQUIRES three or more rungs to break structure
// inside one window, which should concentrate entries in volatile periods -- exactly when real
// slippage is worst. Everything so far has costed at a flat taker fee only.
//
// That concentration was ASSERTED, not measured. Test 1 measures it before anything is built on it.
//
// ASYMMETRIC SLIPPAGE, which is the point of this script. Modelling one flat number would miss
// where this construction is actually exposed:
//   ENTRY  -- market order into a move that three timeframes just confirmed. Slipped.
//   STOP   -- market order triggered BY an adverse move, i.e. the worst possible moment to be
//             crossing the spread. Slipped hardest. With a 66-76% win rate roughly a quarter to a
//             third of trades exit this way, so this term matters more than its frequency suggests.
//   TARGET -- a resting limit order at a known price. Modelled as NO slippage, which is generous;
//             it ignores queue position and partial fills.
// Slippage is expressed as a fraction of ATR at entry rather than a fixed bps, so it scales with
// the volatility regime each trade actually sits in -- which is the whole concern being tested.
//
// CAPACITY is reported as trades/year plus the entry bar's volume percentile, since without L2
// depth (EEH-CITI-1.0 Priority 4, not acquired) true market impact cannot be modelled. Volume
// percentile is a proxy and is labelled as one.
//
// Usage: node scripts/signal-bus/cross-confluence/cooccurrence-slippage-capacity.js
//        [--r=2] [--atr-mult=2.0] [--hold=200]

import { writeFileSync, mkdirSync } from "fs";
import { loadCandles } from "../../backtest/lib/load-candles.js";
import { FEE_TIERS, REPRESENTATIVE_FUNDING_PCT_PER_HOUR } from "../../backtest/lib/costs.js";
import { loadStructureEvents, buildCooccurrenceClusters } from "./lib/cooccurrence.js";

const args = Object.fromEntries(process.argv.slice(2).filter((a) => a.includes("=")).map((a) => a.replace(/^--/, "").split("=")));
const R_MULT = Number(args.r || "2");
const ATR_MULT = Number(args["atr-mult"] || "2.0");
const HOLD = parseInt(args.hold || "200", 10);
const CLUSTER_MULT = Number(args.mult || "1");
const ATR_LEN = 14;
const TAKER = FEE_TIERS.bitunix_futures_vip1.takerFeePct;

const mean = (xs) => (xs.length ? xs.reduce((s, x) => s + x, 0) / xs.length : null);
function pct(sorted, v) { // percentile rank of v within a sorted array
  let lo = 0, hi = sorted.length;
  while (lo < hi) { const m = (lo + hi) >> 1; if (sorted[m] < v) lo = m + 1; else hi = m; }
  return lo / sorted.length;
}
function atrSeries(candles, length) {
  const tr = candles.map((c, i) => {
    if (i === 0) return c.h - c.l;
    const pc = candles[i - 1].c;
    return Math.max(c.h - c.l, Math.abs(c.h - pc), Math.abs(c.l - pc));
  });
  const out = new Array(candles.length).fill(NaN);
  if (candles.length < length) return out;
  let seed = 0;
  for (let i = 0; i < length; i++) seed += tr[i];
  out[length - 1] = seed / length;
  for (let i = length; i < candles.length; i++) out[i] = (out[i - 1] * (length - 1) + tr[i]) / length;
  return out;
}

// Slippage scenarios as fractions of ATR at entry. 'none' reproduces #138-#141.
const SCENARIOS = [
  { name: "none (as #138-#141)", entry: 0, stop: 0 },
  { name: "light  (0.02/0.05 ATR)", entry: 0.02, stop: 0.05 },
  { name: "moderate (0.05/0.15 ATR)", entry: 0.05, stop: 0.15 },
  { name: "heavy  (0.10/0.30 ATR)", entry: 0.10, stop: 0.30 },
  { name: "severe (0.20/0.50 ATR)", entry: 0.20, stop: 0.50 },
];

async function buildRaw(instrument) {
  const events = loadStructureEvents(instrument);
  const clusters = buildCooccurrenceClusters(events, { mult: CLUSTER_MULT });
  const byRung = new Map();
  for (const c of clusters) {
    if (!byRung.has(c.outcomeRung)) byRung.set(c.outcomeRung, []);
    byRung.get(c.outcomeRung).push(c);
  }

  const trades = [];
  const volPctByRung = new Map(); // for the capacity proxy
  const atrPctAll = new Map();    // rung -> sorted ATR/price series, for the concentration test

  for (const [rung, list] of byRung) {
    const candles = await loadCandles(rung, instrument);
    const atr = atrSeries(candles, ATR_LEN);
    const times = candles.map((x) => x.t);
    // Baseline distributions over ALL bars of this rung.
    const atrRel = [], vols = [];
    for (let i = 0; i < candles.length; i++) {
      if (Number.isFinite(atr[i]) && candles[i].c > 0) atrRel.push(atr[i] / candles[i].c);
      if (Number.isFinite(candles[i].v)) vols.push(candles[i].v);
    }
    atrRel.sort((a, b) => a - b); vols.sort((a, b) => a - b);
    atrPctAll.set(rung, atrRel); volPctByRung.set(rung, vols);

    for (const c of list) {
      let lo = 0, hi = times.length - 1, idx = -1;
      while (lo <= hi) { const m = (lo + hi) >> 1; if (times[m] > c.knownAtTime) { idx = m; hi = m - 1; } else lo = m + 1; }
      if (idx < 0 || idx >= candles.length) continue;
      const a = atr[idx];
      if (!Number.isFinite(a) || a <= 0) continue;
      trades.push({
        K: c.K, rung, idx,
        side: c.direction === "bullish" ? "long" : "short",
        entryRef: candles[idx].o,
        atr: a,
        atrRel: a / candles[idx].c,
        vol: candles[idx].v,
        entryTime: candles[idx].t,
        candles,
      });
    }
  }
  return { trades, atrPctAll, volPctByRung };
}

// Simulate one trade under a given slippage scenario.
function simulate(t, sc) {
  const { candles, idx, side, atr } = t;
  const risk = ATR_MULT * atr;
  // Entry slipped adversely: a long pays up, a short sells down.
  const entry = side === "long" ? t.entryRef + sc.entry * atr : t.entryRef - sc.entry * atr;
  // Stop/target levels are set from the ACTUAL fill, which is how a real order would be placed.
  const stop = side === "long" ? entry - risk : entry + risk;
  const target = side === "long" ? entry + R_MULT * risk : entry - R_MULT * risk;
  const end = Math.min(candles.length - 1, idx + HOLD);
  for (let j = idx; j <= end; j++) {
    const b = candles[j];
    const hitStop = side === "long" ? b.l <= stop : b.h >= stop;
    const hitTarget = side === "long" ? b.h >= target : b.l <= target;
    if (hitStop) {
      // Stop is a market order fired BY the adverse move -- slipped hardest.
      const fill = side === "long" ? stop - sc.stop * atr : stop + sc.stop * atr;
      return { pnl: side === "long" ? (fill - entry) / entry : (entry - fill) / entry, won: 0, hours: (b.t - t.entryTime) / 3600 };
    }
    if (hitTarget) {
      // Resting limit at a known price -- no slippage modelled (generous).
      return { pnl: side === "long" ? (target - entry) / entry : (entry - target) / entry, won: 1, hours: (b.t - t.entryTime) / 3600 };
    }
  }
  if (end <= idx) return null;
  // Mark to market at the hold limit -- a market exit, so slipped like an entry.
  const b = candles[end];
  const fill = side === "long" ? b.c - sc.entry * atr : b.c + sc.entry * atr;
  const pnl = side === "long" ? (fill - entry) / entry : (entry - fill) / entry;
  return { pnl, won: pnl > 0 ? 1 : 0, hours: (b.t - t.entryTime) / 3600 };
}

async function main() {
  const out = { r: R_MULT, atr_mult: ATR_MULT, hold: HOLD, taker: TAKER, instruments: {} };
  console.log(`SLIPPAGE & CAPACITY -- K>=3 co-occurrence, ${R_MULT}R @ ${ATR_MULT}x ATR(${ATR_LEN}), hold<=${HOLD}`);
  console.log(`Taker ${(TAKER * 100).toFixed(3)}% per side. Target exits modelled as resting limits (NO slippage) -- generous.`);

  for (const inst of ["BTC", "ETH"]) {
    const { trades, atrPctAll, volPctByRung } = await buildRaw(inst);
    const k3 = trades.filter((t) => t.K >= 3);
    const k1 = trades.filter((t) => t.K === 1);
    console.log(`\n${"#".repeat(100)}\n## ${inst} -- K>=3 n=${k3.length}, K=1 n=${k1.length}\n${"#".repeat(100)}`);

    // ── TEST 1: is the volatility concentration claim TRUE? ──────────────────────────────
    const volPctOf = (arr) => mean(arr.map((t) => pct(atrPctAll.get(t.rung), t.atrRel)));
    const k3Atr = volPctOf(k3), k1Atr = volPctOf(k1);
    const k3Vol = mean(k3.map((t) => pct(volPctByRung.get(t.rung), t.vol)));
    const k1Vol = mean(k1.map((t) => pct(volPctByRung.get(t.rung), t.vol)));
    console.log(`\nTEST 1 -- volatility/volume concentration (mean percentile of the entry bar within its own rung)`);
    console.log(`  ATR percentile:    K>=3 ${(k3Atr * 100).toFixed(1)}%   K=1 ${(k1Atr * 100).toFixed(1)}%   (50% = a typical bar)`);
    console.log(`  volume percentile: K>=3 ${(k3Vol * 100).toFixed(1)}%   K=1 ${(k1Vol * 100).toFixed(1)}%`);
    console.log(`  -> ${k3Atr > 0.6 ? "CONFIRMED: K>=3 entries sit in elevated-volatility bars, so flat-fee costing is optimistic." : k3Atr > 0.5 ? "MILD: modestly above a typical bar." : "NOT CONFIRMED: entries are not concentrated in high-volatility bars."}`);

    // ── TEST 2: does the edge survive asymmetric slippage? ───────────────────────────────
    console.log(`\nTEST 2 -- edge under asymmetric slippage (entry/stop, as fractions of ATR)`);
    console.log(`  scenario                    n     win%    gross%    net%/trade   vs K=1`);
    const rows = [];
    for (const sc of SCENARIOS) {
      const sim = (arr) => {
        const res = arr.map((t) => ({ t, r: simulate(t, sc) })).filter((x) => x.r);
        const net = res.map((x) => x.r.pnl - 2 * TAKER - REPRESENTATIVE_FUNDING_PCT_PER_HOUR * Math.max(0, x.r.hours));
        return { n: res.length, win: res.filter((x) => x.r.won).length / res.length, gross: mean(res.map((x) => x.r.pnl)), net: mean(net) };
      };
      const a = sim(k3), b = sim(k1);
      console.log(`  ${sc.name.padEnd(24)} ${String(a.n).padStart(5)}  ${(a.win * 100).toFixed(1).padStart(5)}%  ${(a.gross * 100).toFixed(4).padStart(8)}%  ${(a.net * 100).toFixed(4).padStart(10)}%${a.net > 0 ? "  CLEARS" : "  FAILS "}  ${((a.net - b.net) * 100).toFixed(4)}pp`);
      rows.push({ scenario: sc.name, ...a, k1_net_pct: b.net * 100, gap_pp: (a.net - b.net) * 100 });
    }

    // ── TEST 3: capacity ────────────────────────────────────────────────────────────────
    const span = (Math.max(...k3.map((t) => t.entryTime)) - Math.min(...k3.map((t) => t.entryTime))) / (365.25 * 86400);
    const byRung = {};
    for (const t of k3) byRung[t.rung] = (byRung[t.rung] || 0) + 1;
    console.log(`\nTEST 3 -- capacity`);
    console.log(`  ${k3.length} trades over ${span.toFixed(1)} years = ${(k3.length / span).toFixed(1)} trades/year`);
    console.log(`  rung distribution: ${Object.entries(byRung).sort((a, b) => b[1] - a[1]).map(([r, n]) => `${r}:${n}`).join("  ")}`);
    console.log(`  NOTE: true market impact needs L2 depth (EEH-CITI-1.0 Priority 4, not acquired). Volume percentile above is a proxy only.`);

    out.instruments[inst] = { k3_n: k3.length, atr_pct_k3: k3Atr, atr_pct_k1: k1Atr, vol_pct_k3: k3Vol, vol_pct_k1: k1Vol, scenarios: rows, trades_per_year: k3.length / span, rung_distribution: byRung };
  }

  const RESULTS_DIR = new URL("results/", import.meta.url);
  mkdirSync(RESULTS_DIR, { recursive: true });
  const fname = `cooccurrence_slippage_capacity_${new Date().toISOString().replace(/[:.]/g, "-")}.json`;
  writeFileSync(new URL(fname, RESULTS_DIR), JSON.stringify({ generated_at: new Date().toISOString(), ...out }, null, 2));
  console.log(`\nSaved: ${new URL(fname, RESULTS_DIR).pathname.replace(/^\/([A-Z]:)/, "$1")}`);
}

main().catch((err) => { console.error("Fatal:", err); process.exit(1); });
