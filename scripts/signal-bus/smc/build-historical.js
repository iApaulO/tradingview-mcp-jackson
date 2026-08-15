#!/usr/bin/env node
// Full historical build across the confirmed 8-timeframe signal-bus ladder (W, D, 4H, 3H, 2H, 1H,
// 15m, 5m), same ladder as Divergence for Many. Computes structure/EQH-EQL/order-blocks + order-
// block touches per timeframe and stores them in data/signal-bus/smc.db. Always a full rebuild.
//
// Usage: node scripts/signal-bus/smc/build-historical.js

import { execSync } from "child_process";
import { loadCandles } from "../../backtest/lib/load-candles.js";
import { computeSMC } from "./calc.js";
import { computeAllOrderBlockTouches } from "./touches.js";
import { computeAllProximityEvents } from "./proximity.js";
import { detectLiquiditySweeps } from "./liquidity.js";
import { openStore, clearAll, insertRun, insertAll } from "./store.js";

// Instrument this build writes (2026-08-15 multi-instrument scope change). Defaults to BTC so
// existing invocations keep their exact prior behaviour; pass --instrument=ETH to build ETH.
// The store layer refuses to write an unlabelled row, so this value is load-bearing.
const INSTRUMENT = (process.argv.find((a) => a.startsWith("--instrument=")) || "--instrument=BTC").split("=")[1];


const LADDER = [
  { label: "W", key: "1w" },
  { label: "D", key: "1d" },
  { label: "4H", key: "4h" },
  { label: "3H", key: "3h" },
  { label: "2H", key: "2h" },
  { label: "1H", key: "1h" },
  { label: "15m", key: "15m" },
  { label: "5m", key: "5m" },
];

function gitCommit() {
  try {
    return execSync("git rev-parse HEAD", { cwd: new URL("../../../", import.meta.url), encoding: "utf8" }).trim();
  } catch {
    return "unknown";
  }
}

async function main() {
  const commit = gitCommit();
  const db = openStore();
  clearAll(db, INSTRUMENT);

  const summary = [];
  for (const { label, key } of LADDER) {
    process.stdout.write(`${label.padEnd(4)} (${key}) ... `);
    const t0 = Date.now();
    const candles = await loadCandles(key, INSTRUMENT);
    if (candles.length === 0) {
      console.log("SKIPPED (no candle data found)");
      continue;
    }
    const { structureEvents, eqhEqlEvents, orderBlocks } = computeSMC(candles);
    computeAllOrderBlockTouches(candles, orderBlocks);
    computeAllProximityEvents(candles, orderBlocks);
    detectLiquiditySweeps(candles, eqhEqlEvents);

    const runId = insertRun(db, { instrument: INSTRUMENT, timeframe: key, candles, gitCommit: commit });
    insertAll(db, { instrument: INSTRUMENT, runId, timeframe: key, structureEvents, eqhEqlEvents, orderBlocks });

    const touches = orderBlocks.reduce((s, o) => s + o.touches.length, 0);
    const proximityEvents = orderBlocks.reduce((s, o) => s + o.proximityEvents.length, 0);
    const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
    console.log(
      `${candles.length.toLocaleString()} candles, ${structureEvents.length} structure events, ${eqhEqlEvents.length} EQH/EQL, ${orderBlocks.length} order blocks, ${touches} OB touches, ${proximityEvents} near-misses -- ${elapsed}s`,
    );
    summary.push({ label, key, candles: candles.length, structureEvents: structureEvents.length, eqhEql: eqhEqlEvents.length, orderBlocks: orderBlocks.length, obTouches: touches, nearMisses: proximityEvents });
  }

  db.close();
  console.log("\nSummary:");
  console.table(summary);
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
