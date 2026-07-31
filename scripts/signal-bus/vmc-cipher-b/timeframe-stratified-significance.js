#!/usr/bin/env node
// Tests the one piece of the elite-divergence-trading model not yet checked: "higher timeframe
// divergence is more reliable than lower timeframe" (ARCHITECTURE.md/session discussion,
// 2026-07-31). Everything run so far (forward-return-significance.js, gated-divergence-
// significance.js, confirmation-variants-significance.js) pooled all 8 signal-bus timeframes
// together -- if the real effect concentrates on 4H/1D/1W and 5m/15m are pure noise, pooling would
// dilute a genuine higher-timeframe edge toward the modest, fragile-looking pooled result already
// found. This stratifies the RAW (unfiltered) signal -- the one design that's shown the cleanest
// edge so far -- by timeframe, same forward-return methodology, same baseline discipline.
//
// Usage: node scripts/signal-bus/vmc-cipher-b/timeframe-stratified-significance.js

import { DatabaseSync } from "node:sqlite";
import { loadCandles } from "../../backtest/lib/load-candles.js";

const DB_PATH = new URL("../../../data/signal-bus/vmc-cipher-b.db", import.meta.url);
const FORWARD_BARS = [5, 10, 20, 40];
const LADDER = ["1w", "1d", "4h", "3h", "2h", "1h", "15m", "5m"];

function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function normalCdf(x) {
  const t = 1 / (1 + 0.2316419 * x);
  const d = 0.3989423 * Math.exp((-x * x) / 2);
  const p = d * t * (0.3193815 + t * (-0.3565638 + t * (1.781478 + t * (-1.821256 + t * 1.330274))));
  return 1 - p;
}
function mean(arr) { return arr.reduce((s, x) => s + x, 0) / arr.length; }
function stderr(arr) {
  const m = mean(arr);
  const variance = arr.reduce((s, x) => s + (x - m) ** 2, 0) / (arr.length - 1);
  return Math.sqrt(variance / arr.length);
}
function pctCorrect(arr) { return arr.filter((x) => x > 0).length / arr.length; }

async function main() {
  const db = new DatabaseSync(DB_PATH, { readOnly: true });
  const zones = db.prepare(`SELECT timeframe, side, kind, confirmed_bar_idx FROM zones`).all();
  db.close();

  const byTf = new Map();
  for (const z of zones) { if (!byTf.has(z.timeframe)) byTf.set(z.timeframe, []); byTf.get(z.timeframe).push(z); }

  const rng = mulberry32(42);
  const results = []; // {tf, kind, N, n, mean, pctCorrect, z, p}

  for (const tf of LADDER) {
    const tfZones = byTf.get(tf);
    if (!tfZones || tfZones.length === 0) continue;
    const candles = await loadCandles(tf);
    const n = candles.length;

    for (const kind of ["regular", "hidden"]) {
      const kindZones = tfZones.filter((z) => z.kind === kind);
      const eventReturns = {}; for (const N of FORWARD_BARS) eventReturns[N] = [];
      for (const z of kindZones) {
        const i = z.confirmed_bar_idx;
        if (i < 0 || i >= n) continue;
        for (const N of FORWARD_BARS) {
          if (i + N >= n) continue;
          const raw = (candles[i + N].c - candles[i].c) / candles[i].c;
          eventReturns[N].push(z.side === "bearish" ? -raw : raw);
        }
      }
      const baselineReturns = {}; for (const N of FORWARD_BARS) baselineReturns[N] = [];
      const maxN = Math.max(...FORWARD_BARS);
      for (let s = 0; s < kindZones.length; s++) {
        const i = Math.floor(rng() * (n - maxN - 1));
        const side = rng() < 0.5 ? "bearish" : "bullish";
        for (const N of FORWARD_BARS) {
          const raw = (candles[i + N].c - candles[i].c) / candles[i].c;
          baselineReturns[N].push(side === "bearish" ? -raw : raw);
        }
      }

      for (const N of FORWARD_BARS) {
        const ev = eventReturns[N], base = baselineReturns[N];
        if (ev.length < 30) { results.push({ tf, kind, N, n: ev.length, thin: true }); continue; }
        const evMean = mean(ev), baseMean = mean(base);
        const se = Math.sqrt(stderr(ev) ** 2 + stderr(base) ** 2);
        const z = (evMean - baseMean) / se;
        const p = 2 * (1 - normalCdf(Math.abs(z)));
        results.push({ tf, kind, N, n: ev.length, mean: evMean, pctCorrect: pctCorrect(ev), z, p });
      }
    }
  }

  for (const kind of ["regular", "hidden"]) {
    console.log(`\n=== ${kind.toUpperCase()} divergence, by timeframe (higher TF first) ===`);
    for (const tf of LADDER) {
      const rows = results.filter((r) => r.tf === tf && r.kind === kind);
      if (rows.length === 0) continue;
      console.log(`  ${tf}:`);
      for (const r of rows) {
        if (r.thin) { console.log(`    N=${String(r.N).padEnd(3)}: n=${r.n} (too thin to test)`); continue; }
        console.log(`    N=${String(r.N).padEnd(3)}: n=${String(r.n).padEnd(6)} mean=${(r.mean * 100).toFixed(3)}%  correct-dir=${(r.pctCorrect * 100).toFixed(1)}%  z=${r.z.toFixed(2)}  p=${r.p.toFixed(4)} ${r.p < 0.05 ? "(significant)" : ""}`);
      }
    }
  }
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
