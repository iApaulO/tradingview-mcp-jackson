// SQLite storage for the VuManChu Cipher A signal bus. Own DB file (data/signal-bus/cipher-a.db),
// same per-indicator-bus pattern as boom-hunter.db / smc.db / vmc-cipher-b.db / divergence-for-many.db.
// First signal-bus for Cipher A -- calc.js's functions (yellowCross, greenDot, ribbon signals,
// emaRegime) previously only ever ran ad-hoc, imported inline from within vmc-cipher-b/ scripts,
// never persisted to their own store (see PRIOR_ART.md, updated alongside this file).

import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "fs";
import { migrateInstrument, requireInstrument } from "../lib/instrument.js";

const DB_DIR = new URL("../../../data/signal-bus/", import.meta.url);
const DB_PATH = new URL("cipher-a.db", DB_DIR);

const INSTRUMENT_TABLES = [
  { name: "runs", hasTimeframe: true },
  { name: "events", hasTimeframe: true },
  { name: "regime_changes", hasTimeframe: true },
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
  type TEXT NOT NULL CHECK(type IN ('yellow_cross','green_dot','red_cross','blue_triangle','red_diamond','blood_diamond','bull_candle')),
  side TEXT CHECK(side IN ('bullish','bearish')),
  bar_idx INTEGER NOT NULL,
  time INTEGER NOT NULL,
  price REAL NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_events_tf_time ON events(timeframe, time);
CREATE INDEX IF NOT EXISTS idx_events_tf_type ON events(timeframe, type);

-- emaRegime is a continuous per-bar STATE (which EMA is on top right now), not a discrete event --
-- computeEmaRegime's own header explains why a "recent crossover" framing (green_dot) is often the
-- wrong lens for a slow-moving regime. Stored as transitions only (bar where the regime CHANGED),
-- same shape as the Adaptive SuperTrend flip events -- a full per-bar row would be one row per
-- candle for no benefit, the state between transitions is recoverable by nearest-prior-lookup.
CREATE TABLE IF NOT EXISTS regime_changes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  instrument TEXT NOT NULL DEFAULT 'BTC',
  run_id INTEGER NOT NULL REFERENCES runs(id),
  timeframe TEXT NOT NULL,
  regime TEXT NOT NULL CHECK(regime IN ('bullish','bearish')),
  bar_idx INTEGER NOT NULL,
  time INTEGER NOT NULL,
  price REAL NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_regime_tf_time ON regime_changes(timeframe, time);
`;

export function openStore() {
  mkdirSync(DB_DIR, { recursive: true });
  const db = new DatabaseSync(DB_PATH);
  db.exec(SCHEMA);
  migrateInstrument(db, INSTRUMENT_TABLES);
  return db;
}

// Instrument-scoped by design (2026-08-15) -- an unscoped DELETE here would let an ETH rebuild
// destroy the entire BTC corpus. Required argument, never defaulted.
export function clearAll(db, instrument) {
  requireInstrument(instrument);
  db.exec("BEGIN");
  try {
    for (const t of ["regime_changes", "events", "runs"]) {
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
      "INSERT INTO events (run_id, instrument, timeframe, type, side, bar_idx, time, price) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    );
    for (const e of events) stmt.run(runId, instrument, timeframe, e.type, e.side ?? null, e.barIdx, e.time, e.price);
    db.exec("COMMIT");
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
}

export function insertRegimeChanges(db, { instrument, runId, timeframe, changes }) {
  requireInstrument(instrument);
  db.exec("BEGIN");
  try {
    const stmt = db.prepare(
      "INSERT INTO regime_changes (run_id, instrument, timeframe, regime, bar_idx, time, price) VALUES (?, ?, ?, ?, ?, ?, ?)",
    );
    for (const c of changes) stmt.run(runId, instrument, timeframe, c.regime, c.barIdx, c.time, c.price);
    db.exec("COMMIT");
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
}
