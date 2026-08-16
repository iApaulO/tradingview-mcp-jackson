#!/usr/bin/env node
// Builds the cascade bus for one instrument.
//
// Unlike every other bus here, this one consumes OTHER BUSES rather than candles: cascades are
// built from already-persisted flip/structure events, so adaptive-supertrend and smc must be built
// first. rebuild-all.js therefore places cascade last.
//
// THREE EVENT FAMILIES are built, because #135 found the propagation direction REVERSES between
// them and that difference is the most informative thing the encoding has produced:
//   supertrend    -- Adaptive SuperTrend flips. Propagates BOTTOM-UP more (896 top-down vs 1,478
//                    bottom-up), which is plausibly mechanical rather than informational: a weekly
//                    SuperTrend cannot flip without price action that has already flipped every
//                    faster rung, so bottom-up sequences there are close to definitional.
//   smc_structure -- SMC BOS + CHoCH, swing scope. Propagates TOP-DOWN 2.4x more (816 vs 347).
//                    Structural breaks carry no such forced coupling, which makes this the
//                    non-trivial direction -- and structure is what ICT/SMC actually claims
//                    propagates top-down, not a trend-following overlay.
//   smc_choch     -- CHoCH only, the reversal subset of the above.
//
// The full parameter grid is persisted (both propagation directions x window multipliers 1/2/4)
// so sensitivity is a query rather than a rebuild. Window scale is fixed to 'coarser', the only
// symmetric rule -- see calc.js for why the alternatives manufacture a directional result.
//
// Usage: node scripts/signal-bus/cascade/build-historical.js [--instrument=BTC]

import { DatabaseSync } from "node:sqlite";
import { execSync } from "child_process";
import { computeCascades, maximalCascades, LADDER } from "./calc.js";
import { openStore, clearAll, insertRun, insertCascades } from "./store.js";

const args = Object.fromEntries(process.argv.slice(2).filter((a) => a.includes("=")).map((a) => a.replace(/^--/, "").split("=")));
const INSTRUMENT = args.instrument || "BTC";
const WINDOW_SCALE = "coarser";
const WINDOW_MULTS = (args.mults || "1,2,4").split(",").map(Number);

const dbFile = (base) => new URL(`../../../data/signal-bus/${INSTRUMENT === "BTC" ? `${base}.db` : `${base}-eth.db`}`, import.meta.url);

function gitCommit() {
  try { return execSync("git rev-parse HEAD", { cwd: new URL("../../../", import.meta.url), encoding: "utf8" }).trim(); }
  catch { return "unknown"; }
}

// Each family returns Map<tf, [{time, direction, price}]> sorted ascending.
function loadSuperTrend() {
  const db = new DatabaseSync(dbFile("adaptive-supertrend"), { readOnly: true });
  const m = new Map();
  let total = 0;
  for (const { tf } of LADDER) {
    const rows = db.prepare("SELECT time, direction, price FROM events WHERE timeframe = ? ORDER BY time").all(tf);
    m.set(tf, rows); total += rows.length;
  }
  db.close();
  return { flips: m, total };
}

function loadSmcStructure(chochOnly) {
  const db = new DatabaseSync(dbFile("smc"), { readOnly: true });
  const m = new Map();
  let total = 0;
  const where = chochOnly ? "AND type = 'CHOCH'" : "";
  for (const { tf } of LADDER) {
    // `side` is the structural direction (bullish/bearish) and is what must match across rungs --
    // a bullish break confirmed by a bearish one is not a cascade.
    const rows = db.prepare(`SELECT time, side AS direction, price FROM structure_events WHERE timeframe = ? AND scope = 'swing' ${where} ORDER BY time`).all(tf);
    m.set(tf, rows); total += rows.length;
  }
  db.close();
  return { flips: m, total };
}

async function main() {
  const commit = gitCommit();
  const db = openStore(INSTRUMENT);
  clearAll(db, INSTRUMENT);

  const FAMILIES = [
    ["supertrend", loadSuperTrend],
    ["smc_structure", () => loadSmcStructure(false)],
    ["smc_choch", () => loadSmcStructure(true)],
  ];

  const summary = [];
  for (const [family, loader] of FAMILIES) {
    const { flips, total } = loader();
    const runId = insertRun(db, { instrument: INSTRUMENT, eventFamily: family, windowScale: WINDOW_SCALE, windowMults: WINDOW_MULTS, sourceEventCount: total, gitCommit: commit });

    for (const mult of WINDOW_MULTS) {
      for (const topDown of [true, false]) {
        const cascades = maximalCascades(computeCascades(flips, { windowMult: mult, windowScale: WINDOW_SCALE, topDown }));
        insertCascades(db, { instrument: INSTRUMENT, runId, eventFamily: family, windowScale: WINDOW_SCALE, windowMult: mult, cascades });
        const deep = cascades.filter((c) => c.depth >= 3).length;
        summary.push({
          family, mult, propagation: topDown ? "top_down" : "bottom_up",
          n: cascades.length, deep_ge3: deep,
          full_ladder: cascades.filter((c) => c.fullLadder).length,
          mean_depth: cascades.length ? +(cascades.reduce((s, c) => s + c.depth, 0) / cascades.length).toFixed(3) : null,
        });
      }
    }
    console.log(`${family.padEnd(14)} ${total.toLocaleString()} source events -> cascades built at mults ${WINDOW_MULTS.join("/")}`);
  }
  db.close();

  console.log("\nCascade populations:");
  console.table(summary);

  const totalCasc = summary.reduce((s, r) => s + r.n, 0);
  const totalFull = summary.reduce((s, r) => s + r.full_ladder, 0);
  console.log(`\n${INSTRUMENT}: ${totalCasc.toLocaleString()} maximal cascades persisted, ${totalFull} of them traversing the full 8-rung ladder.`);
  console.log(`Mean depth stays near 2 in every configuration -- deep multi-timeframe propagation does not occur (register #135).`);
}

main().catch((err) => { console.error("Fatal:", err); process.exit(1); });
