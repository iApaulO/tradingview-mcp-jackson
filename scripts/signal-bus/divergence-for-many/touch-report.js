#!/usr/bin/env node
// Verification pass for touches.js: runs calc.js + touch detection together and reports the
// aggregate stats plus a couple of full example narratives, so the interaction logic can be
// eyeballed before it's trusted enough to store/build a page on.
//
// Usage: node scripts/signal-bus/divergence-for-many/touch-report.js --tf=4h

import { loadCandles } from "../../backtest/lib/load-candles.js";
import { computeDivergenceForMany } from "./calc.js";
import { computeAllTouches } from "./touches.js";

const args = Object.fromEntries(process.argv.slice(2).map((a) => a.replace(/^--/, "").split("=")));
const TF = args.tf || "4h";

function fmt(t) {
  return new Date(t * 1000).toISOString().slice(0, 16).replace("T", " ");
}

async function main() {
  const candles = await loadCandles(TF);
  const { zones } = computeDivergenceForMany(candles);
  computeAllTouches(candles, zones);

  const allInteractions = zones.flatMap((z) => z.touches.map((t) => ({ ...t, zoneSide: z.side, zonePrice: z.price })));
  const held = allInteractions.filter((t) => t.outcome === "held").length;
  const broken = allInteractions.filter((t) => t.outcome === "broken").length;
  const ongoing = allInteractions.filter((t) => t.ongoing).length;

  console.log(`${TF}: ${zones.length} zones, ${allInteractions.length} total interactions (touch events)`);
  console.log(`  held: ${held} (${((held / allInteractions.length) * 100).toFixed(1)}%)  broken: ${broken} (${((broken / allInteractions.length) * 100).toFixed(1)}%)  ongoing: ${ongoing}`);
  console.log(`  avg interactions per zone: ${(allInteractions.length / zones.length).toFixed(2)}`);
  const zeroTouchZones = zones.filter((z) => z.touches.length === 0).length;
  console.log(`  zones with zero touches (created and expired/evicted without ever being retested): ${zeroTouchZones} (${((zeroTouchZones / zones.length) * 100).toFixed(1)}%)`);

  const multiTouch = zones.filter((z) => z.touches.length >= 2);
  console.log(`\nZones tested 2+ times (${multiTouch.length} of ${zones.length}) -- full narratives, first 3:`);
  for (const z of multiTouch.slice(0, 3)) {
    console.log(`\n  ${z.side} zone @ ${z.price.toFixed(2)}, confirmed ${fmt(z.confirmedTime)}, status=${z.status}${z.expiresTime ? " @ " + fmt(z.expiresTime) : ""}`);
    z.touches.forEach((t, idx) => {
      console.log(
        `    touch ${idx + 1}: ${fmt(t.startTime)} -> ${fmt(t.endTime)} (${t.barsCount} bar${t.barsCount > 1 ? "s" : ""}), max penetration ${t.maxPenetration.toFixed(2)}, outcome=${t.outcome}${t.ongoing ? " (ongoing)" : ""}`,
      );
    });
  }
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
