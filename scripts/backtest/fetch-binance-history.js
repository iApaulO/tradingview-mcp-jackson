#!/usr/bin/env node
// Binance-native history builder, 2026-08-15. Two modes, one code path:
//
//   --mode=repair   BTC: keep every bar before the 2025-01-01 seam exactly as-is, replace
//                   everything from the seam onward with Binance native klines.
//   --mode=full     ETH: build the whole series from Binance.
//
// WHY THIS EXISTS. Binance became reachable (VPN, 2026-08-15) after being geo-blocked, which is
// what forced the Coinbase gap-fill in #124. A full comparison against live Binance found:
//   * PRE-seam  (2,694 bars): 43 differ (1.6%), all but 2 in 2017's illiquid launch window, max
//     LOW divergence 0.010% -- rounding-level, irrelevant to wick-sensitive logic. This segment
//     is effectively Binance already and is therefore NOT touched.
//   * POST-seam (590 bars, 18% of the series): 100% differ, max LOW divergence 4.90%.
// The gap-fill changed three things at once -- venue (Binance->Coinbase), quote currency
// (USDT->USD) and, critically, the wicks. Every wick-sensitive component in this project (ATR
// stops, order-block touch detection, penetration %, sweep detection, WT extreme fractals) reads
// highs and lows, so a 4.9% divergence in a daily low can flip whether a stop was hit.
//
// DELIBERATELY UNCHANGED, so the re-verification can attribute cause. Binance natively supports
// 2h/4h/1w, which this project currently SYNTHESISES from 1h/1d via build-aggregated-candles.js.
// Switching those to native would be a second simultaneous change and would make it impossible to
// tell whether a shifted register number came from the seam repair or from the aggregation change.
// This script therefore fetches exactly the same native set the old pipeline used (5m/15m/1h/1d)
// and leaves 2h/3h/4h/1w to the existing synthesis. Native 2h/4h/1w is a separate, testable
// improvement -- do it as its own change with its own verification.
//
// Quote currency: BTCUSDT / ETHUSDT. The pre-seam corpus is USDT-quoted, so staying on USDT keeps
// the repaired series internally consistent rather than introducing a second quote change.
//
// Usage:
//   node scripts/backtest/fetch-binance-history.js --mode=repair --instrument=BTC
//   node scripts/backtest/fetch-binance-history.js --mode=full   --instrument=ETH
//   [--tf=5m,15m,1h,1d] [--dry-run]

import { writeFileSync, readFileSync, existsSync } from "fs";

const DATA_DIR = new URL("../../data/historical/", import.meta.url);
const args = Object.fromEntries(
  process.argv.slice(2).filter((a) => a.includes("=")).map((a) => a.replace(/^--/, "").split("=")),
);
const DRY_RUN = process.argv.includes("--dry-run");
const MODE = args.mode || "repair";
const INSTRUMENT = args.instrument || "BTC";

// Instrument -> [binance symbol, output filename prefix]. The prefix must match
// load-candles.js's INSTRUMENT_FILE_PREFIX or the pipeline will not find the file.
const INSTRUMENTS = {
  BTC: { symbol: "BTCUSDT", prefix: "binance-btc" },
  ETH: { symbol: "ETHUSDT", prefix: "binance-eth" },
};

// The seam introduced by #124's Coinbase gap-fill. Bars before this are kept verbatim in repair
// mode; bars from here onward are replaced with Binance native.
const SEAM_MS = Date.parse("2025-01-01T00:00:00.000Z");

// Native set deliberately mirrors the OLD pipeline's native set -- see header.
const ALL_NATIVE = [
  ["1d", 86400_000],
  ["1h", 3600_000],
  ["15m", 900_000],
  ["5m", 300_000],
];
const TIMEFRAMES = args.tf ? ALL_NATIVE.filter(([k]) => args.tf.split(",").includes(k)) : ALL_NATIVE;

const MAX_LIMIT = 1000; // Binance klines hard cap
const REQUEST_DELAY_MS = 150; // klines@limit>500 costs weight 2; 1200 weight/min budget

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function firstTimestampMs(prefix, tfKey) {
  const path = new URL(`${prefix}-${tfKey}.csv`, DATA_DIR);
  const content = readFileSync(path, "utf8");
  return Date.parse(content.split("\n")[1].split(",")[0]);
}

async function fetchKlines(symbol, interval, startMs, endMs) {
  const url = `https://api.binance.com/api/v3/klines?symbol=${symbol}&interval=${interval}&startTime=${startMs}&endTime=${endMs}&limit=${MAX_LIMIT}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Binance ${res.status}: ${(await res.text()).slice(0, 200)}`);
  // [openTime, open, high, low, close, volume, closeTime, ...]
  return (await res.json()).map((k) => ({ t: k[0], o: k[1], h: k[2], l: k[3], c: k[4], v: k[5] }));
}

