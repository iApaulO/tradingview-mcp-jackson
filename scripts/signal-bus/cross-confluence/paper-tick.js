#!/usr/bin/env node
// FULL PAPER-TRADING TICK -- refresh market data, rebuild the structure it depends on, then run the
// K>=3 paper engine. This is the thing to schedule; `paper-trade-k3.js` alone reads whatever corpus
// happens to be on disk and will therefore never see a new cluster.
//
// WHY A SEPARATE FILE. `paper-trade-k3.js` must stay pure: it opens and manages positions and
// nothing else, so it can be re-run freely, reasoned about, and audited without wondering whether
// it also mutated the corpus underneath itself. Data acquisition and corpus rebuild are a different
// concern with different failure modes (network, rate limits, partial writes), and mixing them into
// the ledger writer is how a fetch failure ends up looking like a trading decision.
//
// ORDER IS LOAD-BEARING, and it is the reverse of what feels natural:
//   1. fetch native candles (5m/15m/1h/1d) from Binance
//   2. rebuild the SYNTHESISED rungs (2h/3h/4h/1w) from them -- these are derived, so they are
//      stale the instant step 1 lands
//   3. rebuild the SMC corpus, which is what the co-occurrence clusters are read from
//   4. run the paper engine
// Skipping step 2 leaves 4h/2h/3h/1w silently behind the native rungs, and a cluster is defined
// ACROSS rungs -- so a stale coarse rung does not produce an error, it produces a wrong cluster.
//
// FAILURE POLICY: any step failing ABORTS the tick. A partial refresh is worse than no refresh,
// because the paper engine cannot tell the difference between "no new cluster" and "the rung that
// would have carried it was never updated". The ledger is left untouched and the next tick retries.
//
// Usage:
//   node scripts/signal-bus/cross-confluence/paper-tick.js
//   node scripts/signal-bus/cross-confluence/paper-tick.js --instruments=BTC,ETH
//   node scripts/signal-bus/cross-confluence/paper-tick.js --no-fetch     # rebuild + trade only

import { spawnSync } from "child_process";

const args = Object.fromEntries(
  process.argv.slice(2).filter((a) => a.includes("=")).map((a) => a.replace(/^--/, "").split("=")),
);
const INSTRUMENTS = (args.instruments || "BTC,ETH,SOL").split(",").map((s) => s.trim()).filter(Boolean);
const NO_FETCH = process.argv.includes("--no-fetch");
const ROOT = new URL("../../../", import.meta.url);

function run(label, script, scriptArgs) {
  process.stdout.write(`  ${label} ... `);
  const t0 = Date.now();
  const r = spawnSync(process.execPath, [script, ...scriptArgs], { cwd: ROOT, encoding: "utf8" });
  const secs = ((Date.now() - t0) / 1000).toFixed(1);
  if (r.status !== 0) {
    console.log(`FAILED (${secs}s)`);
    console.log((r.stderr || r.stdout || "").split("\n").slice(-12).join("\n"));
    return false;
  }
  console.log(`ok (${secs}s)`);
  return true;
}

function main() {
  console.log(`PAPER TICK  ${new Date().toISOString()}`);
  console.log(`instruments: ${INSTRUMENTS.join(", ")}${NO_FETCH ? "   [--no-fetch]" : ""}\n`);

  for (const inst of INSTRUMENTS) {
    console.log(`${inst}:`);
    if (!NO_FETCH) {
      // repair mode re-fetches from the 2025-01-01 seam forward, which subsumes "append the newest
      // bars" and needs no separate incremental path. Slower, but it cannot leave a hole.
      if (!run("fetch native candles", "scripts/backtest/fetch-binance-history.js", [`--mode=${inst === "BTC" ? "repair" : "full"}`, `--instrument=${inst}`])) {
        console.log("\nABORT: refresh failed, ledger untouched. Next tick retries.");
        process.exit(1);
      }
    }
    if (!run("rebuild synthesised rungs", "scripts/backtest/build-aggregated-candles.js", [`--instrument=${inst}`])) {
      console.log("\nABORT: aggregation failed, ledger untouched.");
      process.exit(1);
    }
    if (!run("rebuild SMC corpus", "scripts/signal-bus/smc/build-historical.js", [`--instrument=${inst}`])) {
      console.log("\nABORT: SMC rebuild failed, ledger untouched.");
      process.exit(1);
    }
    // MUST follow build-historical, which resets the annotations this writes back onto order_blocks.
    // Strategy A2 filters on recurrence_count >= 3, so skipping this does NOT error -- it silently
    // yields zero A2 signals, which is indistinguishable from "the market produced none". Caught
    // by hand on 2026-08-17 before the first populated tick; rebuild-all.js documents the same
    // dependency and this orchestrator was violating it.
    if (!run("rebuild confluence/recurrence", "scripts/signal-bus/smc/build-confluence.js", [`--instrument=${inst}`])) {
      console.log("\nABORT: confluence rebuild failed, ledger untouched.");
      process.exit(1);
    }
  }

  console.log("");
  // Two ledgers, deliberately separate. paper-trade-k3 is the pre-registered construction on its
  // own terms; paper-trade-all carries all four validated constructions with their evidence tier
  // recorded per row. K>=3 appears in both, which is intentional -- the dedicated ledger is the one
  // that answers #143's gate, and flattening it into the multi-strategy table would lose that.
  let bad = 0;
  for (const s of ["paper-trade-k3.js", "paper-trade-all.js"]) {
    const r = spawnSync(process.execPath, [`scripts/signal-bus/cross-confluence/${s}`], { cwd: ROOT, encoding: "utf8", stdio: "inherit" });
    if (r.status !== 0) bad++;
  }
  process.exit(bad ? 1 : 0);
}

main();
