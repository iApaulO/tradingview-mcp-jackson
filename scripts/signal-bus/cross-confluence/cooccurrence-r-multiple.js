#!/usr/bin/env node
// R-MULTIPLE CONSTRUCTION on K>=3 co-occurrence clusters, plus out-of-sample and walk-forward.
//
// WHY THIS TEST. #137 found that co-occurrence BREADTH is the informative multi-timeframe variable
// (K>=2 vs K=1 significant rung-stratified on both instruments, p=0.0000, monotonic, with K>=3 at
// +0.7500% BTC / +1.1895% ETH) while ORDER is null once size is controlled. That result clears a
// 0.10% round trip 7-12x -- but it was measured on a FIXED 20-BAR HORIZON WITH NO STOP AND NO
// TARGET, which is not a trade. #132 is the standing warning here: it found full ladder agreement
// had the BEST win rate and the WORST expectancy, a divergence that only appears once you look at
// both, and fixed-horizon returns can behave very differently under an R-multiple exit.
//
// So this converts the finding into an actual construction -- 0.6x ATR(14) stop, fixed R target,
// first touch wins, house convention matching #69/#73/#114 -- costs it at the confirmed venue, and
// then subjects it to the two forward tests that killed #133 (see #134: an in-sample effect at
// p=0.008 across three variants still failed OOS and did not replicate on ETH).
//
// INTRABAR AMBIGUITY, DISCLOSED. When a bar's range spans both stop and target, which was hit first
// is unknowable from OHLC alone. This resolves such bars as STOP-FIRST, the pessimistic choice. It
// is the same convention used elsewhere in this register and it biases results DOWNWARD, so a
// finding that survives it is not an artefact of optimistic fill assumptions.
//
// Usage: node scripts/signal-bus/cross-confluence/cooccurrence-r-multiple.js
//        [--mult=1] [--r=1,1.5,2,3] [--folds=6] [--oos-frac=0.3] [--iterations=20000]

import { writeFileSync, mkdirSync } from "fs";
import { loadCandles } from "../../backtest/lib/load-candles.js";
import { applyCosts, FEE_TIERS, REPRESENTATIVE_FUNDING_PCT_PER_HOUR } from "../../backtest/lib/costs.js";
import { loadStructureEvents, buildCooccurrenceClusters } from "./lib/cooccurrence.js";

const args = Object.fromEntries(process.argv.slice(2).filter((a) => a.includes("=")).map((a) => a.replace(/^--/, "").split("=")));
const MULT = Number(args.mult || "1");
const R_MULTIPLES = (args.r || "1,1.5,2,3").split(",").map(Number);
const FOLDS = parseInt(args.folds || "6", 10);
const OOS_FRAC = parseFloat(args["oos-frac"] || "0.3");
const ITER = parseInt(args.iterations || "20000", 10);
const SEED = parseInt(args.seed || "42", 10);
const ATR_LEN = 14, ATR_MULT = 0.6, MAX_HOLD_BARS = 200;

const costParams = { takerFeePct: FEE_TIERS.bitunix_futures_vip1.takerFeePct, fundingPctPerHour: REPRESENTATIVE_FUNDING_PCT_PER_HOUR };
const mean = (xs) => (xs.length ? xs.reduce((s, x) => s + x, 0) / xs.length : null);

