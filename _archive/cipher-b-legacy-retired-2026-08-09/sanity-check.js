#!/usr/bin/env node
// First-pass verification of calc.js against real historical data, same purpose as smc's and
// divergence-for-many's sanity-check.js: are the counts plausible, do example pivots/dates match
// real BTC history, before trusting this enough to build storage/projection on top of it.
//
// 2026-08-08: confirmed against real data two ways -- (1) 0/577 sign-consistency violations
// (every bear/hidden/regular combination has price and oscillator on the expected relative sides),
// (2) independently found the exact 2026-06-06 WT2 extreme (-94.8 here vs -95.1 on live Bitunix
// data, different exchange) that iapaulo had already hand-identified and drawn a line on this
// session -- strong real-world confirmation, not just internal consistency.
//
// Usage: node scripts/signal-bus/cipher-b/sanity-check.js
import { loadCandles } from "../../backtest/lib/load-candles.js";
import { computeCipherBDivergences } from "./calc.js";

const candles = await loadCandles("1d");
console.log(`Loaded ${candles.length} daily candles, ${new Date(candles[0].t * 1000).toISOString().slice(0, 10)} -> ${new Date(candles[candles.length - 1].t * 1000).toISOString().slice(0, 10)}`);

const { divergences } = computeCipherBDivergences(candles);
console.log(`\n${divergences.length} total divergence events (all sources/types)`);

const byKey = {};
for (const d of divergences) {
  const key = `${d.source}_${d.side}_${d.hidden ? "hidden" : "regular"}`;
  byKey[key] = (byKey[key] || 0) + 1;
}
console.log("\nBreakdown:");
console.table(byKey);

console.log("\nLast 15 events (most recent confirm time):");
for (const d of divergences.slice(-15)) {
  const t1 = new Date(d.prevTime * 1000).toISOString().slice(0, 10);
  const t2 = new Date(d.time * 1000).toISOString().slice(0, 10);
  console.log(
    `${d.source.padEnd(6)} ${d.side.padEnd(4)} ${(d.hidden ? "hidden" : "regular").padEnd(8)} ` +
    `${t1} (osc=${d.prevOscVal.toFixed(1)}, px=${d.prevPriceVal.toFixed(0)}) -> ${t2} (osc=${d.oscVal.toFixed(1)}, px=${d.priceVal.toFixed(0)}) ` +
    `slope=${d.slope.toFixed(3)}/bar`
  );
}

// Sanity: every "bear" event should have priceVal/prevPriceVal and oscVal/prevOscVal on the
// EXPECTED opposite sides (regular: price up+osc down; hidden: price down+osc up). Any violation
// here means the port has a sign/comparison bug.
let violations = 0;
for (const d of divergences) {
  const priceUp = d.priceVal > d.prevPriceVal;
  const oscUp = d.oscVal > d.prevOscVal;
  const expected = d.side === "bear"
    ? (d.hidden ? !priceUp && oscUp : priceUp && !oscUp)
    : (d.hidden ? priceUp && !oscUp : !priceUp && oscUp);
  if (!expected) violations++;
}
console.log(`\nSign-consistency check: ${violations} violation(s) out of ${divergences.length} events (expect 0)`);
