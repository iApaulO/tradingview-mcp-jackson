// SQLite storage for the VuManChu Cipher A signal bus. Own DB file (data/signal-bus/cipher-a.db),
// same per-indicator-bus pattern as boom-hunter.db / smc.db / vmc-cipher-b.db / divergence-for-many.db.
// First signal-bus for Cipher A -- calc.js's functions (yellowCross, greenDot, ribbon signals,
// emaRegime) previously only ever ran ad-hoc, imported inline from within vmc-cipher-b/ scripts,
// never persisted to their own store (see PRIOR_ART.md, updated alongside this file).

import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "fs";

const DB_DIR = new URL("../../../data/signal-bus/", import.meta.url);
const DB_PATH = new URL("cipher-a.db", DB_DIR);

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
  return db;
}

export function clearAll(db) {
  db.exec("BEGIN");
  try {
    db.exec("DELETE FROM regime_changes");
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
      "INSERT INTO events (run_id, timeframe, type, side, bar_idx, time, price) VALUES (?, ?, ?, ?, ?, ?, ?)",
    );
    for (const e of events) stmt.run(runId, timeframe, e.type, e.side ?? null, e.barIdx, e.time, e.price);
    db.exec("COMMIT");
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
}

export function insertRegimeChanges(db, { runId, timeframe, changes }) {
  db.exec("BEGIN");
  try {
    const stmt = db.prepare(
      "INSERT INTO regime_changes (run_id, timeframe, regime, bar_idx, time, price) VALUES (?, ?, ?, ?, ?, ?)",
    );
    for (const c of changes) stmt.run(runId, timeframe, c.regime, c.barIdx, c.time, c.price);
    db.exec("COMMIT");
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
}
