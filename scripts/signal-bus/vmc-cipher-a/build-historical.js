#!/usr/bin/env node
// Full historical build across the confirmed 8-timeframe signal-bus ladder. First Cipher A
// signal-bus build -- computes yellowCross, greenDot, the 5 ribbon signals (redCross, blueTriangle,
// redDiamond, bloodDiamond, bullCandle), and emaRegime transitions per timeframe, stores them in
// data/signal-bus/cipher-a.db. Always a full rebuild.
//
// Usage: node scripts/signal-bus/vmc-cipher-a/build-historical.js

import { execSync } from "child_process";
import { loadCandles } from "../../backtest/lib/load-candles.js";
import { computeYellowCross, computeGreenDot, computeRibbonSignals, computeEmaRegime } from "./calc.js";
import { openStore, clearAll, insertRun, insertEvents, insertRegimeChanges } from "./store.js";

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
  try { return execSync("git rev-parse HEAD", { cwd: new URL("../../../", import.meta.url), encoding: "utf8" }).trim(); }
  catch { return "unknown"; }
}

function regimeTransitions(candles, regime) {
  const changes = [];
  let prev = null;
  for (let i = 0; i < candles.length; i++) {
    if (regime[i] == null) continue;
    if (regime[i] !== prev) {
      changes.push({ regime: regime[i], barIdx: i, time: candles[i].t, price: candles[i].c });
      prev = regime[i];
    }
  }
  return changes;
}

async function main() {
  const commit = gitCommit();
  const db = openStore();
  clearAll(db);

  const summary = [];
  for (const { label, key } of LADDER) {
    process.stdout.write(`${label.padEnd(4)} (${key}) ... `);
    const t0 = Date.now();
    const candles = await loadCandles(key);
    if (candles.length === 0) { console.log("SKIPPED (no candle data found)"); continue; }

    const { events: yellowCrossEvents } = computeYellowCross(candles);
    const { events: greenDotEvents } = computeGreenDot(candles);
    const ribbon = computeRibbonSignals(candles);
    const regime = computeEmaRegime(candles);

    const events = [
      ...yellowCrossEvents.map((e) => ({ type: "yellow_cross", side: "bearish", barIdx: e.barIdx, time: e.time, price: candles[e.barIdx].c })),
      ...greenDotEvents.map((e) => ({ type: "green_dot", side: e.side, barIdx: e.barIdx, time: e.time, price: candles[e.barIdx].c })),
      ...ribbon.redCross.events.map((e) => ({ type: "red_cross", side: e.side, barIdx: e.barIdx, time: e.time, price: candles[e.barIdx].c })),
      ...ribbon.blueTriangle.events.map((e) => ({ type: "blue_triangle", side: e.side, barIdx: e.barIdx, time: e.time, price: candles[e.barIdx].c })),
      ...ribbon.redDiamond.events.map((e) => ({ type: "red_diamond", side: e.side, barIdx: e.barIdx, time: e.time, price: candles[e.barIdx].c })),
      ...ribbon.bloodDiamond.events.map((e) => ({ type: "blood_diamond", side: e.side, barIdx: e.barIdx, time: e.time, price: candles[e.barIdx].c })),
      ...ribbon.bullCandle.events.map((e) => ({ type: "bull_candle", side: e.side, barIdx: e.barIdx, time: e.time, price: candles[e.barIdx].c })),
    ];
    const regimeChanges = regimeTransitions(candles, regime);

    const runId = insertRun(db, { timeframe: key, candles, gitCommit: commit });
    insertEvents(db, { runId, timeframe: key, events });
    insertRegimeChanges(db, { runId, timeframe: key, changes: regimeChanges });

    const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
    const byType = {};
    for (const e of events) byType[e.type] = (byType[e.type] || 0) + 1;
    console.log(
      `${candles.length.toLocaleString()} candles, ${events.length.toLocaleString()} events (${Object.entries(byType).map(([k, v]) => `${k}=${v}`).join(", ")}), ${regimeChanges.length.toLocaleString()} regime changes -- ${elapsed}s`,
    );
    summary.push({ label, key, candles: candles.length, events: events.length, regimeChanges: regimeChanges.length, ...byType });
  }

  db.close();
  console.log("\nSummary:");
  console.table(summary);
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