async function fetchRange(symbol, interval, startMs, endMs, stepMs, label) {
  const out = new Map();
  let cursor = startMs;
  let requests = 0;
  const expectedRequests = Math.max(1, Math.ceil((endMs - startMs) / (stepMs * MAX_LIMIT)));
  while (cursor <= endMs) {
    let ks;
    // Transient 429/5xx and VPN blips are expected across thousands of requests. Retry with
    // backoff rather than discarding a long fetch; a persistent failure still throws.
    for (let attempt = 1; ; attempt++) {
      try {
        ks = await fetchKlines(symbol, interval, cursor, endMs);
        break;
      } catch (err) {
        if (attempt >= 6) throw err;
        await sleep(1500 * attempt);
      }
    }
    if (!ks.length) break;
    for (const k of ks) out.set(k.t, k);
    const last = ks[ks.length - 1].t;
    if (last + stepMs <= cursor) break; // no forward progress -> end of series
    cursor = last + stepMs;
    requests++;
    if (requests % 100 === 0) {
      process.stderr.write(`  ${label}: ${requests}/~${expectedRequests} req, ${out.size.toLocaleString()} candles\n`);
    }
    await sleep(REQUEST_DELAY_MS);
  }
  return [...out.values()].sort((a, b) => a.t - b.t);
}

const csvLine = (c) => `${new Date(c.t).toISOString()},${c.o},${c.h},${c.l},${c.c},${c.v}`;

async function main() {
  const inst = INSTRUMENTS[INSTRUMENT];
  if (!inst) throw new Error(`unknown instrument ${INSTRUMENT}; known: ${Object.keys(INSTRUMENTS).join(", ")}`);
  const nowMs = Date.now();

  console.log(`Binance ${MODE} — ${INSTRUMENT} (${inst.symbol}) -> ${inst.prefix}-*.csv`);
  console.log(`Timeframes: ${TIMEFRAMES.map(([k]) => k).join(", ")}${DRY_RUN ? "  [DRY RUN]" : ""}\n`);

  for (const [tfKey, stepMs] of TIMEFRAMES) {
    const outPath = new URL(`${inst.prefix}-${tfKey}.csv`, DATA_DIR);
    let kept = [];
    let fetchFrom;

    if (MODE === "repair") {
      if (!existsSync(outPath)) throw new Error(`repair mode needs an existing ${inst.prefix}-${tfKey}.csv`);
      const lines = readFileSync(outPath, "utf8").trim().split("\n").slice(1);
      kept = lines.filter((l) => Date.parse(l.split(",")[0]) < SEAM_MS);
      fetchFrom = SEAM_MS;
      console.log(`${tfKey}: keeping ${kept.length.toLocaleString()} pre-seam bars, replacing from ${new Date(SEAM_MS).toISOString()}`);
    } else {
      // Align ETH to BTC's own first bar for this timeframe so the two series line up bar-for-bar.
      fetchFrom = firstTimestampMs(INSTRUMENTS.BTC.prefix, tfKey);
      console.log(`${tfKey}: full build from ${new Date(fetchFrom).toISOString()} (BTC-aligned)`);
    }
    if (DRY_RUN) continue;

    const fetched = await fetchRange(inst.symbol, tfKey, fetchFrom, nowMs, stepMs, `${INSTRUMENT} ${tfKey}`);
    if (!fetched.length) throw new Error(`${tfKey}: Binance returned no candles`);

    const body = [...kept, ...fetched.map(csvLine)];
    writeFileSync(outPath, "timestamp,open,high,low,close,volume\n" + body.join("\n") + "\n");

    const expected = Math.floor((nowMs - fetchFrom) / stepMs);
    const coverage = ((fetched.length / expected) * 100).toFixed(1);
    console.log(
      `  fetched ${fetched.length.toLocaleString()} (coverage ${coverage}%), total ${body.length.toLocaleString()} bars, ` +
        `${body[0].split(",")[0]} -> ${body[body.length - 1].split(",")[0]}`,
    );

    // Seam continuity check, printed not hidden -- a discontinuity here is a real data defect and
    // must be visible at build time rather than discovered later inside a backtest result.
    if (MODE === "repair" && kept.length) {
      const lastPre = Number(kept[kept.length - 1].split(",")[4]);
      const firstPost = Number(fetched[0].o);
      const gapPct = ((firstPost - lastPre) / lastPre) * 100;
      console.log(`  seam: last pre-seam close ${lastPre} -> first post-seam open ${firstPost}  (${gapPct.toFixed(4)}%)`);
      if (Math.abs(gapPct) > 1) console.log("  ^^ SEAM GAP >1% — inspect before trusting this series");
    }
    console.log("");
  }
  console.log("Done. Next: node scripts/backtest/build-aggregated-candles.js (2h/3h/4h/1w synthesis, unchanged method).");
}

main().catch((err) => {
  console.error("Fatal:", err.message);
  process.exit(1);
});
