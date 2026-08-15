#!/usr/bin/env node
// Builds ETH history from scratch via Coinbase's public Exchange API, for the 2026-08-15
// multi-instrument scope change (ETH is required for cross-market / domain-8 work -- see
// significance-register.md #126's C-1 finding that Strategy G's components are all price-derived,
// making a genuinely non-price evidence domain the highest-value addition available).
//
// WHY COINBASE AND NOT BINANCE: BTC's history is Binance spot 2017-2024 plus a Coinbase gap-fill
// from the 2025-01-01 seam (fetch-coinbase-gapfill.js). ETH gets no Binance leg at all, because
// api.binance.com is geo-blocked from this environment ("restricted location"). ETH is therefore
// Coinbase-sourced end to end -- a DIFFERENT provenance story from BTC's, which is exactly why
// load-candles.js keys instruments to source-bearing filename prefixes (binance-btc / coinbase-eth)
// rather than renaming everything to a clean scheme that would erase the distinction.
//
// PROVENANCE CAVEAT, stated not buried: BTC and ETH series come from different venues. Any
// cross-market feature built on the pair inherits a venue mismatch on top of the existing
// spot-vs-perp mismatch already disclosed in house-stack.md. This is acceptable for structural
// research and is NOT acceptable as a basis for claiming a precise lead/lag at fine timeframes,
// where venue-specific microstructure and clock differences dominate. Treat sub-hourly BTC/ETH
// timing claims as unsupported until both legs come from one venue.
//
// ALIGNMENT: start timestamps are pinned to BTC's own first bar per timeframe (read directly from
// the BTC CSVs rather than hardcoded) so the two series line up bar-for-bar. Unaligned series
// would make every cross-market comparison silently lossy at the edges.
//
// Native Coinbase granularities cover 5m/15m/1h/1d. 2H/3H/4H/1W are NOT fetched here -- they are
// synthesized afterwards by build-aggregated-candles.js, identically to BTC, which also means ETH
// inherits the Monday-anchored weekly fix from aggregate-candles.js rather than re-deriving it.
//
// Usage: node scripts/backtest/fetch-eth-history.js [--tf=1d,1h,15m,5m] [--dry-run]

import { writeFileSync, readFileSync, existsSync } from "fs";

const DATA_DIR = new URL("../../data/historical/", import.meta.url);
const PRODUCT = "ETH-USD";
const OUT_PREFIX = "coinbase-eth"; // must match load-candles.js INSTRUMENT_FILE_PREFIX.ETH
const REF_PREFIX = "binance-btc"; // alignment reference
const DRY_RUN = process.argv.includes("--dry-run");

const args = Object.fromEntries(
  process.argv.slice(2).filter((a) => a.includes("=")).map((a) => a.replace(/^--/, "").split("=")),
);

// [csvSuffix, granularitySeconds] -- Coinbase natives only.
const ALL_NATIVE = [
  ["1d", 86400],
  ["1h", 3600],
  ["15m", 900],
  ["5m", 300],
];
const NATIVE_TIMEFRAMES = args.tf
  ? ALL_NATIVE.filter(([k]) => args.tf.split(",").includes(k))
  : ALL_NATIVE;

const MAX_CANDLES_PER_REQUEST = 300;
const REQUEST_DELAY_MS = 350; // self-throttle well under Coinbase's public rate limit

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// First bar of BTC's series for this timeframe -- ETH starts at the same instant.
function btcStartSeconds(csvSuffix) {
  const path = new URL(`${REF_PREFIX}-${csvSuffix}.csv`, DATA_DIR);
  const content = readFileSync(path, "utf8");
  const firstDataLine = content.split("\n")[1];
  return Math.floor(Date.parse(firstDataLine.split(",")[0]) / 1000);
}

