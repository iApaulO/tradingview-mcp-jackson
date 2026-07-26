#!/usr/bin/env node
// Verification pass for touches.js, same purpose as divergence-for-many's touch-report.js: check
// the numbers are sane and the "broken interaction has penetration >= 1.0" invariant actually
// holds, before trusting this enough to store/build on top of it.
//
// Usage: node scripts/signal-bus/smc/touch-report.js --tf=4h

import { loadCandles } from "../../backtest/lib/load-candles.js";
import { computeSMC } from "./calc.js";
import { computeAllOrderBlockTouches } from "./touches.js";

const args = Object.fromEntries(process.argv.slice(2).map((a) => a.replace(/^--/, "").split("=")));
const TF = args.tf || "4h";

function fmt(t) {
  return new Date(t * 1000).toISOString().slice(0, 16).replace("T", " ");
}

async function main() {
  const candles = await loadCandles(TF);
  const { orderBlocks } = computeSMC(candles);
  computeAllOrderBlockTouches(candles, orderBlocks);

  for (const scope of ["internal", "swing"]) {
    const obs = orderBlocks.filter((o) => o.scope === scope);
    const allInteractions = obs.flatMap((o) => o.touches);
    const held = allInteractions.filter((t) => t.outcome === "held").length;
    const broken = allInteractions.filter((t) => t.outcome === "broken").length;

    console.log(`${scope}: ${obs.length} order blocks, ${allInteractions.length} total interactions`);
    console.log(`  held: ${held}  broken: ${broken}`);
    console.log(`  avg interactions per block: ${(allInteractions.length / obs.length).toFixed(2)}`);

    // Invariant check: a "broken" interaction should have penetration >= ~1.0 (it breached the
    // far side, which is what mitigation means under HIGHLOW source). Flag any that don't --
    // would indicate a bug in the outcome/penetration logic, not just an expected edge case.
    const brokenInteractions = allInteractions.filter((t) => t.outcome === "broken");
    const badInvariant = brokenInteractions.filter((t) => t.maxPenetrationPct < 0.98);
    console.log(`  invariant check: ${brokenInteractions.length} broken interactions, ${badInvariant.length} with penetration < 0.98 (should be ~0)`);

    const testedMultiple = obs.filter((o) => o.touches.length >= 2);
    console.log(`  blocks tested 2+ times before resolution: ${testedMultiple.length} of ${obs.length}`);
  }

  console.log("\nExample: a swing bullish order block tested multiple times before mitigation --");
  const example = orderBlocks
    .filter((o) => o.scope === "swing" && o.side === "bullish" && o.status === "mitigated" && o.touches.length >= 2)
    .sort((a, b) => b.touches.length - a.touches.length)[0];
  if (example) {
    console.log(`  Box [${example.barLow.toFixed(2)}, ${example.barHigh.toFixed(2)}], created ${fmt(example.createdTime)}, mitigated ${fmt(example.mitigatedTime)}`);
    example.touches.forEach((t, i) => {
      console.log(
        `    touch ${i + 1}: ${fmt(t.startTime)} -> ${fmt(t.endTime)} (${t.barsCount} bars), approached from ${t.approachDirection}, max penetration ${(t.maxPenetrationPct * 100).toFixed(0)}%, outcome=${t.outcome}`,
      );
    });
  } else {
    console.log("  (none found with 2+ touches on this timeframe)");
  }
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
