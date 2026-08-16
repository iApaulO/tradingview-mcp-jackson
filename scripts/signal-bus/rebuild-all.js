#!/usr/bin/env node
// Orchestrates a full signal-bus rebuild for ONE instrument, in dependency order. Added
// 2026-08-15 -- this order previously existed only as tribal knowledge, which is a poor thing to
// rely on when a wrong order produces a silently incomplete database rather than an error.
//
// DEPENDENCY ORDER (why it is what it is):
//   1. The six per-indicator builds are independent of each other -- each reads only CSVs and
//      writes only its own DB, so their relative order does not matter.
//   2. smc/build-confluence.js must run AFTER smc/build-historical.js: it reads the order_blocks
//      the historical build just wrote and annotates them with confluence/recurrence counts.
//      Strategy A2's recurrence_count >= 3 filter is meaningless until this has run.
//   3. smc/build-boom-confluence.js must run LAST of all: it reads BOTH smc.db (order blocks) and
//      boom-hunter.db (Long tiers / continuations) and writes the boom_* columns back onto
//      order_blocks. Running it before either input is built yields zeroes, not an error.
//
// Per-instrument DB files (2026-08-15): each store routes on instrument, so a rebuild for ETH
// cannot touch BTC's databases. See scripts/signal-bus/lib/instrument.js.
//
// Usage: node scripts/signal-bus/rebuild-all.js --instrument=BTC [--skip=vmc-cipher-b]

import { spawnSync } from "child_process";

const args = Object.fromEntries(
  process.argv.slice(2).filter((a) => a.includes("=")).map((a) => a.replace(/^--/, "").split("=")),
);
const INSTRUMENT = args.instrument || "BTC";
const SKIP = new Set((args.skip || "").split(",").filter(Boolean));

const BUSES = ["smc", "divergence-for-many", "vmc-cipher-b", "vmc-cipher-a", "boom-hunter", "adaptive-supertrend", "ict"];

const STEPS = [
  ...BUSES.map((bus) => ({ name: bus, script: `scripts/signal-bus/${bus}/build-historical.js`, instrumented: true })),
  { name: "smc confluence", script: "scripts/signal-bus/smc/build-confluence.js", instrumented: true },
  { name: "smc boom-confluence", script: "scripts/signal-bus/smc/build-boom-confluence.js", instrumented: true },
  // Cascade runs LAST and is the only bus that consumes other BUSES rather than candles: it reads
  // adaptive-supertrend flips and smc structure events, so both must already be built. Running it
  // earlier produces an empty or partial cascade population with no error -- the same silent-
  // incompleteness failure mode this orchestrator exists to prevent.
  { name: "cascade", script: "scripts/signal-bus/cascade/build-historical.js", instrumented: true },
];

function run(step) {
  const argv = [step.script];
  if (step.instrumented) argv.push(`--instrument=${INSTRUMENT}`);
  const started = Date.now();
  console.log(`\n${"=".repeat(70)}\n[${INSTRUMENT}] ${step.name}\n${"=".repeat(70)}`);
  const res = spawnSync("node", argv, { stdio: "inherit" });
  const mins = ((Date.now() - started) / 60000).toFixed(1);
  if (res.status !== 0) {
    // Fail loudly and stop: a later step consuming a half-built input would produce plausible
    // numbers rather than an error, which is worse than stopping here.
    console.error(`\nFAILED: ${step.name} exited ${res.status} after ${mins}m — halting rebuild.`);
    process.exit(res.status ?? 1);
  }
  console.log(`\n-- ${step.name} done in ${mins}m`);
}

const t0 = Date.now();
console.log(`Signal-bus rebuild for ${INSTRUMENT}${SKIP.size ? ` (skipping: ${[...SKIP].join(", ")})` : ""}`);
for (const step of STEPS) {
  if (SKIP.has(step.name)) {
    console.log(`\n-- skipping ${step.name} (--skip)`);
    continue;
  }
  run(step);
}
console.log(`\nRebuild complete for ${INSTRUMENT} in ${((Date.now() - t0) / 60000).toFixed(1)}m`);
