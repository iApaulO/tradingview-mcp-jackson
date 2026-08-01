// SQLite storage for the VMC Cipher B signal bus. Own DB file (data/signal-bus/vmc-cipher-b.db),
// per the per-indicator-bus decision (2026-07-25) carried forward from SMC/Divergence-for-Many.
//
// Schema mirrors divergence-for-many's zones/touches/zone_confluences tables exactly (same shape,
// same reuse of touches.js/confluence.js) plus one extra column on zones: `kind` ('regular' |
// 'regular_add' | 'hidden') -- distinguishes the WT divergence variants calc.js produces. The live
// chart has hidden divergence enabled (a real deviation from the Pine author's documented default,
// confirmed 2026-07-31) AND a second, independently-gated "2nd WT Regular Divergence" detector
// live-active with Pine's own defaults (found 2026-08-01, see calc.js's header note -- iapaulo
// caught a real undercount vs. a live chart) -- all three kinds need to be testable independently
// before any decision to pool them; `regular` alone was confirmed the deliberately-correct filter
// for cost-sensitive work (ARCHITECTURE.md §33), `regular_add` is a real-but-weaker signal kept
// for completeness/inventory purposes. No `badges` table here -- Cipher B has no separate
// "detected but not yet a zone" concept the way Divergence-for-Many's badge/promotion gate does;
// every qualifying divergence directly becomes a zone.

import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "fs";

const DB_DIR = new URL("../../../data/signal-bus/", import.meta.url);
const DB_PATH = new URL("vmc-cipher-b.db", DB_DIR);

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
  kind TEXT NOT NULL CHECK(kind IN ('regular','regular_add','hidden')),
  price REAL NOT NULL,
  created_bar_idx INTEGER NOT NULL,
  created_time INTEGER NOT NULL,
  confirmed_bar_idx INTEGER NOT NULL,
  confirmed_time INTEGER NOT NULL,
  expires_bar_idx INTEGER,
  expires_time INTEGER,
  status TEXT NOT NULL,
  atr_at_creation REAL,
  confluence_count INTEGER NOT NULL DEFAULT 1,
  same_timeframe_cluster_size INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_zones_tf_price ON zones(timeframe, price);
CREATE INDEX IF NOT EXISTS idx_zones_run ON zones(run_id);
CREATE INDEX IF NOT EXISTS idx_zones_kind ON zones(kind);

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
  ongoing INTEGER NOT NULL DEFAULT 0,
  approach_direction TEXT NOT NULL CHECK(approach_direction IN ('above','below','at')),
  polarity_flip_retest INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_touches_zone ON touches(zone_id);

CREATE TABLE IF NOT EXISTS zone_confluences (
  zone_id INTEGER NOT NULL REFERENCES zones(id),
  confluent_zone_id INTEGER NOT NULL REFERENCES zones(id),
  PRIMARY KEY (zone_id, confluent_zone_id)
);
CREATE INDEX IF NOT EXISTS idx_confluences_zone ON zone_confluences(zone_id);
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
    db.exec("DELETE FROM zone_confluences");
    db.exec("DELETE FROM touches");
    db.exec("DELETE FROM zones");
    db.exec("DELETE FROM runs");
    db.exec("COMMIT");
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
}

export function insertRun(db, { timeframe, candles, gitCommit }) {
  const runStmt = db.prepare(
    "INSERT INTO runs (timeframe, candle_count, range_start, range_end, git_commit, generated_at) VALUES (?, ?, ?, ?, ?, ?)",
  );
  const runInfo = runStmt.run(timeframe, candles.length, candles[0].t, candles[candles.length - 1].t, gitCommit, new Date().toISOString());
  return Number(runInfo.lastInsertRowid);
}

// Inserts zones + their touches for one timeframe, and sets `.id` on each in-memory zone object
// to the real SQLite-assigned id -- required before computeConfluence() can run across timeframes.
export function insertZonesAndTouches(db, { runId, timeframe, zones }) {
  db.exec("BEGIN");
  try {
    const zoneStmt = db.prepare(
      `INSERT INTO zones (run_id, timeframe, side, kind, price, created_bar_idx, created_time, confirmed_bar_idx, confirmed_time, expires_bar_idx, expires_time, status, atr_at_creation)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    const touchStmt = db.prepare(
      `INSERT INTO touches (zone_id, start_bar_idx, start_time, end_bar_idx, end_time, bars_count, max_penetration, outcome, ongoing, approach_direction, polarity_flip_retest)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    for (const z of zones) {
      const zoneInfo = zoneStmt.run(
        runId,
        timeframe,
        z.side,
        z.kind,
        z.price,
        z.createdBarIdx,
        z.createdTime,
        z.confirmedBarIdx,
        z.confirmedTime,
        z.expiresBarIdx,
        z.expiresTime,
        z.status,
        z.atrAtCreation ?? null,
      );
      z.id = Number(zoneInfo.lastInsertRowid); // fed into confluence.js later
      for (const t of z.touches || []) {
        touchStmt.run(
          z.id,
          t.startBarIdx,
          t.startTime,
          t.endBarIdx,
          t.endTime,
          t.barsCount,
          t.maxPenetration,
          t.outcome,
          t.ongoing ? 1 : 0,
          t.approachDirection,
          t.polarityFlipRetest ? 1 : 0,
        );
      }
    }
    db.exec("COMMIT");
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
}

// Writes confluence.js's output (allZones already annotated with real .id, confluenceCount,
// sameTimeframeClusterSize, confluentZoneIds) back to the zones table + zone_confluences junction.
export function updateConfluence(db, allZones) {
  db.exec("BEGIN");
  try {
    const updateStmt = db.prepare("UPDATE zones SET confluence_count = ?, same_timeframe_cluster_size = ? WHERE id = ?");
    const linkStmt = db.prepare("INSERT OR IGNORE INTO zone_confluences (zone_id, confluent_zone_id) VALUES (?, ?)");
    for (const z of allZones) {
      updateStmt.run(z.confluenceCount, z.sameTimeframeClusterSize, z.id);
      for (const otherId of z.confluentZoneIds) linkStmt.run(z.id, otherId);
    }
    db.exec("COMMIT");
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
}
