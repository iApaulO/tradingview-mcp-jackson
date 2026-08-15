#!/usr/bin/env node
// Sanity check for the Cipher A signal-bus (cipher-a.db). The underlying formulas were already
// live-verified against the real indicator BEFORE this signal-bus existed (calc.js's own header:
// "every one of 26 inputs matches the Pine author's documented defaults exactly") -- what's new
// here is persistence, not computation, so this checks structural correctness rather than
// re-deriving a live cross-check from scratch: yellowCross is mathematically GATED by redDiamond
// (computeYellowCross's own logic: `if (!redDiamond) continue`), so every yellow_cross event must
// land on a bar that also has a red_diamond event, same timeframe -- a real invariant, not a
// tautology (a build/storage bug could violate it even though the gate is correct in calc.js).
// Also checks bloodDiamond = redDiamond AND redCross on the same bar, same logic.
//
// Usage: node scripts/signal-bus/vmc-cipher-a/sanity-check.js

import { DatabaseSync } from "node:sqlite";

const DB_PATH = new URL("../../../data/signal-bus/cipher-a.db", import.meta.url);
const LADDER_KEYS = ["1w", "1d", "4h", "3h", "2h", "1h", "15m", "5m"];

function main() {
  const db = new DatabaseSync(DB_PATH, { readOnly: true });
  let allOk = true;

  for (const tf of LADDER_KEYS) {
    const yellowCrossBars = new Set(db.prepare("SELECT bar_idx FROM events WHERE timeframe = ? AND type = 'yellow_cross'").all(tf).map((r) => r.bar_idx));
    const redDiamondBars = new Set(db.prepare("SELECT bar_idx FROM events WHERE timeframe = ? AND type = 'red_diamond'").all(tf).map((r) => r.bar_idx));
    const redCrossBars = new Set(db.prepare("SELECT bar_idx FROM events WHERE timeframe = ? AND type = 'red_cross'").all(tf).map((r) => r.bar_idx));
    const bloodDiamondBars = new Set(db.prepare("SELECT bar_idx FROM events WHERE timeframe = ? AND type = 'blood_diamond'").all(tf).map((r) => r.bar_idx));

    const yellowNotGated = [...yellowCrossBars].filter((b) => !redDiamondBars.has(b));
    const bloodMismatch = [...bloodDiamondBars].filter((b) => !(redDiamondBars.has(b) && redCrossBars.has(b)));
    const shouldBeBlood = [...redDiamondBars].filter((b) => redCrossBars.has(b) && !bloodDiamondBars.has(b));

    const ok = yellowNotGated.length === 0 && bloodMismatch.length === 0 && shouldBeBlood.length === 0;
    if (!ok) allOk = false;
    console.log(
      `${tf.padEnd(4)} yellow_cross=${yellowCrossBars.size} (${yellowNotGated.length} ungated -- should be 0)  ` +
      `blood_diamond=${bloodDiamondBars.size} (${bloodMismatch.length} mismatched, ${shouldBeBlood.length} missing -- both should be 0)  ` +
      `${ok ? "OK" : "FAIL"}`,
    );
  }

  db.close();
  console.log(allOk ? "\nAll invariants hold." : "\nFAILED -- a build/storage bug exists, do not trust this data.");
  process.exit(allOk ? 0 : 1);
}

main();
