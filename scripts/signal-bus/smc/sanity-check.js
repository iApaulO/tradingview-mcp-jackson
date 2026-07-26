#!/usr/bin/env node
// First-pass verification of calc.js against real historical data, same purpose as
// divergence-for-many's sanity-check.js: are the counts plausible, do example price levels/dates
// look like real BTC history, before trusting this enough to build touches/storage on top of it.
//
// Usage: node scripts/signal-bus/smc/sanity-check.js --tf=4h

import { loadCandles } from "../../backtest/lib/load-candles.js";
import { computeSMC } from "./calc.js";

const args = Object.fromEntries(process.argv.slice(2).map((a) => a.replace(/^--/, "").split("=")));
const TF = args.tf || "4h";

function fmt(t) {
  return new Date(t * 1000).toISOString().slice(0, 16).replace("T", " ");
}

async function main() {
  const candles = await loadCandles(TF);
  console.log(`Loaded ${candles.length.toLocaleString()} ${TF} candles (${fmt(candles[0].t)} -> ${fmt(candles[candles.length - 1].t)})`);

  const t0 = Date.now();
  const { structureEvents, eqhEqlEvents, orderBlocks } = computeSMC(candles);
  console.log(`Computed in ${((Date.now() - t0) / 1000).toFixed(1)}s\n`);

  for (const scope of ["internal", "swing"]) {
    const evs = structureEvents.filter((e) => e.scope === scope);
    const bos = evs.filter((e) => e.type === "BOS").length;
    const choch = evs.filter((e) => e.type === "CHOCH").length;
    const bull = evs.filter((e) => e.side === "bullish").length;
    const bear = evs.filter((e) => e.side === "bearish").length;
    console.log(`${scope} structure: ${evs.length} events (${bos} BOS, ${choch} CHoCH | ${bull} bullish, ${bear} bearish)`);
  }

  const eqh = eqhEqlEvents.filter((e) => e.side === "EQH").length;
  const eql = eqhEqlEvents.filter((e) => e.side === "EQL").length;
  console.log(`\nEQH/EQL: ${eqhEqlEvents.length} events (${eqh} EQH @ ${_c('#F23645')}, ${eql} EQL @ ${_c('#089981')})`);

  for (const scope of ["internal", "swing"]) {
    const obs = orderBlocks.filter((o) => o.scope === scope);
    const active = obs.filter((o) => o.status === "active").length;
    const mitigated = obs.filter((o) => o.status === "mitigated").length;
    const bull = obs.filter((o) => o.side === "bullish");
    const bear = obs.filter((o) => o.side === "bearish");
    console.log(`${scope} order blocks: ${obs.length} total (${active} active, ${mitigated} mitigated) -- ${bull.length} bullish [${bull[0]?.color}], ${bear.length} bearish [${bear[0]?.color}]`);
  }

  function _c(hex) { return hex; }

  console.log("\nFirst 5 swing structure events:");
  for (const e of structureEvents.filter((e) => e.scope === "swing").slice(0, 5)) {
    console.log(`  ${fmt(e.time)} ${e.scope} ${e.type} ${e.side} @ ${e.price.toFixed(2)} [${e.color}]`);
  }
  console.log("\nLast 5 swing structure events:");
  for (const e of structureEvents.filter((e) => e.scope === "swing").slice(-5)) {
    console.log(`  ${fmt(e.time)} ${e.scope} ${e.type} ${e.side} @ ${e.price.toFixed(2)} [${e.color}]`);
  }

  console.log("\nFirst 5 swing order blocks:");
  for (const o of orderBlocks.filter((o) => o.scope === "swing").slice(0, 5)) {
    console.log(`  ${o.side.padEnd(8)} origin=${fmt(o.originTime)} range=[${o.barLow.toFixed(2)}, ${o.barHigh.toFixed(2)}] created=${fmt(o.createdTime)} status=${o.status} color=${o.color}`);
  }

  console.log("\nFirst 5 EQH/EQL:");
  for (const e of eqhEqlEvents.slice(0, 5)) {
    console.log(`  ${e.side.padEnd(4)} level=${e.level.toFixed(2)} pivot=${fmt(e.pivotTime)} confirmed=${fmt(e.confirmTime)} color=${e.color}`);
  }
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
