#!/usr/bin/env node
// The causal claim behind a WT divergence is momentum exhaustion PRECEDING reversal -- that's a
// forward-looking prediction about what price does in the bars right after the signal, not a
// support/resistance claim about whether price defends that exact level whenever it's revisited
// (which is what kind-confluence-significance.js actually tested, borrowing the level/touch
// framing wholesale from Divergence-for-Many and SMC). Prompted directly by iapaulo (2026-07-31):
// "it is not logical that you can find no value in divergence when it is a causal mechanism of the
// market" -- correct call; the null result on hold-rate doesn't test that claim at all. This does.
//
// Test: for each divergence event (side, kind), forward return over N bars from the confirmation
// bar. "Directionally correct" = bearish divergence followed by a DOWN move, bullish by an UP
// move. Compared against a baseline of the same number of RANDOMLY sampled bars on the same
// timeframe (same forward-N window, same directional test applied with a coin-flip assumption) --
// not just "50%," since raw up/down base rates drift with the actual trend regime in this data
// (mostly-uptrending BTC history), which would bias a naive 50% comparison.
//
// Usage: node scripts/signal-bus/vmc-cipher-b/forward-return-significance.js --iterations=5000

import { DatabaseSync } from "node:sqlite";
import { loadCandles } from "../../backtest/lib/load-candles.js";

const DB_PATH = new URL("../../../data/signal-bus/vmc-cipher-b.db", import.meta.url);
const FORWARD_BARS = [5, 10, 20];
const LADDER = ["1w", "1d", "4h", "3h", "2h", "1h", "15m", "5m"];

const args = Object.fromEntries(process.argv.slice(2).map((a) => a.replace(/^--/, "").split("=")));
const ITERATIONS = parseInt(args.iterations || "5000", 10);
const SEED = parseInt(args.seed || "42", 10);

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

async function main() {
  const db = new DatabaseSync(DB_PATH, { readOnly: true });
  const zones = db.prepare(`SELECT timeframe, side, kind, confirmed_bar_idx FROM zones`).all();
  db.close();

  const byTf = new Map();
  for (const z of zones) { if (!byTf.has(z.timeframe)) byTf.set(z.timeframe, []); byTf.get(z.timeframe).push(z); }

  // signedReturn: positive = price moved in the direction the divergence predicted.
  const eventReturns = { regular: {}, hidden: {} }; // [kind][N] -> array of signed returns
  const baselineReturns = { regular: {}, hidden: {} };
  for (const kind of ["regular", "hidden"]) for (const N of FORWARD_BARS) { eventReturns[kind][N] = []; baselineReturns[kind][N] = []; }

  const rng = mulberry32(SEED);

  for (const tf of LADDER) {
    const tfZones = byTf.get(tf);
    if (!tfZones || tfZones.length === 0) continue;
    const candles = await loadCandles(tf);
    const n = candles.length;

    for (const z of tfZones) {
      const i = z.confirmed_bar_idx;
      if (i < 0 || i >= n) continue;
      for (const N of FORWARD_BARS) {
        if (i + N >= n) continue;
        const raw = (candles[i + N].c - candles[i].c) / candles[i].c;
        const signed = z.side === "bearish" ? -raw : raw; // positive = correct direction
        eventReturns[z.kind][N].push(signed);
      }
    }

    // Baseline: for EACH kind, sample the same number of random bars on this timeframe (any bar
    // with enough forward room), assign a RANDOM side (bearish/bullish, 50/50) the same way a
    // real event has a side, so the baseline experiences the same trend-regime drift a real event
    // would, without any directional prediction of its own.
    for (const kind of ["regular", "hidden"]) {
      const kindZonesOnTf = tfZones.filter((z) => z.kind === kind).length;
      for (let s = 0; s < kindZonesOnTf; s++) {
        const maxN = Math.max(...FORWARD_BARS);
        const i = Math.floor(rng() * (n - maxN - 1));
        const side = rng() < 0.5 ? "bearish" : "bullish";
        for (const N of FORWARD_BARS) {
          const raw = (candles[i + N].c - candles[i].c) / candles[i].c;
          const signed = side === "bearish" ? -raw : raw;
          baselineReturns[kind][N].push(signed);
        }
      }
    }
  }

  function mean(arr) { return arr.reduce((s, x) => s + x, 0) / arr.length; }
  function stderr(arr) {
    const m = mean(arr);
    const variance = arr.reduce((s, x) => s + (x - m) ** 2, 0) / (arr.length - 1);
    return Math.sqrt(variance / arr.length);
  }
  function pctCorrect(arr) { return arr.filter((x) => x > 0).length / arr.length; }

  console.log("=== Forward-return test: does divergence predict the direction it implies? ===\n");
  for (const kind of ["regular", "hidden"]) {
    console.log(`--- ${kind} divergence ---`);
    for (const N of FORWARD_BARS) {
      const ev = eventReturns[kind][N];
      const base = baselineReturns[kind][N];
      const evMean = mean(ev), baseMean = mean(base);
      const evPct = pctCorrect(ev), basePct = pctCorrect(base);
      // Two-sample z-test on the mean signed return (event vs. baseline)
      const se = Math.sqrt(stderr(ev) ** 2 + stderr(base) ** 2);
      const z = (evMean - baseMean) / se;
      // two-sided p from a normal approximation (n is large -- thousands to tens of thousands per cell)
      const p = 2 * (1 - normalCdf(Math.abs(z)));
      console.log(
        `  N=${String(N).padEnd(3)} bars: event mean=${(evMean * 100).toFixed(3)}% (${(evPct * 100).toFixed(1)}% correct-direction, n=${ev.length})  ` +
        `baseline mean=${(baseMean * 100).toFixed(3)}% (${(basePct * 100).toFixed(1)}%, n=${base.length})  ` +
        `z=${z.toFixed(2)} p=${p.toFixed(4)} ${p < 0.05 ? "(significant)" : "(NOT significant)"}`,
      );
    }
    console.log();
  }
}

// Standard normal CDF via the Abramowitz-Stegun approximation (sufficient precision for a p-value here).
function normalCdf(x) {
  const t = 1 / (1 + 0.2316419 * x);
  const d = 0.3989423 * Math.exp((-x * x) / 2);
  const p = d * t * (0.3193815 + t * (-0.3565638 + t * (1.781478 + t * (-1.821256 + t * 1.330274))));
  return 1 - p;
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
