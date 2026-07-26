// SQLite storage for the Divergence for Many signal bus. Own DB file (data/signal-bus/
// divergence-for-many.db), per the per-indicator-bus decision (2026-07-25) -- not a shared
// generic schema across indicators, since each indicator's signal shape differs too much.
//
// Reuses node:sqlite (DatabaseSync), same module already proven for the historical-data import
// (scripts/backtest/import-historical-data.js). This DB is fully project-local, not on the S:
// drive, so (unlike that import script) there's no PowerShell-vs-Bash launch constraint here.

import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "fs";

const DB_DIR = new URL("../../../data/signal-bus/", import.meta.url);
const DB_PATH = new URL("divergence-for-many.db", DB_DIR);

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

CREATE TABLE IF NOT EXISTS zones (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id INTEGER NOT NULL REFERENCES runs(id),
  timeframe TEXT NOT NULL,
  side TEXT NOT NULL CHECK(side IN ('bullish','bearish')),
  price REAL NOT NULL,
  created_bar_idx INTEGER NOT NULL,
  created_time INTEGER NOT NULL,
  confirmed_bar_idx INTEGER NOT NULL,
  confirmed_time INTEGER NOT NULL,
  expires_bar_idx INTEGER,
  expires_time INTEGER,
  status TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_zones_tf_price ON zones(timeframe, price);
CREATE INDEX IF NOT EXISTS idx_zones_run ON zones(run_id);

CREATE TABLE IF NOT EXISTS touches (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  zone_id INTEGER NOT NULL REFERENCES zones(id),
  start_bar_idx INTEGER NOT NULL,
  start_time INTEGER NOT NULL,
  end_bar_idx INTEGER NOT NULL,
  end_time INTEGER NOT NULL,
  bars_count INTEGER NOT NULL,
  max_penetration REAL NOT NULL,
  outcome TEXT NOT NULL CHECK(outcome IN ('held','broken')),
  ongoing INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_touches_zone ON touches(zone_id);

CREATE TABLE IF NOT EXISTS badges (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id INTEGER NOT NULL REFERENCES runs(id),
  timeframe TEXT NOT NULL,
  bar_idx INTEGER NOT NULL,
  time INTEGER NOT NULL,
  side TEXT NOT NULL CHECK(side IN ('bullish','bearish')),
  count INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_badges_tf_time ON badges(timeframe, time);
`;

export function openStore() {
  mkdirSync(DB_DIR, { recursive: true });
  const db = new DatabaseSync(DB_PATH);
  db.exec(SCHEMA);
  return db;
}

export function saveRun(db, { timeframe, candles, gitCommit, zones, badges }) {
  db.exec("BEGIN");
  try {
    const runStmt = db.prepare(
      "INSERT INTO runs (timeframe, candle_count, range_start, range_end, git_commit, generated_at) VALUES (?, ?, ?, ?, ?, ?)",
    );
    const runInfo = runStmt.run(timeframe, candles.length, candles[0].t, candles[candles.length - 1].t, gitCommit, new Date().toISOString());
    const runId = Number(runInfo.lastInsertRowid);

    const zoneStmt = db.prepare(
      `INSERT INTO zones (run_id, timeframe, side, price, created_bar_idx, created_time, confirmed_bar_idx, confirmed_time, expires_bar_idx, expires_time, status)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    const touchStmt = db.prepare(
      `INSERT INTO touches (zone_id, start_bar_idx, start_time, end_bar_idx, end_time, bars_count, max_penetration, outcome, ongoing)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    for (const z of zones) {
      const zoneInfo = zoneStmt.run(
        runId,
        timeframe,
        z.side,
        z.price,
        z.createdBarIdx,
        z.createdTime,
        z.confirmedBarIdx,
        z.confirmedTime,
        z.expiresBarIdx,
        z.expiresTime,
        z.status,
      );
      const zoneId = Number(zoneInfo.lastInsertRowid);
      for (const t of z.touches || []) {
        touchStmt.run(zoneId, t.startBarIdx, t.startTime, t.endBarIdx, t.endTime, t.barsCount, t.maxPenetration, t.outcome, t.ongoing ? 1 : 0);
      }
    }

    const badgeStmt = db.prepare("INSERT INTO badges (run_id, timeframe, bar_idx, time, side, count) VALUES (?, ?, ?, ?, ?, ?)");
    for (const b of badges) {
      badgeStmt.run(runId, timeframe, b.barIdx, b.time, b.side, b.count);
    }

    db.exec("COMMIT");
    return runId;
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
}

// Clears prior runs for a timeframe before a fresh build, so re-running build-historical.js is
// idempotent (no duplicate accumulation across re-runs) rather than append-only. Deliberately NOT
// how the live signal bus will behave later (that one accumulates over time, by design, per the
// original "persistent memory matrix" goal) -- this is the historical/offline rebuild path.
export function clearTimeframe(db, timeframe) {
  db.exec("BEGIN");
  try {
    db.prepare("DELETE FROM touches WHERE zone_id IN (SELECT id FROM zones WHERE timeframe = ?)").run(timeframe);
    db.prepare("DELETE FROM zones WHERE timeframe = ?").run(timeframe);
    db.prepare("DELETE FROM badges WHERE timeframe = ?").run(timeframe);
    db.prepare("DELETE FROM runs WHERE timeframe = ?").run(timeframe);
    db.exec("COMMIT");
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
}
