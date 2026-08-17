// SQLite storage for the Boom Hunter Pro signal bus. Own DB file (data/signal-bus/boom-hunter.db),
// same per-indicator-bus pattern as cipher-b.db / smc.db / divergence-for-many.db.

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
// build detectable (a BTC-labelled row sitting inside boom-hunter-eth.db is a visible bug) rather than
// silent, and clearAll stays instrument-scoped for the same reason.
const DB_FILES = {
  BTC: "boom-hunter.db",
  ETH: "boom-hunter-eth.db",
  SOL: "boom-hunter-sol.db",
};

function dbPathFor(instrument) {
  const file = DB_FILES[instrument];
  if (!file) throw new Error(`unknown instrument '${instrument}'; known: ${Object.keys(DB_FILES).join(", ")}`);
  return new URL(file, DB_DIR);
}

const INSTRUMENT_TABLES = [
  { name: "runs", hasTimeframe: true },
  { name: "events", hasTimeframe: true },
  { name: "eot3_episodes", hasTimeframe: true },
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
  instrument TEXT NOT NULL DEFAULT 'BTC',
  run_id INTEGER NOT NULL REFERENCES runs(id),
  timeframe TEXT NOT NULL,
  type TEXT NOT NULL CHECK(type IN ('continuation','long_lime','long_blue','long_gray','long_yellow','break_short','bearish_continuation','boom_dead','long_enter4','long_dead_enter')),
  bar_idx INTEGER NOT NULL,
  time INTEGER NOT NULL,
  price REAL NOT NULL,
  q1 REAL NOT NULL,
  -- Full oscillator state at the event bar, added 2026-08-16 with the Quotient4 port. Deliberately
  -- NULLABLE, not NOT NULL: rows written by any build predating this change legitimately have no
  -- value here, and a NOT NULL column would force a fabricated default that a later reader could
  -- not distinguish from a real reading. q3/q4 are the EOT2 red-wave pair (their DIFFERENCE is the
  -- filled band width the chart actually shows); q5/q6 are the EOT3 yellow/blue pair.
  q3 REAL,
  q4 REAL,
  q5 REAL,
  q6 REAL
);
CREATE INDEX IF NOT EXISTS idx_events_tf_time ON events(timeframe, time);
CREATE INDEX IF NOT EXISTS idx_events_tf_type ON events(timeframe, type);

-- EOT3 (q5, "the yellow line") down-episodes, persisted 2026-08-09 -- previously recomputed fresh
-- in every consuming script (significance-register.md #66/#67). One row per resolved episode
-- (crossunder through 50 to the next crossover back above); unresolved/ongoing episodes at the end
-- of available data are not stored, matching #66's own exclusion rule.
CREATE TABLE IF NOT EXISTS eot3_episodes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  instrument TEXT NOT NULL DEFAULT 'BTC',
  run_id INTEGER NOT NULL REFERENCES runs(id),
  timeframe TEXT NOT NULL,
  start_bar_idx INTEGER NOT NULL,
  start_time INTEGER NOT NULL,
  end_bar_idx INTEGER NOT NULL,
  end_time INTEGER NOT NULL,
  has_flag INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_eot3_tf_time ON eot3_episodes(timeframe, start_time);
`;

// `CREATE TABLE IF NOT EXISTS` is a no-op on a table that already exists, so new columns added to
// SCHEMA never reach a database built before they were declared. This performs the ALTER
// explicitly, idempotently, on the same principle as migrateInstrument.
function migrateEventQuotients(db) {
  const existing = new Set(db.prepare("PRAGMA table_info(events)").all().map((r) => r.name));
  for (const col of ["q3", "q4", "q5", "q6"]) {
    if (!existing.has(col)) db.exec(`ALTER TABLE events ADD COLUMN ${col} REAL`);
  }
}

export function openStore(instrument = "BTC") {
  mkdirSync(DB_DIR, { recursive: true });
  const db = new DatabaseSync(dbPathFor(instrument));
  db.exec(SCHEMA);
  migrateInstrument(db, INSTRUMENT_TABLES);
  migrateEventQuotients(db);
  return db;
}

// Instrument-scoped by design (2026-08-15) -- an unscoped DELETE here would let an ETH rebuild
// destroy the entire BTC corpus. Required argument, never defaulted.
export function clearAll(db, instrument) {
  requireInstrument(instrument);
  db.exec("BEGIN");
  try {
    for (const t of ["eot3_episodes", "events", "runs"]) {
      db.prepare(`DELETE FROM ${t} WHERE instrument = ?`).run(instrument);
    }
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
      "INSERT INTO events (run_id, instrument, timeframe, type, bar_idx, time, price, q1, q3, q4, q5, q6) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    );
    // A non-finite quotient is stored as NULL rather than NaN: SQLite has no NaN, and binding one
    // would either throw or silently land as 0.0 -- a value indistinguishable from a real reading.
    const num = (v) => (Number.isFinite(v) ? v : null);
    for (const e of events) {
      stmt.run(runId, instrument, timeframe, e.type, e.barIdx, e.time, e.price, e.q1, num(e.q3), num(e.q4), num(e.q5), num(e.q6));
    }
    db.exec("COMMIT");
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
}

export function insertEot3Episodes(db, { instrument, runId, timeframe, episodes }) {
  requireInstrument(instrument);
  db.exec("BEGIN");
  try {
    const stmt = db.prepare(
      "INSERT INTO eot3_episodes (run_id, instrument, timeframe, start_bar_idx, start_time, end_bar_idx, end_time, has_flag) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    );
    for (const e of episodes) {
      stmt.run(runId, instrument, timeframe, e.startBarIdx, e.startTime, e.endBarIdx, e.endTime, e.hasFlag ? 1 : 0);
    }
    db.exec("COMMIT");
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
}
