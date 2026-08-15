#!/usr/bin/env node
// Two-way validation, same discipline as cipher-b/sanity-check.js:
//   1. q1 at the two real dip points iapaulo pointed at live (BITUNIX:BTCUSDT.P 4h, 24-25jun26)
//      should match what was hand-verified before this file existed: q1=-10.00 at 2026-06-24 16:00,
//      q1=+19.53 at 2026-06-25 12:00 (the real price low, a genuine bullish divergence).
//   2. A "continuation" event should fire in the 30jun-1jul26 window, matching the live "Continuation"
//      label seen on the actual chart.
//
// Usage: node scripts/signal-bus/boom-hunter/sanity-check.js

import { loadCandles } from "../../backtest/lib/load-candles.js";
import { computeBoomHunter } from "./calc.js";

async function main() {
  const candles = await loadCandles("4h");
  const { events, series } = computeBoomHunter(candles);

  function findBar(isoPrefix) {
    return candles.findIndex((c) => new Date(c.t * 1000).toISOString().startsWith(isoPrefix));
  }

  const dip1Idx = findBar("2026-06-24T16:00");
  const dip2Idx = findBar("2026-06-25T12:00");
  console.log(`Dip 1 (2026-06-24 16:00): q1=${series.q1[dip1Idx].toFixed(2)} (expected -10.00)  price=${candles[dip1Idx].c}`);
  console.log(`Dip 2 (2026-06-25 12:00): q1=${series.q1[dip2Idx].toFixed(2)} (expected +19.53)  price low=${candles[dip2Idx].l}`);

  const d1ok = Math.abs(series.q1[dip1Idx] - -10.00) < 0.5;
  const d2ok = Math.abs(series.q1[dip2Idx] - 19.53) < 0.5;
  console.log(`  match: dip1=${d1ok ? "OK" : "MISMATCH"}  dip2=${d2ok ? "OK" : "MISMATCH"}`);

  const windowStart = Date.parse("2026-06-30T00:00:00Z") / 1000;
  const windowEnd = Date.parse("2026-07-02T00:00:00Z") / 1000;
  const continuations = events.filter((e) => e.type === "continuation" && e.time >= windowStart && e.time <= windowEnd);
  console.log(`\nContinuation events 30jun-1jul26: ${continuations.length}`);
  for (const e of continuations) console.log(`  ${new Date(e.time * 1000).toISOString()} price=${e.price} q1=${e.q1.toFixed(2)}`);

  console.log(`\n${events.length.toLocaleString()} total events across full 4h history (${candles.length.toLocaleString()} candles).`);
  const byType = {};
  for (const e of events) byType[e.type] = (byType[e.type] || 0) + 1;
  console.log(byType);
}

main();
