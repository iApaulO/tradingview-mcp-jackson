#!/usr/bin/env node
// Full historical build across the confirmed 8-timeframe signal-bus ladder (W, D, 4H, 3H, 2H, 1H,
// 15m, 5m), same ladder as SMC and Divergence for Many. Computes every Cipher B divergence
// (WT/WT-2nd/RSI/Stoch, regular+hidden, both sides) per timeframe and stores them in
// data/signal-bus/cipher-b.db. Always a full rebuild.
//
// Usage: node scripts/signal-bus/cipher-b/build-historical.js

import { execSync } from "child_process";
import { DatabaseSync } from "node:sqlite";
import { loadCandles } from "../../backtest/lib/load-candles.js";
import { computeCipherBDivergences } from "./calc.js";
import { computeCrossings } from "./crossings.js";
import { joinDivergencesToSMC } from "./smc-join.js";
import { openStore, clearAll, insertRun, insertAll, insertCrossings, insertSMCMatches } from "./store.js";

const SMC_DB_PATH = new URL("../../../data/signal-bus/smc.db", import.meta.url);

const LADDER = [
  { label: "W", key: "1w", barDurationSec: 604800 },
  { label: "D", key: "1d", barDurationSec: 86400 },
  { label: "4H", key: "4h", barDurationSec: 14400 },
  { label: "3H", key: "3h", barDurationSec: 10800 },
  { label: "2H", key: "2h", barDurationSec: 7200 },
  { label: "1H", key: "1h", barDurationSec: 3600 },
  { label: "15m", key: "15m", barDurationSec: 900 },
  { label: "5m", key: "5m", barDurationSec: 300 },
];

function loadSMCStructureEvents(timeframe) {
  const db = new DatabaseSync(SMC_DB_PATH, { readOnly: true });
  const rows = db.prepare("SELECT scope, type, side, bar_idx as barIdx, time, price FROM structure_events WHERE timeframe = ?").all(timeframe);
  db.close();
  return rows;
}

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
  clearAll(db);

  const summary = [];
  for (const { label, key, barDurationSec } of LADDER) {
    process.stdout.write(`${label.padEnd(4)} (${key}) ... `);
    const t0 = Date.now();
    const candles = await loadCandles(key);
    if (candles.length === 0) {
      console.log("SKIPPED (no candle data found)");
      continue;
    }
    const { divergences, series } = computeCipherBDivergences(candles);

    const runId = insertRun(db, { timeframe: key, candles, gitCommit: commit });
    insertAll(db, { runId, timeframe: key, divergences }); // attaches real .id onto each divergence

    const seriesBySource = { wt: series.wt2, wt2nd: series.wt2, rsi: series.rsi, stoch: series.stochK };
    const crossings = computeCrossings(divergences, seriesBySource, candles);
    insertCrossings(db, crossings);

    const structureEvents = loadSMCStructureEvents(key);
    const smcMatches = joinDivergencesToSMC(divergences, structureEvents, barDurationSec);
    insertSMCMatches(db, smcMatches);

    const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
    const bySource = {};
    for (const d of divergences) bySource[d.source] = (bySource[d.source] || 0) + 1;
    console.log(
      `${candles.length.toLocaleString()} candles, ${divergences.length} divergences (${Object.entries(bySource).map(([k, v]) => `${k}=${v}`).join(", ")}), ` +
      `${crossings.length.toLocaleString()} crossings, ${smcMatches.length.toLocaleString()} SMC matches (${structureEvents.length.toLocaleString()} structure events available) -- ${elapsed}s`,
    );
    summary.push({ label, key, candles: candles.length, divergences: divergences.length, crossings: crossings.length, smcMatches: smcMatches.length, ...bySource });
  }

  db.close();
  console.log("\nSummary:");
  console.table(summary);
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
