#!/usr/bin/env node
// Full historical build across the confirmed 8-timeframe signal-bus ladder (W, D, 4H, 3H, 2H, 1H,
// 15m, 5m), same ladder as SMC/Divergence-for-Many. Computes zones + touches per timeframe, then
// confluence across the full combined set. Always a full rebuild (clearAll).
//
// Usage: node scripts/signal-bus/vmc-cipher-b/build-historical.js

import { execSync } from "child_process";
import { loadCandles } from "../../backtest/lib/load-candles.js";
import { computeVmcCipherB } from "./calc.js";
import { computeAllTouches } from "./touches.js";
import { computeConfluence } from "./confluence.js";
import { openStore, clearAll, insertRun, insertZonesAndTouches, updateConfluence } from "./store.js";

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
  const db = openStore(INSTRUMENT);
  clearAll(db, INSTRUMENT);

  const allZones = [];
  const summary = [];

  for (const { label, key } of LADDER) {
    process.stdout.write(`${label.padEnd(4)} (${key}) ... `);
    const t0 = Date.now();
    const candles = await loadCandles(key, INSTRUMENT);
    if (candles.length === 0) {
      console.log("SKIPPED (no candle data found)");
      continue;
    }
    const { zones } = computeVmcCipherB(candles);
    computeAllTouches(candles, zones);
    for (const z of zones) z.timeframe = key; // confluence.js needs this on the zone object itself

    const runId = insertRun(db, { instrument: INSTRUMENT, timeframe: key, candles, gitCommit: commit });
    insertZonesAndTouches(db, { instrument: INSTRUMENT, runId, timeframe: key, zones }); // sets z.id on each zone

    allZones.push(...zones);
    const touches = zones.reduce((s, z) => s + z.touches.length, 0);
    const regular = zones.filter((z) => z.kind === "regular").length;
    const hidden = zones.filter((z) => z.kind === "hidden").length;
    console.log(`${candles.length.toLocaleString()} candles, ${zones.length} zones (${regular} regular, ${hidden} hidden), ${touches} touches -- ${((Date.now() - t0) / 1000).toFixed(1)}s`);
    summary.push({ label, key, candles: candles.length, zones: zones.length, regular, hidden, touches });
  }

  process.stdout.write(`\nComputing confluence across ${allZones.length} zones (all timeframes combined) ... `);
  const t0 = Date.now();
  computeConfluence(allZones);
  updateConfluence(db, allZones, INSTRUMENT);
  console.log(`done -- ${((Date.now() - t0) / 1000).toFixed(1)}s`);

  db.close();

  console.log("\nPer-timeframe summary:");
  console.table(summary);

  const isolated = allZones.filter((z) => z.confluenceCount === 1).length;
  const confluent = allZones.length - isolated;
  console.log(`\nConfluence: ${isolated} isolated zones (no other timeframe agrees), ${confluent} in some confluence cluster (${((confluent / allZones.length) * 100).toFixed(1)}%)`);
  const maxConfluence = Math.max(...allZones.map((z) => z.confluenceCount));
  console.log(`Max confluence depth observed: ${maxConfluence} distinct timeframes agreeing at one price`);
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
