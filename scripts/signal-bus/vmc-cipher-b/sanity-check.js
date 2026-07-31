#!/usr/bin/env node
// Quick sanity check on calc.js before committing to the full 8-timeframe build: sane zone
// counts, no NaN prices, regular/hidden split looks plausible, hold-rate isn't absurd.
//
// Usage: node scripts/signal-bus/vmc-cipher-b/sanity-check.js [timeframe=4h]

import { loadCandles } from "../../backtest/lib/load-candles.js";
import { computeVmcCipherB } from "./calc.js";
import { computeAllTouches } from "./touches.js";

async function main() {
  const tf = process.argv[2] || "4h";
  const candles = await loadCandles(tf);
  console.log(`${tf}: ${candles.length.toLocaleString()} candles, ${candles[0].t} -> ${candles[candles.length - 1].t}`);

  const { zones } = computeVmcCipherB(candles);
  console.log(`zones: ${zones.length}`);

  const badPrice = zones.filter((z) => !Number.isFinite(z.price));
  console.log(`bad prices: ${badPrice.length}`);

  const bySide = { bullish: 0, bearish: 0 };
  const byKind = { regular: 0, hidden: 0 };
  for (const z of zones) { bySide[z.side]++; byKind[z.kind]++; }
  console.log("by side:", bySide);
  console.log("by kind:", byKind);

  console.log("\nfirst 5 zones:", JSON.stringify(zones.slice(0, 5), null, 2));
  console.log("\nlast 5 zones:", JSON.stringify(zones.slice(-5), null, 2));

  computeAllTouches(candles, zones);
  const withTouches = zones.filter((z) => z.touches.length > 0).length;
  const totalTouches = zones.reduce((s, z) => s + z.touches.length, 0);
  console.log(`\nzones with >=1 touch: ${withTouches}/${zones.length}, total touches: ${totalTouches}`);

  const heldCount = zones.reduce((s, z) => s + z.touches.filter((t) => t.outcome === "held").length, 0);
  console.log(`overall hold rate: ${((heldCount / totalTouches) * 100).toFixed(1)}% (n=${totalTouches})`);

  const regularTouches = zones.filter((z) => z.kind === "regular").flatMap((z) => z.touches);
  const hiddenTouches = zones.filter((z) => z.kind === "hidden").flatMap((z) => z.touches);
  const holdRate = (arr) => arr.length ? (arr.filter((t) => t.outcome === "held").length / arr.length * 100).toFixed(1) : "n/a";
  console.log(`regular-kind hold rate: ${holdRate(regularTouches)}% (n=${regularTouches.length})`);
  console.log(`hidden-kind hold rate: ${holdRate(hiddenTouches)}% (n=${hiddenTouches.length})`);
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
