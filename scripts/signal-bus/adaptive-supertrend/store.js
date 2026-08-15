// SQLite storage for the Adaptive SuperTrend signal bus. Own DB file
// (data/signal-bus/adaptive-supertrend.db), same per-indicator-bus pattern as the rest of
// scripts/signal-bus/. First time this indicator (scripts/lib/adaptive-supertrend.js, used live and
// in the backtest lab) is wired into the calc/store/build-historical pattern -- its only house
// finding so far (significance-register.md #10/#11) is that a raw single-timeframe flip is
// falsified as a standalone edge; this bus exists to test nested cross-timeframe confirmation.

import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "fs";

const DB_DIR = new URL("../../../data/signal-bus/", import.meta.url);
const DB_PATH = new URL("adaptive-supertrend.db", DB_DIR);

const SCHEMA = `
CREATE TABLE IF NOT EXISTS runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
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
  timeframe TEXT NOT NULL,
  direction TEXT NOT NULL CHECK(direction IN ('bullish','bearish')),
  bar_idx INTEGER NOT NULL,
  time INTEGER NOT NULL,
  price REAL NOT NULL,
  volatility_regime TEXT CHECK(volatility_regime IN ('HIGH','MEDIUM','LOW'))
);
CREATE INDEX IF NOT EXISTS idx_events_tf_time ON events(timeframe, time);
`;

export function openStore() {
  mkdirSync(DB_DIR, { recursive: true });
  const db = new DatabaseSync(DB_PATH);
  db.exec(SCHEMA);
  return db;
}

export function clearAll(db) {
  db.exec("BEGIN");
  try {
    db.exec("DELETE FROM events");
    db.exec("DELETE FROM runs");
    db.exec("COMMIT");
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
}

export function insertRun(db, { timeframe, candles, gitCommit }) {
  const stmt = db.prepare(
    "INSERT INTO runs (timeframe, candle_count, range_start, range_end, git_commit, generated_at) VALUES (?, ?, ?, ?, ?, ?)",
  );
  const info = stmt.run(timeframe, candles.length, candles[0].t, candles[candles.length - 1].t, gitCommit, new Date().toISOString());
  return Number(info.lastInsertRowid);
}

export function insertEvents(db, { runId, timeframe, events }) {
  db.exec("BEGIN");
  try {
    const stmt = db.prepare(
      "INSERT INTO events (run_id, timeframe, direction, bar_idx, time, price, volatility_regime) VALUES (?, ?, ?, ?, ?, ?, ?)",
    );
    for (const e of events) stmt.run(runId, timeframe, e.direction, e.barIdx, e.time, e.price, e.volatilityRegime ?? null);
    db.exec("COMMIT");
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
}
