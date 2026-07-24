#!/usr/bin/env node
// One-time (re-runnable) import: decodes S:\Housekeeping\junkyard\Binance_Historical_Data.db
// into clean per-timeframe CSVs under data/historical/, for the backtesting lab's data layer
// (ARCHITECTURE.md §6). Binance BTC spot, 2017-08-17 onward -- a proxy for our actual instrument,
// same caveat as the SuperTrend monitor's Bitstamp proxy.
//
// Must run via PowerShell, not Bash -- the S: drive mapping is session-scoped and doesn't
// propagate to Bash's subprocess (confirmed 2026-07-24: Node launched from Bash can't see S:,
// launched from PowerShell can).
//
// Decode gotcha (see ARCHITECTURE.md §6): the source DB's `timestamp` column is declared TEXT
// but stores raw binary -- little-endian int64, nanoseconds since Unix epoch (a pandas/numpy
// to_sql() quirk). Confirmed against known BTC price history before trusting this script.
//
// Usage (from PowerShell):
//   node scripts/backtest/import-historical-data.js
//   node scripts/backtest/import-historical-data.js --source "S:\Housekeeping\junkyard\Binance_Historical_Data.db"

import { DatabaseSync } from "node:sqlite";
import { createWriteStream, mkdirSync } from "fs";
import { once } from "events";

const SOURCE_ARG = process.argv.find((a) => a.startsWith("--source="));
const SOURCE_PATH = SOURCE_ARG
  ? SOURCE_ARG.split("=")[1]
  : "S:\\Housekeeping\\junkyard\\Binance_Historical_Data.db";

const OUT_DIR = new URL("../../data/historical/", import.meta.url);
const CHUNK_SIZE = 100_000; // bounds memory for the 3.87M-row T_1m table

const ONLY_ARG = process.argv.find((a) => a.startsWith("--only="));
const TABLES = ONLY_ARG
  ? ONLY_ARG.split("=")[1].split(",")
  : ["T_1m", "T_2m", "T_3m", "T_5m", "T_15m", "T_30m",
     "T_1h", "T_2h", "T_4h", "T_6h", "T_12h", "T_1d", "T_5d", "T_1w"];

function decodeTsToIso(tsValue) {
  // node:sqlite returns BLOB-affinity columns as Uint8Array in this experimental API, but
  // Object.values() works whether it's a real Uint8Array/Buffer or a plain {0:.., 1:..} object
  // (tested against both during investigation) -- so this is deliberately defensive.
  const buf = Buffer.from(Object.values(tsValue));
  const ms = Number(buf.readBigInt64LE()) / 1e6;
  return new Date(ms).toISOString();
}

async function exportTable(db, tableName) {
  const outPath = new URL(`binance-btc-${tableName.replace("T_", "")}.csv`, OUT_DIR);
  const stream = createWriteStream(outPath);
  stream.write("timestamp,open,high,low,close,volume\n");

  const total = db.prepare(`SELECT COUNT(*) as c FROM "${tableName}"`).get().c;
  const stmt = db.prepare(`SELECT * FROM "${tableName}" ORDER BY rowid ASC LIMIT ? OFFSET ?`);

  let written = 0;
  let prevMs = -Infinity;
  let outOfOrder = 0;
  for (let offset = 0; offset < total; offset += CHUNK_SIZE) {
    const rows = stmt.all(CHUNK_SIZE, offset);
    let buf = "";
    for (const r of rows) {
      const iso = decodeTsToIso(r.timestamp);
      const ms = Date.parse(iso);
      if (ms < prevMs) outOfOrder++;
      prevMs = ms;
      buf += `${iso},${r.open},${r.high},${r.low},${r.close},${r.volume}\n`;
    }
    if (!stream.write(buf)) await once(stream, "drain");
    written += rows.length;
  }

  stream.end();
  await once(stream, "finish");
  return { table: tableName, rows: written, outOfOrder, outPath: outPath.pathname.replace(/^\/([A-Z]:)/, "$1") };
}

async function main() {
  mkdirSync(new URL(".", OUT_DIR), { recursive: true });

  console.log(`Source: ${SOURCE_PATH}`);
  const db = new DatabaseSync(SOURCE_PATH, { readOnly: true });

  const results = [];
  for (const table of TABLES) {
    process.stdout.write(`  ${table} ... `);
    const result = await exportTable(db, table);
    console.log(`${result.rows} rows -> ${result.outPath}${result.outOfOrder ? ` (WARN: ${result.outOfOrder} out-of-order rows)` : ""}`);
    results.push(result);
  }
  db.close();

  console.log(`\nDone. ${results.reduce((s, r) => s + r.rows, 0).toLocaleString()} total rows imported.`);
  const anomalies = results.filter((r) => r.outOfOrder > 0);
  if (anomalies.length) {
    console.log(`WARNING: out-of-order timestamps found in: ${anomalies.map((a) => a.table).join(", ")}`);
  }
}

main().catch((err) => {
  console.error("Fatal:", err.message);
  process.exit(1);
});
