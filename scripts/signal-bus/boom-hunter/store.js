// SQLite storage for the Boom Hunter Pro signal bus. Own DB file (data/signal-bus/boom-hunter.db),
// same per-indicator-bus pattern as cipher-b.db / smc.db / divergence-for-many.db.

import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "fs";

const DB_DIR = new URL("../../../data/signal-bus/", import.meta.url);
const DB_PATH = new URL("boom-hunter.db", DB_DIR);

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
  type TEXT NOT NULL CHECK(type IN ('continuation','long_lime','long_blue','long_gray','long_yellow','break_short','bearish_continuation','boom_dead','long_enter4','long_dead_enter')),
  bar_idx INTEGER NOT NULL,
  time INTEGER NOT NULL,
  price REAL NOT NULL,
  q1 REAL NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_events_tf_time ON events(timeframe, time);
CREATE INDEX IF NOT EXISTS idx_events_tf_type ON events(timeframe, type);

-- EOT3 (q5, "the yellow line") down-episodes, persisted 2026-08-09 -- previously recomputed fresh
-- in every consuming script (significance-register.md #66/#67). One row per resolved episode
-- (crossunder through 50 to the next crossover back above); unresolved/ongoing episodes at the end
-- of available data are not stored, matching #66's own exclusion rule.
CREATE TABLE IF NOT EXISTS eot3_episodes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
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

export function openStore() {
  mkdirSync(DB_DIR, { recursive: true });
  const db = new DatabaseSync(DB_PATH);
  db.exec(SCHEMA);
  return db;
}

export function clearAll(db) {
  db.exec("BEGIN");
  try {
    db.exec("DELETE FROM eot3_episodes");
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
      "INSERT INTO events (run_id, timeframe, type, bar_idx, time, price, q1) VALUES (?, ?, ?, ?, ?, ?, ?)",
    );
    for (const e of events) {
      stmt.run(runId, timeframe, e.type, e.barIdx, e.time, e.price, e.q1);
    }
    db.exec("COMMIT");
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
}

export function insertEot3Episodes(db, { runId, timeframe, episodes }) {
  db.exec("BEGIN");
  try {
    const stmt = db.prepare(
      "INSERT INTO eot3_episodes (run_id, timeframe, start_bar_idx, start_time, end_bar_idx, end_time, has_flag) VALUES (?, ?, ?, ?, ?, ?, ?)",
    );
    for (const e of episodes) {
      stmt.run(runId, timeframe, e.startBarIdx, e.startTime, e.endBarIdx, e.endTime, e.hasFlag ? 1 : 0);
    }
    db.exec("COMMIT");
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
}
