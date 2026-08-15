#!/usr/bin/env node
// Sanity check for the Adaptive SuperTrend signal-bus. The underlying K-Means/ATR math is reused
// unmodified from scripts/lib/adaptive-supertrend.js (already live-used, not re-derived here) --
// what's new is persistence of derived flip events, so this checks a real structural invariant:
// direction must strictly ALTERNATE bar-to-bar in the source series, so consecutive stored flip
// events must never repeat the same direction twice in a row (a storage/derivation bug could
// violate this even though the underlying `dir` series is correct).
//
// Usage: node scripts/signal-bus/adaptive-supertrend/sanity-check.js

import { DatabaseSync } from "node:sqlite";

const DB_PATH = new URL("../../../data/signal-bus/adaptive-supertrend.db", import.meta.url);
const LADDER_KEYS = ["1w", "1d", "4h", "3h", "2h", "1h", "15m", "5m"];

function main() {
  const db = new DatabaseSync(DB_PATH, { readOnly: true });
  let allOk = true;

  for (const tf of LADDER_KEYS) {
    const rows = db.prepare("SELECT direction, bar_idx FROM events WHERE timeframe = ? ORDER BY bar_idx ASC").all(tf);
    let repeats = 0;
    for (let i = 1; i < rows.length; i++) if (rows[i].direction === rows[i - 1].direction) repeats++;
    const bullish = rows.filter((r) => r.direction === "bullish").length;
    const bearish = rows.length - bullish;
    const balanced = Math.abs(bullish - bearish) <= 1; // strict alternation implies counts differ by at most 1
    const ok = repeats === 0 && balanced;
    if (!ok) allOk = false;
    console.log(`${tf.padEnd(4)} n=${rows.length} bullish=${bullish} bearish=${bearish} (${repeats} same-direction repeats -- should be 0)  ${ok ? "OK" : "FAIL"}`);
  }

  db.close();
  console.log(allOk ? "\nAll invariants hold." : "\nFAILED -- a build/storage bug exists, do not trust this data.");
  process.exit(allOk ? 0 : 1);
}

main();
