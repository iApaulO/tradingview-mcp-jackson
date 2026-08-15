#!/usr/bin/env node
// Computes confluence for every order block against the full cross-timeframe pool (other order
// blocks, EQH/EQL, structure breaks) and writes confluence_count back to order_blocks. Run after
// build-historical.js (needs all 8 timeframes' data already in the DB).
//
// Usage: node scripts/signal-bus/smc/build-confluence.js

import { openStore, loadConfluencePool, updateConfluence } from "./store.js";
import { computeSMCConfluence } from "./confluence.js";

// Instrument this build writes (2026-08-15 multi-instrument scope change). Defaults to BTC so
// existing invocations keep their exact prior behaviour; pass --instrument=ETH to build ETH.
// The store layer refuses to write an unlabelled row, so this value is load-bearing.
const INSTRUMENT = (process.argv.find((a) => a.startsWith("--instrument=")) || "--instrument=BTC").split("=")[1];


function main() {
  const db = openStore(INSTRUMENT);
  const { pool, targets } = loadConfluencePool(db, INSTRUMENT);
  console.log(`Loaded pool: ${pool.length} elements (${pool.filter((p) => p.type === "orderblock").length} order blocks, ${pool.filter((p) => p.type === "eqhl").length} EQH/EQL, ${pool.filter((p) => p.type === "structure").length} structure events)`);

  const t0 = Date.now();
  computeSMCConfluence(targets, pool);
  console.log(`Computed confluence for ${targets.length} order blocks in ${((Date.now() - t0) / 1000).toFixed(2)}s`);

  updateConfluence(db, targets);
  db.close();

  const isolated = targets.filter((t) => t.confluenceCount === 1).length;
  const confluent = targets.length - isolated;
  // Plain loops, not Math.max(...targets.map(...)) -- spreading 80k+ elements as call arguments
  // hits the engine's argument-count limit (see confluence.js's maxTol fix, same root cause).
  let maxDepth = -Infinity; for (const t of targets) if (t.confluenceCount > maxDepth) maxDepth = t.confluenceCount;
  console.log(`\n${isolated} isolated order blocks, ${confluent} in some confluence (${((confluent / targets.length) * 100).toFixed(1)}%)`);
  console.log(`Max confluence depth: ${maxDepth} distinct timeframes agreeing`);

  const noRecurrence = targets.filter((t) => t.recurrenceCount === 1).length;
  const recurrent = targets.length - noRecurrence;
  let maxRecurrence = -Infinity; for (const t of targets) if (t.recurrenceCount > maxRecurrence) maxRecurrence = t.recurrenceCount;
  console.log(`\n${noRecurrence} order blocks with no same-timeframe recurrence, ${recurrent} with some (${((recurrent / targets.length) * 100).toFixed(1)}%)`);
  console.log(`Max recurrence depth: ${maxRecurrence} same-timeframe order blocks stacked together`);
}

main();
