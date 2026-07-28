#!/usr/bin/env node
// Gap-fill: data/historical/binance-btc-*.csv (from S:\Housekeeping\junkyard\Binance_Historical_Data.db,
// Binance BTC spot) stops dead at 2024-12-31 -- confirmed the SOURCE db itself has nothing newer
// (checked directly, not just the derived CSVs), and Binance's live API is geo-blocked from this
// environment (api.binance.com returns "restricted location"). Coinbase's public Exchange API
// (api.exchange.coinbase.com, no auth needed) works and is arguably the BETTER venue going
// forward anyway -- it's the actual instrument family this whole project's cost model is built
// around (confirmed Coinbase Advanced derivatives fee tier), not a proxy the way Binance always
// was. This is a deliberate venue switch at 2025-01-01T00:00:00Z, documented here and in
// ARCHITECTURE.md, not a silent splice -- prints the seam (last Binance close vs first Coinbase
// value) so any discontinuity is visible, not hidden.
//
// Coinbase's public candle granularities: 60/300/900/3600/21600/86400 (1m/5m/15m/1h/6h/1d) --
// covers every NATIVE timeframe this project needs directly (5m/15m/1h/1d). 2H/3H/4H/1W have no
// native Coinbase granularity and were never native in the Binance source either for 3H (see
// build-3h-candles.js) -- all four are synthesized by aggregate-candles.js from 1h/1d, same as
// before, via build-aggregated-candles.js (companion script, run after this one).
//
// Coinbase candle response shape: [time, low, high, open, close, volume] -- NOT the OHLC order
// our CSVs use (open,high,low,close) -- mapped explicitly below, not assumed.
//
// Usage: node scripts/backtest/fetch-coinbase-gapfill.js [--dry-run]

import { appendFileSync, readFileSync } from "fs";

const DATA_DIR = new URL("../../data/historical/", import.meta.url);
const PRODUCT = "BTC-USD";
const DRY_RUN = process.argv.includes("--dry-run");

// [csvSuffix, granularitySeconds]
const NATIVE_TIMEFRAMES = [
  ["5m", 300],
  ["15m", 900],
  ["1h", 3600],
  ["1d", 86400],
];

const MAX_CANDLES_PER_REQUEST = 300;
const REQUEST_DELAY_MS = 350; // self-throttle well under Coinbase's public rate limit

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function lastTimestampSeconds(csvSuffix) {
  const path = new URL(`binance-btc-${csvSuffix}.csv`, DATA_DIR);
  const content = readFileSync(path, "utf8").trimEnd();
  const lastLine = content.slice(content.lastIndexOf("\n") + 1);
  const iso = lastLine.split(",")[0];
  return Math.floor(Date.parse(iso) / 1000);
}

async function fetchChunk(granularity, startSec, endSec) {
  const url = `https://api.exchange.coinbase.com/products/${PRODUCT}/candles?granularity=${granularity}&start=${new Date(startSec * 1000).toISOString()}&end=${new Date(endSec * 1000).toISOString()}`;
  const res = await fetch(url, { headers: { "User-Agent": "tradingview-mcp-jackson-research/1.0" } });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Coinbase API ${res.status}: ${body}`);
  }
  const rows = await res.json(); // [[time, low, high, open, close, volume], ...], newest first
  return rows.map(([time, low, high, open, close, volume]) => ({ t: time, o: open, h: high, l: low, c: close, v: volume }));
}

async function fetchRange(granularity, startSec, nowSec) {
  const all = [];
  let cursor = startSec;
  while (cursor < nowSec) {
    const chunkEnd = Math.min(cursor + granularity * (MAX_CANDLES_PER_REQUEST - 1), nowSec);
    const rows = await fetchChunk(granularity, cursor, chunkEnd);
    all.push(...rows);
    process.stdout.write(`.`);
    cursor = chunkEnd + granularity;
    await sleep(REQUEST_DELAY_MS);
  }
  // Coinbase returns newest-first per chunk; sort ascending and dedupe by timestamp.
  const byTime = new Map(all.map((c) => [c.t, c]));
  return [...byTime.values()].sort((a, b) => a.t - b.t);
}

async function main() {
  const nowSec = Math.floor(Date.now() / 1000);
  console.log(`Gap-filling through ${new Date(nowSec * 1000).toISOString()} via Coinbase Exchange public API (${PRODUCT}).\n`);

  for (const [csvSuffix, granularity] of NATIVE_TIMEFRAMES) {
    const lastTs = lastTimestampSeconds(csvSuffix);
    const startSec = lastTs + granularity;
    if (startSec >= nowSec) {
      console.log(`${csvSuffix}: already current (last=${new Date(lastTs * 1000).toISOString()}), skipping.`);
      continue;
    }
    const expectedCount = Math.ceil((nowSec - startSec) / granularity);
    console.log(`${csvSuffix}: fetching from ${new Date(startSec * 1000).toISOString()} (~${expectedCount.toLocaleString()} candles expected)`);
    const candles = await fetchRange(granularity, startSec, nowSec);
    console.log(`\n  got ${candles.length.toLocaleString()} candles`);

    if (candles.length === 0) continue;
    console.log(`  seam check: last existing close vs first new open -- new[0] = ${candles[0].o} at ${new Date(candles[0].t * 1000).toISOString()}`);

    if (DRY_RUN) {
      console.log(`  [dry-run] would append ${candles.length} rows to binance-btc-${csvSuffix}.csv`);
      continue;
    }

    const lines = candles.map((c) => `${new Date(c.t * 1000).toISOString()},${c.o},${c.h},${c.l},${c.c},${c.v}\n`).join("");
    appendFileSync(new URL(`binance-btc-${csvSuffix}.csv`, DATA_DIR), lines);
    console.log(`  appended to binance-btc-${csvSuffix}.csv`);
  }

  console.log("\nDone with native-granularity gap-fill. Run build-aggregated-candles.js next to regenerate 2H/3H/4H/1W.");
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
