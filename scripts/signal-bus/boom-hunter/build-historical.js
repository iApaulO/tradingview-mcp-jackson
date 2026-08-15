#!/usr/bin/env node
// Full historical build across the confirmed 8-timeframe signal-bus ladder. Computes every Boom
// Hunter Pro event (continuation, the 4 long variants, break/short) per timeframe and stores them
// in data/signal-bus/boom-hunter.db. Always a full rebuild.
//
// Usage: node scripts/signal-bus/boom-hunter/build-historical.js

import { execSync } from "child_process";
import { loadCandles } from "../../backtest/lib/load-candles.js";
import { computeBoomHunter } from "./calc.js";
import { openStore, clearAll, insertRun, insertEvents, insertEot3Episodes } from "./store.js";

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
    const { events, eot3Episodes } = computeBoomHunter(candles);

    const runId = insertRun(db, { instrument: INSTRUMENT, timeframe: key, candles, gitCommit: commit });
    insertEvents(db, { instrument: INSTRUMENT, runId, timeframe: key, events });
    insertEot3Episodes(db, { instrument: INSTRUMENT, runId, timeframe: key, episodes: eot3Episodes });

    const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
    const byType = {};
    for (const e of events) byType[e.type] = (byType[e.type] || 0) + 1;
    const flagged = eot3Episodes.filter((e) => e.hasFlag).length;
    console.log(
      `${candles.length.toLocaleString()} candles, ${events.length.toLocaleString()} events (${Object.entries(byType).map(([k, v]) => `${k}=${v}`).join(", ")}), ${eot3Episodes.length.toLocaleString()} eot3 episodes (${flagged} flagged) -- ${elapsed}s`,
    );
    summary.push({ label, key, candles: candles.length, events: events.length, eot3Episodes: eot3Episodes.length, ...byType });
  }

  db.close();
  console.log("\nSummary:");
  console.table(summary);
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
