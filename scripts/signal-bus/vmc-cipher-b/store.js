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
import { migrateInstrument, requireInstrument } from "../lib/instrument.js";

const DB_DIR = new URL("../../../data/signal-bus/", import.meta.url);
// Per-instrument DB files (2026-08-15). BTC deliberately KEEPS its original filename so the ~74
// analysis scripts that open this store keep reading BTC without a single edit -- that is the
// whole reason separate files were chosen over a shared table with an instrument predicate. A
// reader cannot accidentally blend instruments here, because the other instrument's rows are not
// in the file at all.
//
// The `instrument` COLUMN is retained on top of this as defence in depth: it makes a mis-pointed
// build detectable (a BTC-labelled row sitting inside vmc-cipher-b-eth.db is a visible bug) rather than
// silent, and clearAll stays instrument-scoped for the same reason.
const DB_FILES = {
  BTC: "vmc-cipher-b.db",
  ETH: "vmc-cipher-b-eth.db",
  SOL: "vmc-cipher-b-sol.db",
};

function dbPathFor(instrument) {
  const file = DB_FILES[instrument];
  if (!file) throw new Error(`unknown instrument '${instrument}'; known: ${Object.keys(DB_FILES).join(", ")}`);
  return new URL(file, DB_DIR);
}

const INSTRUMENT_TABLES = [
  { name: "runs", hasTimeframe: true },
  { name: "zones", hasTimeframe: true },
  { name: "touches", hasTimeframe: false },
  { name: "zone_confluences", hasTimeframe: false },
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

CREATE TABLE IF NOT EXISTS zones (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  instrument TEXT NOT NULL DEFAULT 'BTC',
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
  instrument TEXT NOT NULL DEFAULT 'BTC',
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

export function openStore(instrument = "BTC") {
  mkdirSync(DB_DIR, { recursive: true });
  const db = new DatabaseSync(dbPathFor(instrument));
  db.exec(SCHEMA);
  migrateInstrument(db, INSTRUMENT_TABLES);
  return db;
}

// Instrument-scoped by design (2026-08-15) -- an unscoped DELETE here would let an ETH rebuild
// destroy the entire BTC corpus. Required argument, never defaulted. This DB is the largest in
// the project (7.9M touches rows), so an accidental wipe is also the most expensive to rebuild.
export function clearAll(db, instrument) {
  requireInstrument(instrument);
  db.exec("BEGIN");
  try {
    for (const t of ["zone_confluences", "touches", "zones", "runs"]) {
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
  const runStmt = db.prepare(
    "INSERT INTO runs (instrument, timeframe, candle_count, range_start, range_end, git_commit, generated_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
  );
  const runInfo = runStmt.run(instrument, timeframe, candles.length, candles[0].t, candles[candles.length - 1].t, gitCommit, new Date().toISOString());
  return Number(runInfo.lastInsertRowid);
}

// Inserts zones + their touches for one timeframe, and sets `.id` on each in-memory zone object
// to the real SQLite-assigned id -- required before computeConfluence() can run across timeframes.
export function insertZonesAndTouches(db, { instrument, runId, timeframe, zones }) {
  requireInstrument(instrument);
  db.exec("BEGIN");
  try {
    const zoneStmt = db.prepare(
      `INSERT INTO zones (run_id, instrument, timeframe, side, kind, price, created_bar_idx, created_time, confirmed_bar_idx, confirmed_time, expires_bar_idx, expires_time, status, atr_at_creation)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    const touchStmt = db.prepare(
      `INSERT INTO touches (zone_id, instrument, start_bar_idx, start_time, end_bar_idx, end_time, bars_count, max_penetration, outcome, ongoing, approach_direction, polarity_flip_retest)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    for (const z of zones) {
      const zoneInfo = zoneStmt.run(
        runId,
        instrument,
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
          instrument,
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
export function updateConfluence(db, allZones, instrument) {
  requireInstrument(instrument);
  db.exec("BEGIN");
  try {
    const updateStmt = db.prepare("UPDATE zones SET confluence_count = ?, same_timeframe_cluster_size = ? WHERE id = ?");
    const linkStmt = db.prepare("INSERT OR IGNORE INTO zone_confluences (zone_id, instrument, confluent_zone_id) VALUES (?, ?, ?)");
    for (const z of allZones) {
      updateStmt.run(z.confluenceCount, z.sameTimeframeClusterSize, z.id);
      for (const otherId of z.confluentZoneIds) linkStmt.run(z.id, instrument, otherId);
    }
    db.exec("COMMIT");
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
}
