#!/usr/bin/env node
// Builds the ICT Concepts signal bus over the full 8-rung ladder for one instrument.
//
// Both FVG variants (fvg and ifvg) are computed and stored per timeframe -- see calc.js for why
// the research configuration deliberately departs from the Pine display defaults.
//
// Usage: node scripts/signal-bus/ict/build-historical.js [--instrument=BTC] [--tf=1w,1d,...]

import { execSync } from "child_process";
import { loadCandles } from "../../backtest/lib/load-candles.js";
import { computeDisplacement, computeFVG, computeVolumeImbalance } from "./calc.js";
import { openStore, clearAll, insertRun, insertDisplacement, insertFvgZones, insertVolumeImbalance } from "./store.js";

const args = Object.fromEntries(process.argv.slice(2).filter((a) => a.includes("=")).map((a) => a.replace(/^--/, "").split("=")));
const INSTRUMENT = args.instrument || "BTC";
const LADDER = [
  ["W", "1w"], ["D", "1d"], ["4H", "4h"], ["3H", "3h"],
  ["2H", "2h"], ["1H", "1h"], ["15m", "15m"], ["5m", "5m"],
];
const TIMEFRAMES = args.tf ? LADDER.filter(([, k]) => args.tf.split(",").includes(k)) : LADDER;

function gitCommit() {
  try { return execSync("git rev-parse HEAD", { cwd: new URL("../../../", import.meta.url), encoding: "utf8" }).trim(); }
  catch { return "unknown"; }
}

async function main() {
  const commit = gitCommit();
  const db = openStore(INSTRUMENT);
  clearAll(db, INSTRUMENT);

  const summary = [];
  for (const [label, key] of TIMEFRAMES) {
    const t0 = Date.now();
    const candles = await loadCandles(key, INSTRUMENT);
    const runId = insertRun(db, { instrument: INSTRUMENT, timeframe: key, candles, gitCommit: commit });

    // Displacement is computed once and passed into both consumers -- FVG detection depends on it
    // (the gap must follow a displacement candle) and recomputing would be wasted work on 944k bars.
    const disp = computeDisplacement(candles);
    const fvg = computeFVG(candles, { mode: "fvg", displacement: disp });
    const ifvg = computeFVG(candles, { mode: "ifvg", displacement: disp });
    const vi = computeVolumeImbalance(candles, disp);

    insertDisplacement(db, { instrument: INSTRUMENT, runId, timeframe: key, events: disp.events });
    insertFvgZones(db, { instrument: INSTRUMENT, runId, timeframe: key, zones: fvg.zones });
    insertFvgZones(db, { instrument: INSTRUMENT, runId, timeframe: key, zones: ifvg.zones });
    insertVolumeImbalance(db, { instrument: INSTRUMENT, runId, timeframe: key, events: vi.events });

    const secs = ((Date.now() - t0) / 1000).toFixed(1);
    summary.push({
      label, key,
      candles: candles.length,
      displacement: disp.events.length,
      fvg: fvg.zones.length,
      ifvg: ifvg.zones.length,
      vi: vi.events.length,
      fvg_broken: fvg.zones.filter((z) => z.status === "broken").length,
    });
    console.log(`${label.padEnd(4)} (${key}) ... ${candles.length.toLocaleString()} candles, ${disp.events.length} displacement, ${fvg.zones.length} FVG, ${ifvg.zones.length} IFVG, ${vi.events.length} VI -- ${secs}s`);
  }
  db.close();

  console.log("\nPer-timeframe summary:");
  console.table(summary);

  const totalFvg = summary.reduce((s, r) => s + r.fvg, 0);
  const totalBroken = summary.reduce((s, r) => s + r.fvg_broken, 0);
  console.log(`\n${INSTRUMENT}: ${totalFvg.toLocaleString()} FVG zones, ${((totalBroken / totalFvg) * 100).toFixed(1)}% eventually broken (gaps fill -- a high rate here is expected, not a defect).`);
  const totalVi = summary.reduce((s, r) => s + r.vi, 0);
  console.log(`Volume Imbalance total: ${totalVi} -- structurally near-vacuous on 24/7 crypto, which has essentially no inter-bar gaps (verified: zero bars on 1d where open > previous high). Stored for completeness, not expected to carry signal on this instrument class.`);
}

main().catch((err) => { console.error("Fatal:", err); process.exit(1); });
