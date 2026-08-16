// SQLite storage for the Adaptive SuperTrend signal bus. Own DB file
// (data/signal-bus/adaptive-supertrend.db), same per-indicator-bus pattern as the rest of
// scripts/signal-bus/. First time this indicator (scripts/lib/adaptive-supertrend.js, used live and
// in the backtest lab) is wired into the calc/store/build-historical pattern -- its only house
// finding so far (significance-register.md #10/#11) is that a raw single-timeframe flip is
// falsified as a standalone edge; this bus exists to test nested cross-timeframe confirmation.

import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "fs";
import { migrateInstrument, requireInstrument } from "../lib/instrument.js";

const DB_DIR = new URL("../../../data/signal-bus/", import.meta.url);
// Per-instrument DB files (2026-08-15). BTC deliberately KEEPS its original filename so the ~74
// analysis scripts that open this store keep reading BTC without a single edit -- that is the
// whole reason separate files were chosen over a shared table with an instrument predicate. A
// reader cannot accidentally blend instruments here, because the other instrument's rows are not
// in the file at all.
//
// The `instrument` COLUMN is retained on top of this as defence in depth: it makes a mis-pointed
// build detectable (a BTC-labelled row sitting inside adaptive-supertrend-eth.db is a visible bug) rather than
// silent, and clearAll stays instrument-scoped for the same reason.
const DB_FILES = {
  BTC: "adaptive-supertrend.db",
  ETH: "adaptive-supertrend-eth.db",
  SOL: "adaptive-supertrend-sol.db",
};

function dbPathFor(instrument) {
  const file = DB_FILES[instrument];
  if (!file) throw new Error(`unknown instrument '${instrument}'; known: ${Object.keys(DB_FILES).join(", ")}`);
  return new URL(file, DB_DIR);
}

const INSTRUMENT_TABLES = [
  { name: "runs", hasTimeframe: true },
  { name: "events", hasTimeframe: true },
];

const SCHEMA = `
CREATE TABLE IF NOT EXISTS runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  instrument TEXT NOT NULL DEFAULT 'BTC',
  timeframe TEXT NOT NULL,
  candle_count INTEGER NOT NULL,
  range_start INTEGER NOT NULL,
  range_end INTEGER NOT NULL,
  git_commit TEXT,
  generated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id INTEGER NOT NULL REFERENCES runs(id),
  instrument TEXT NOT NULL DEFAULT 'BTC',
  timeframe TEXT NOT NULL,
  direction TEXT NOT NULL CHECK(direction IN ('bullish','bearish')),
  bar_idx INTEGER NOT NULL,
  time INTEGER NOT NULL,
  price REAL NOT NULL,
  volatility_regime TEXT CHECK(volatility_regime IN ('HIGH','MEDIUM','LOW'))
);
CREATE INDEX IF NOT EXISTS idx_events_tf_time ON events(timeframe, time);
`;

export function openStore(instrument = "BTC") {
  mkdirSync(DB_DIR, { recursive: true });
  const db = new DatabaseSync(dbPathFor(instrument));
  db.exec(SCHEMA);
  migrateInstrument(db, INSTRUMENT_TABLES);
  return db;
}

// Instrument-scoped by design (2026-08-15). This used to be an unscoped `DELETE FROM` -- which,
// once a second instrument exists, means an ETH rebuild silently destroys the entire BTC corpus.
// The instrument argument is required, never defaulted, for exactly that reason.
export function clearAll(db, instrument) {
  requireInstrument(instrument);
  db.exec("BEGIN");
  try {
    db.prepare("DELETE FROM events WHERE instrument = ?").run(instrument);
    db.prepare("DELETE FROM runs WHERE instrument = ?").run(instrument);
    db.exec("COMMIT");
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
}

export function insertRun(db, { instrument, timeframe, candles, gitCommit }) {
  requireInstrument(instrument);
  const stmt = db.prepare(
    "INSERT INTO runs (instrument, timeframe, candle_count, range_start, range_end, git_commit, generated_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
  );
  const info = stmt.run(instrument, timeframe, candles.length, candles[0].t, candles[candles.length - 1].t, gitCommit, new Date().toISOString());
  return Number(info.lastInsertRowid);
}

export function insertEvents(db, { instrument, runId, timeframe, events }) {
  requireInstrument(instrument);
  db.exec("BEGIN");
  try {
    const stmt = db.prepare(
      "INSERT INTO events (run_id, instrument, timeframe, direction, bar_idx, time, price, volatility_regime) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    );
    for (const e of events) stmt.run(runId, instrument, timeframe, e.direction, e.barIdx, e.time, e.price, e.volatilityRegime ?? null);
    db.exec("COMMIT");
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
}
