#!/usr/bin/env node
// Background runner for pine/ml-adaptive-supertrend-algoalpha.pine (K-Means Adaptive SuperTrend).
// Read-only: pulls public OHLC candles and recomputes the indicator in JS. No orders, no exchange
// keys, nothing written except a status file. Independent of whatever chart TradingView Desktop
// currently has open — safe to run continuously alongside it.
//
// Usage:
//   node scripts/supertrend-monitor.js             # loop forever, one pass per bar-aligned interval
//   node scripts/supertrend-monitor.js --once       # single pass, print + write status, exit
//   node scripts/supertrend-monitor.js --interval=60 # poll every 60s instead of the default 300s

import { readFileSync, writeFileSync } from "fs";
import { scanAdaptiveSuperTrend, TF_TO_STEP } from "./lib/adaptive-supertrend.js";

const args = process.argv.slice(2);
const ONCE = args.includes("--once");
const intervalArg = args.find((a) => a.startsWith("--interval="));
const POLL_SECONDS = intervalArg ? parseInt(intervalArg.split("=")[1], 10) : 300;

const RULES_PATH = new URL("../rules.json", import.meta.url);
const STATUS_PATH = new URL("../supertrend-status.json", import.meta.url);

function loadRules() {
  const rules = JSON.parse(readFileSync(RULES_PATH, "utf8"));
  const tf = TF_TO_STEP[rules.default_timeframe] ? rules.default_timeframe : "240";
  if (!TF_TO_STEP[rules.default_timeframe]) {
    console.warn(`  ⚠ Unrecognized default_timeframe "${rules.default_timeframe}" — defaulting to 4H`);
  }
  return { watchlist: rules.watchlist, timeframe: tf, proxyMap: rules.supertrend_proxy || {} };
}

async function runOnce() {
  const { watchlist, timeframe, proxyMap } = loadRules();
  const results = [];
  for (const symbol of watchlist) {
    // Bitstamp (our candle source here) doesn't list every TradingView-facing instrument --
    // e.g. Coinbase Derivatives futures -- so watchlist entries can map to a spot proxy pair.
    const proxySymbol = proxyMap[symbol] || symbol;
    try {
      const result = await scanAdaptiveSuperTrend(proxySymbol, timeframe);
      results.push({ ...result, symbol, proxy_symbol: proxySymbol !== symbol ? proxySymbol : undefined });
    } catch (err) {
      results.push({ symbol, proxy_symbol: proxySymbol !== symbol ? proxySymbol : undefined, error: err.message });
    }
  }

  const status = { generated_at: new Date().toISOString(), timeframe, symbols: results };
  writeFileSync(STATUS_PATH, JSON.stringify(status, null, 2));

  console.log(`\n[${status.generated_at}] Adaptive SuperTrend (${timeframe})`);
  for (const r of results) {
    if (r.error) {
      console.log(`  ${r.symbol}: ⚠ ${r.error}`);
      continue;
    }
    const arrow = r.direction === "bullish" ? "▲" : "▼";
    const flip = r.last_flip
      ? ` | flipped ${r.last_flip.direction} ${r.last_flip.bars_ago} bar(s) ago @ ${r.last_flip.price_at_flip}`
      : "";
    const proxyNote = r.proxy_symbol ? ` [via ${r.proxy_symbol} proxy]` : "";
    console.log(
      `  ${r.symbol}${proxyNote}: ${arrow} ${r.direction.toUpperCase()} | ST ${r.supertrend} | price ${r.price} | vol: ${r.volatility_regime}${flip}`,
    );
  }
  return status;
}

async function main() {
  await runOnce();
  if (ONCE) return;

  console.log(`\nRunning in background — polling every ${POLL_SECONDS}s. Ctrl+C to stop.`);
  console.log(`Status written to: ${STATUS_PATH.pathname.replace(/^\/([A-Z]:)/, "$1")}\n`);
  setInterval(() => {
    runOnce().catch((err) => console.error("Pass failed:", err.message));
  }, POLL_SECONDS * 1000);
}

main().catch((err) => {
  console.error("Fatal:", err.message);
  process.exit(1);
});