function mulberry32(seed) {
  let a = seed >>> 0;
  return function () { a |= 0; a = (a + 0x6d2b79f5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
function binomTailAtLeast(k, n) {
  const c = (n, r) => { let v = 1; for (let i = 0; i < r; i++) v = (v * (n - i)) / (i + 1); return v; };
  let s = 0; for (let i = k; i <= n; i++) s += c(n, i);
  return s / Math.pow(2, n);
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

// Pessimistic: a bar containing both levels resolves as a stop.
function simulateR(candles, entryIdx, side, stop, target) {
  const end = Math.min(candles.length - 1, entryIdx + MAX_HOLD_BARS);
  for (let j = entryIdx; j <= end; j++) {
    const b = candles[j];
    const hitStop = side === "long" ? b.l <= stop : b.h >= stop;
    const hitTarget = side === "long" ? b.h >= target : b.l <= target;
    if (hitStop) return { exitPrice: stop, exitTime: b.t, won: 0 };
    if (hitTarget) return { exitPrice: target, exitTime: b.t, won: 1 };
  }
  return null; // unresolved inside the hold limit -- dropped, never counted as a win
}

async function buildTrades(instrument, rMultiple) {
  const events = loadStructureEvents(instrument);
  const clusters = buildCooccurrenceClusters(events, { mult: MULT });

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
    for (const c of list) {
      // first bar STRICTLY after the cluster became observable
      let lo = 0, hi = times.length - 1, idx = -1;
      while (lo <= hi) { const m = (lo + hi) >> 1; if (times[m] > c.knownAtTime) { idx = m; hi = m - 1; } else lo = m + 1; }
      if (idx < 0 || idx >= candles.length) continue;
      const a = atr[idx];
      if (!Number.isFinite(a) || a <= 0) continue;
      const side = c.direction === "bullish" ? "long" : "short";
      const entry = candles[idx].o;
      const risk = ATR_MULT * a;
      const stop = side === "long" ? entry - risk : entry + risk;
      const target = side === "long" ? entry + rMultiple * risk : entry - rMultiple * risk;
      const res = simulateR(candles, idx, side, stop, target);
      if (!res) continue;
      const pnlPct = side === "long" ? (res.exitPrice - entry) / entry : (entry - res.exitPrice) / entry;
      trades.push({ K: c.K, order: c.order, rung, side, entryTime: candles[idx].t, exitTime: res.exitTime, pnlPct, won: res.won });
    }
  }
  return trades.sort((a, b) => a.entryTime - b.entryTime);
}

function costedStats(trades) {
  if (!trades.length) return null;
  const costed = applyCosts(trades, costParams).map((t) => t.pnlPct);
  return { n: trades.length, win: trades.filter((t) => t.won).length / trades.length, costed: mean(costed), gross: mean(trades.map((t) => t.pnlPct)) };
}

async function main() {
  const rng = mulberry32(SEED);
  const out = { mult: MULT, r_multiples: R_MULTIPLES, folds: FOLDS, oos_frac: OOS_FRAC, results: {} };

  console.log(`R-MULTIPLE CONSTRUCTION ON CO-OCCURRENCE CLUSTERS -- ${ATR_MULT}x ATR(${ATR_LEN}) stop, fixed R target`);
  console.log(`Costed at bitunix_futures_vip1. Ambiguous bars resolve STOP-FIRST (pessimistic).`);

  for (const inst of ["BTC", "ETH"]) {
    out.results[inst] = {};
    console.log(`\n${"#".repeat(100)}\n## ${inst}\n${"#".repeat(100)}`);
    for (const R of R_MULTIPLES) {
      const all = await buildTrades(inst, R);
      const k1 = all.filter((t) => t.K === 1), k2 = all.filter((t) => t.K === 2), k3 = all.filter((t) => t.K >= 3);
      console.log(`\n--- ${R}R (${all.length.toLocaleString()} resolved trades) ---`);
      console.log(`  group     n       win%    gross%/tr   costed%/tr`);
      for (const [label, g] of [["K=1", k1], ["K=2", k2], ["K>=3", k3]]) {
        const s = costedStats(g);
        if (!s) continue;
        console.log(`  ${label.padEnd(8)} ${String(s.n).padStart(6)}  ${(s.win * 100).toFixed(1).padStart(5)}%  ${(s.gross * 100).toFixed(4).padStart(10)}%  ${(s.costed * 100).toFixed(4).padStart(10)}%${s.costed > 0 ? "  CLEARS" : ""}`);
      }

      if (k3.length >= 60) {
        // OOS split
        const cut = Math.floor(k3.length * (1 - OOS_FRAC));
        const tr = costedStats(k3.slice(0, cut)), te = costedStats(k3.slice(cut));
        console.log(`  K>=3 in-sample 70%: ${(tr.costed * 100).toFixed(4)}% (n=${tr.n})   OUT-OF-SAMPLE 30%: ${(te.costed * 100).toFixed(4)}% (n=${te.n})`);

        // walk-forward folds: sign stability of costed expectancy
        const fsz = Math.floor(k3.length / FOLDS);
        const gaps = [];
        for (let f = 0; f < FOLDS; f++) {
          const slice = k3.slice(f * fsz, f === FOLDS - 1 ? k3.length : (f + 1) * fsz);
          const s = costedStats(slice);
          gaps.push(s ? s.costed : null);
        }
        const usable = gaps.filter((g) => g != null);
        const pos = usable.filter((g) => g > 0).length;
        const pB = usable.length ? binomTailAtLeast(pos, usable.length) : null;
        console.log(`  K>=3 walk-forward: ${gaps.map((g) => (g == null ? "n/a" : `${g > 0 ? "+" : ""}${(g * 100).toFixed(2)}`)).join("  ")}`);
        console.log(`                     ${pos}/${usable.length} folds positive, binomial p=${pB != null ? pB.toFixed(4) + (pB < 0.05 ? "*" : "") : "n/a"}`);

        // K>=3 vs K=1, circular-shift label null over time-ordered trades (#129)
        const pool = [...k3.map((t) => ({ ...t, hi: 1 })), ...k1.map((t) => ({ ...t, hi: 0 }))].sort((a, b) => a.entryTime - b.entryTime);
        const pc = applyCosts(pool, costParams).map((t) => t.pnlPct);
        const lab = pool.map((t) => t.hi);
        const gapOf = (arr) => {
          let sA = 0, nA = 0, sB = 0, nB = 0;
          for (let i = 0; i < arr.length; i++) { if (arr[i]) { sA += pc[i]; nA++; } else { sB += pc[i]; nB++; } }
          return nA && nB ? sA / nA - sB / nB : null;
        };
        const realGap = gapOf(lab);
        let geq = 0;
        for (let k = 0; k < ITER; k++) {
          const off = 1 + Math.floor(rng() * (lab.length - 2));
          const cs = lab.map((_, i) => lab[(i + off) % lab.length]);
          const g = gapOf(cs);
          if (g != null && g >= realGap) geq++;
        }
        const p = geq / ITER;
        console.log(`  K>=3 minus K=1: gap=${(realGap * 100).toFixed(4)}pp  p(circular)=${p.toFixed(4)}${p < 0.05 ? "*" : ""}`);

        out.results[inst][`${R}R`] = {
          k1: costedStats(k1), k2: costedStats(k2), k3: costedStats(k3),
          oos: { in_sample_pct: tr.costed * 100, oos_pct: te.costed * 100, oos_n: te.n },
          folds_pct: gaps.map((g) => (g == null ? null : g * 100)), folds_positive: pos, folds_usable: usable.length, fold_binomial_p: pB,
          k3_vs_k1_gap_pp: realGap * 100, k3_vs_k1_p: p,
        };
      }
    }
  }

  const RESULTS_DIR = new URL("results/", import.meta.url);
  mkdirSync(RESULTS_DIR, { recursive: true });
  const fname = `cooccurrence_r_multiple_${new Date().toISOString().replace(/[:.]/g, "-")}.json`;
  writeFileSync(new URL(fname, RESULTS_DIR), JSON.stringify({ generated_at: new Date().toISOString(), ...out }, null, 2));
  console.log(`\nSaved: ${new URL(fname, RESULTS_DIR).pathname.replace(/^\/([A-Z]:)/, "$1")}`);
}

main().catch((err) => { console.error("Fatal:", err); process.exit(1); });
