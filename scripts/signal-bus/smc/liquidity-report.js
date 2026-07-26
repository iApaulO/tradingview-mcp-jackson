#!/usr/bin/env node
// Verification pass for liquidity.js before trusting it enough to store/build on.
// Usage: node scripts/signal-bus/smc/liquidity-report.js --tf=4h

import { loadCandles } from "../../backtest/lib/load-candles.js";
import { computeSMC } from "./calc.js";
import { detectLiquiditySweeps } from "./liquidity.js";

const args = Object.fromEntries(process.argv.slice(2).map((a) => a.replace(/^--/, "").split("=")));
const TF = args.tf || "4h";

function fmt(t) {
  return new Date(t * 1000).toISOString().slice(0, 16).replace("T", " ");
}

async function main() {
  const candles = await loadCandles(TF);
  const { eqhEqlEvents } = computeSMC(candles);
  detectLiquiditySweeps(candles, eqhEqlEvents);

  for (const side of ["EQH", "EQL"]) {
    const evs = eqhEqlEvents.filter((e) => e.side === side);
    const unswept = evs.filter((e) => e.sweepStatus === "unswept").length;
    const reversed = evs.filter((e) => e.sweepStatus === "swept_reversed").length;
    const continued = evs.filter((e) => e.sweepStatus === "swept_continued").length;
    const swept = reversed + continued;
    console.log(`${side}: ${evs.length} total | unswept ${unswept} (${((unswept / evs.length) * 100).toFixed(1)}%) | swept ${swept} (${((swept / evs.length) * 100).toFixed(1)}%)`);
    console.log(`  of swept: reversed (stop-hunt) ${reversed} (${swept ? ((reversed / swept) * 100).toFixed(1) : "n/a"}%), continued through ${continued} (${swept ? ((continued / swept) * 100).toFixed(1) : "n/a"}%)`);
    const avgBarsToSweep = evs.filter((e) => e.barsToSweep != null).reduce((s, e, _, a) => s + e.barsToSweep / a.length, 0);
    console.log(`  avg bars to sweep (when swept): ${avgBarsToSweep.toFixed(1)}`);
  }

  console.log("\nFirst 5 swept-and-reversed EQH (classic stop-hunt pattern):");
  for (const e of eqhEqlEvents.filter((e) => e.side === "EQH" && e.sweepStatus === "swept_reversed").slice(0, 5)) {
    console.log(`  level=${e.level.toFixed(2)} confirmed=${fmt(e.confirmTime)} swept=${fmt(e.sweepTime)} (+${e.barsToSweep} bars) reversed=${fmt(e.reversalTime)} (+${e.barsToReversal} bars after sweep)`);
  }

  console.log("\nFirst 5 swept-and-continued EQL (liquidity taken, trend continued):");
  for (const e of eqhEqlEvents.filter((e) => e.side === "EQL" && e.sweepStatus === "swept_continued").slice(0, 5)) {
    console.log(`  level=${e.level.toFixed(2)} confirmed=${fmt(e.confirmTime)} swept=${fmt(e.sweepTime)} (+${e.barsToSweep} bars)`);
  }
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