async function fetchChunk(granularity, startSec, endSec) {
  const url = `https://api.exchange.coinbase.com/products/${PRODUCT}/candles?granularity=${granularity}&start=${new Date(startSec * 1000).toISOString()}&end=${new Date(endSec * 1000).toISOString()}`;
  const res = await fetch(url, { headers: { "User-Agent": "tradingview-mcp-jackson-research/1.0" } });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Coinbase API ${res.status}: ${body}`);
  }
  // Response shape: [time, low, high, open, close, volume] -- NOT the OHLC order our CSVs use.
  // Mapped explicitly below, never assumed positionally downstream.
  const rows = await res.json();
  return rows.map(([time, low, high, open, close, volume]) => ({ t: time, o: open, h: high, l: low, c: close, v: volume }));
}

async function fetchRange(granularity, startSec, nowSec, label) {
  const all = new Map();
  let cursor = startSec;
  let requests = 0;
  const totalRequests = Math.ceil((nowSec - startSec) / (granularity * MAX_CANDLES_PER_REQUEST));
  while (cursor < nowSec) {
    const chunkEnd = Math.min(cursor + granularity * (MAX_CANDLES_PER_REQUEST - 1), nowSec);
    let rows;
    // Transient 5xx/429 are expected over thousands of requests; retry with backoff rather than
    // discarding a multi-hour fetch. A persistent failure still throws.
    for (let attempt = 1; ; attempt++) {
      try {
        rows = await fetchChunk(granularity, cursor, chunkEnd);
        break;
      } catch (err) {
        if (attempt >= 5) throw err;
        await sleep(1000 * attempt);
      }
    }
    for (const r of rows) all.set(r.t, r);
    cursor = chunkEnd + granularity;
    requests++;
    if (requests % 50 === 0 || requests === totalRequests) {
      process.stderr.write(`  ${label}: ${requests}/${totalRequests} requests, ${all.size.toLocaleString()} candles\n`);
    }
    await sleep(REQUEST_DELAY_MS);
  }
  // Coinbase returns newest-first per chunk; dedupe by timestamp then sort ascending.
  return [...all.values()].sort((a, b) => a.t - b.t);
}

function toCsv(candles) {
  const lines = ["timestamp,open,high,low,close,volume"];
  for (const c of candles) {
    lines.push(`${new Date(c.t * 1000).toISOString()},${c.o},${c.h},${c.l},${c.c},${c.v}`);
  }
  return lines.join("\n") + "\n";
}

async function main() {
  const nowSec = Math.floor(Date.now() / 1000);
  console.log(`ETH history build via Coinbase Exchange public API (${PRODUCT}) -> ${OUT_PREFIX}-*.csv`);
  console.log(`Timeframes: ${NATIVE_TIMEFRAMES.map(([k]) => k).join(", ")}${DRY_RUN ? "  [DRY RUN]" : ""}\n`);

  for (const [csvSuffix, granularity] of NATIVE_TIMEFRAMES) {
    const outPath = new URL(`${OUT_PREFIX}-${csvSuffix}.csv`, DATA_DIR);
    // Raw data is immutable (EEH-CITI-1.0 §27 Priority 0) -- refuse to silently overwrite an
    // existing series. Delete deliberately if a genuine rebuild is intended.
    if (existsSync(outPath) && !DRY_RUN) {
      console.log(`${csvSuffix}: ${OUT_PREFIX}-${csvSuffix}.csv already exists — skipping (delete it deliberately to rebuild).`);
      continue;
    }
    const startSec = btcStartSeconds(csvSuffix);
    const expected = Math.ceil((nowSec - startSec) / granularity);
    console.log(`${csvSuffix}: from ${new Date(startSec * 1000).toISOString()} (BTC-aligned), ~${expected.toLocaleString()} candles expected`);
    if (DRY_RUN) continue;

    const candles = await fetchRange(granularity, startSec, nowSec, csvSuffix);
    writeFileSync(outPath, toCsv(candles));
    const first = candles[0], last = candles[candles.length - 1];
    console.log(
      `  wrote ${candles.length.toLocaleString()} candles  ${new Date(first.t * 1000).toISOString()} -> ${new Date(last.t * 1000).toISOString()}`,
    );
    // Coverage check surfaced immediately: Coinbase can have gaps in early illiquid history, and a
    // silently short series would corrupt any cross-market alignment built on it.
    const coverage = ((candles.length / expected) * 100).toFixed(1);
    console.log(`  coverage vs expected: ${coverage}%${coverage < 90 ? "  <-- GAPS PRESENT, inspect before use" : ""}\n`);
  }
  console.log("Done. Next: node scripts/backtest/build-aggregated-candles.js (synthesizes 2h/3h/4h/1w for ETH).");
}

main().catch((err) => {
  console.error("Fatal:", err.message);
  process.exit(1);
});
