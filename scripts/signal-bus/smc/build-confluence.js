#!/usr/bin/env node
// Computes confluence for every order block against the full cross-timeframe pool (other order
// blocks, EQH/EQL, structure breaks) and writes confluence_count back to order_blocks. Run after
// build-historical.js (needs all 8 timeframes' data already in the DB).
//
// Usage: node scripts/signal-bus/smc/build-confluence.js

import { openStore, loadConfluencePool, updateConfluence } from "./store.js";
import { computeSMCConfluence } from "./confluence.js";

function main() {
  const db = openStore();
  const { pool, targets } = loadConfluencePool(db);
  console.log(`Loaded pool: ${pool.length} elements (${pool.filter((p) => p.type === "orderblock").length} order blocks, ${pool.filter((p) => p.type === "eqhl").length} EQH/EQL, ${pool.filter((p) => p.type === "structure").length} structure events)`);

  const t0 = Date.now();
  computeSMCConfluence(targets, pool);
  console.log(`Computed confluence for ${targets.length} order blocks in ${((Date.now() - t0) / 1000).toFixed(2)}s`);

  updateConfluence(db, targets);
  db.close();

  const isolated = targets.filter((t) => t.confluenceCount === 1).length;
  const confluent = targets.length - isolated;
  const maxDepth = Math.max(...targets.map((t) => t.confluenceCount));
  console.log(`\n${isolated} isolated order blocks, ${confluent} in some confluence (${((confluent / targets.length) * 100).toFixed(1)}%)`);
  console.log(`Max confluence depth: ${maxDepth} distinct timeframes agreeing`);

  const noRecurrence = targets.filter((t) => t.recurrenceCount === 1).length;
  const recurrent = targets.length - noRecurrence;
  const maxRecurrence = Math.max(...targets.map((t) => t.recurrenceCount));
  console.log(`\n${noRecurrence} order blocks with no same-timeframe recurrence, ${recurrent} with some (${((recurrent / targets.length) * 100).toFixed(1)}%)`);
  console.log(`Max recurrence depth: ${maxRecurrence} same-timeframe order blocks stacked together`);
}

main();
