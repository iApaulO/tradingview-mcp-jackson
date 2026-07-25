#!/usr/bin/env node
// First-pass verification of calc.js against real historical data, before trusting it enough to
// build touches/storage/the analytics page on top of it. Not a full test suite -- a sanity check
// that pivot/badge/zone counts are in a plausible range and a few examples look right by eye.
//
// Usage: node scripts/signal-bus/divergence-for-many/sanity-check.js --tf=4h

import { loadCandles } from "../../backtest/lib/load-candles.js";
import { computeDivergenceForMany } from "./calc.js";

const args = Object.fromEntries(process.argv.slice(2).map((a) => a.replace(/^--/, "").split("=")));
const TF = args.tf || "4h";

async function main() {
  const candles = await loadCandles(TF);
  console.log(`Loaded ${candles.length.toLocaleString()} ${TF} candles (${new Date(candles[0].t * 1000).toISOString().slice(0, 10)} -> ${new Date(candles[candles.length - 1].t * 1000).toISOString().slice(0, 10)})`);

  const t0 = Date.now();
  const { badges, zones } = computeDivergenceForMany(candles);
  console.log(`Computed in ${((Date.now() - t0) / 1000).toFixed(1)}s\n`);

  console.log(`Badges: ${badges.length} total (${badges.filter((b) => b.side === "bullish").length} bullish, ${badges.filter((b) => b.side === "bearish").length} bearish)`);
  console.log(`Zones (promoted glow levels): ${zones.length} total`);
  console.log(`  bullish: ${zones.filter((z) => z.side === "bullish").length}, bearish: ${zones.filter((z) => z.side === "bearish").length}`);
  const byStatus = {};
  for (const z of zones) byStatus[z.status] = (byStatus[z.status] || 0) + 1;
  console.log(`  status breakdown: ${JSON.stringify(byStatus)}`);

  const durations = zones.filter((z) => z.expiresBarIdx != null).map((z) => z.expiresBarIdx - z.confirmedBarIdx);
  if (durations.length) {
    const avg = durations.reduce((s, x) => s + x, 0) / durations.length;
    console.log(`  avg lifetime (closed zones): ${avg.toFixed(1)} bars (max possible: ${200})`);
  }

  console.log(`\nFirst 5 zones:`);
  for (const z of zones.slice(0, 5)) {
    console.log(`  ${z.side.padEnd(8)} price=${z.price.toFixed(2)} created=${new Date(z.createdTime * 1000).toISOString().slice(0, 16)} confirmed=${new Date(z.confirmedTime * 1000).toISOString().slice(0, 16)} status=${z.status}`);
  }
  console.log(`\nLast 5 zones:`);
  for (const z of zones.slice(-5)) {
    console.log(`  ${z.side.padEnd(8)} price=${z.price.toFixed(2)} created=${new Date(z.createdTime * 1000).toISOString().slice(0, 16)} confirmed=${new Date(z.confirmedTime * 1000).toISOString().slice(0, 16)} status=${z.status}`);
  }

  // Plausibility checks (not assertions -- just flags to eyeball)
  const barsPerZone = candles.length / Math.max(1, zones.length);
  console.log(`\n~1 promoted zone per ${barsPerZone.toFixed(0)} bars.`);
  if (zones.length === 0) console.log("WARNING: zero zones -- likely a bug (threshold/gating never satisfied), not real market behavior.");
  if (badges.length > 0 && zones.length === 0) console.log("WARNING: badges fire but no zones promote -- check the badgeglow_min_reg_divs gate.");
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
