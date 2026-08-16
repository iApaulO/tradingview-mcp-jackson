// SQLite storage for the ICT Concepts signal bus (data/signal-bus/ict.db), same per-indicator-bus
// pattern as smc.db / vmc-cipher-b.db / boom-hunter.db. Covers the LOW-TIMEFRAME primitives ported
// in calc.js -- Displacement, FVG/IFVG, Volume Imbalance -- per the #128/#129 evidence that the
// exploitable information sits at the fine end of the ladder.
//
// FVG zones carry a full lifecycle (active -> touched -> broken) rather than being deleted on
// break, matching smc/store.js's status/mitigated_* precedent. The Pine indicator deletes broken
// boxes because it is a display tool; a research store that did the same would make it impossible
// to ask what happens AFTER a gap fills, which is most of the interesting question.

import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "fs";
import { migrateInstrument, requireInstrument } from "../lib/instrument.js";

const DB_DIR = new URL("../../../data/signal-bus/", import.meta.url);
// Per-instrument DB files (2026-08-15) -- BTC keeps the bare name so readers default to it.
const DB_FILES = {
  BTC: "ict.db",
  ETH: "ict-eth.db",
  SOL: "ict-sol.db",
};

function dbPathFor(instrument) {
  const file = DB_FILES[instrument];
  if (!file) throw new Error(`unknown instrument '${instrument}'; known: ${Object.keys(DB_FILES).join(", ")}`);
  return new URL(file, DB_DIR);
}

const INSTRUMENT_TABLES = [
  { name: "runs", hasTimeframe: true },
  { name: "displacement_events", hasTimeframe: true },
  { name: "fvg_zones", hasTimeframe: true },
  { name: "volume_imbalance_events", hasTimeframe: true },
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

CREATE TABLE IF NOT EXISTS displacement_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id INTEGER NOT NULL REFERENCES runs(id),
  instrument TEXT NOT NULL DEFAULT 'BTC',
  timeframe TEXT NOT NULL,
  side TEXT NOT NULL CHECK(side IN ('bullish','bearish')),
  bar_idx INTEGER NOT NULL,
  time INTEGER NOT NULL,
  price REAL NOT NULL,
  body REAL NOT NULL,
  mean_body REAL NOT NULL,
  body_ratio REAL NOT NULL,
  body_atr REAL
);
CREATE INDEX IF NOT EXISTS idx_disp_tf_time ON displacement_events(timeframe, time);

-- kind: 'fvg' | 'ifvg'. Both variants are stored; they are mutually exclusive in the Pine source
-- (one input toggle) but a database has no reason to choose between them.
CREATE TABLE IF NOT EXISTS fvg_zones (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id INTEGER NOT NULL REFERENCES runs(id),
  instrument TEXT NOT NULL DEFAULT 'BTC',
  timeframe TEXT NOT NULL,
  side TEXT NOT NULL CHECK(side IN ('bullish','bearish')),
  kind TEXT NOT NULL CHECK(kind IN ('fvg','ifvg')),
  top REAL NOT NULL,
  bottom REAL NOT NULL,
  -- created_* is the DETECTION bar (what is knowable at its close); origin_* is where the zone's
  -- geometry starts, two bars earlier. Keeping both explicit is what prevents the look-ahead
  -- confusion that produced 1e64de8 and the #124 touch-refresh bug.
  created_bar_idx INTEGER NOT NULL,
  created_time INTEGER NOT NULL,
  origin_bar_idx INTEGER NOT NULL,
  origin_time INTEGER NOT NULL,
  size REAL NOT NULL,
  size_atr REAL,
  displacement_ratio REAL,
  merged_bars INTEGER NOT NULL DEFAULT 1,
  status TEXT NOT NULL CHECK(status IN ('active','touched','broken')),
  first_touch_bar_idx INTEGER,
  first_touch_time INTEGER,
  broken_bar_idx INTEGER,
  broken_time INTEGER,
  max_fill_pct REAL NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_fvg_tf_kind ON fvg_zones(timeframe, kind);
CREATE INDEX IF NOT EXISTS idx_fvg_price ON fvg_zones(bottom, top);
CREATE INDEX IF NOT EXISTS idx_fvg_created ON fvg_zones(created_time);

CREATE TABLE IF NOT EXISTS volume_imbalance_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id INTEGER NOT NULL REFERENCES runs(id),
  instrument TEXT NOT NULL DEFAULT 'BTC',
  timeframe TEXT NOT NULL,
  side TEXT NOT NULL CHECK(side IN ('bullish','bearish')),
  bar_idx INTEGER NOT NULL,
  time INTEGER NOT NULL,
  top REAL NOT NULL,
  bottom REAL NOT NULL,
  size REAL NOT NULL,
  size_atr REAL
);
CREATE INDEX IF NOT EXISTS idx_vi_tf_time ON volume_imbalance_events(timeframe, time);
`;

export function openStore(instrument = "BTC") {
  mkdirSync(DB_DIR, { recursive: true });
  const db = new DatabaseSync(dbPathFor(instrument));
  db.exec(SCHEMA);
  migrateInstrument(db, INSTRUMENT_TABLES);
  return db;
}

// Instrument-scoped, argument required -- an unscoped DELETE here would let an ETH rebuild destroy
// the BTC corpus. Same rule as every other bus in this project.
export function clearAll(db, instrument) {
  requireInstrument(instrument);
  db.exec("BEGIN");
  try {
    for (const t of ["displacement_events", "fvg_zones", "volume_imbalance_events", "runs"]) {
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

export function insertDisplacement(db, { instrument, runId, timeframe, events }) {
  requireInstrument(instrument);
  db.exec("BEGIN");
  try {
    const stmt = db.prepare(
      "INSERT INTO displacement_events (run_id, instrument, timeframe, side, bar_idx, time, price, body, mean_body, body_ratio, body_atr) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    );
    for (const e of events) stmt.run(runId, instrument, timeframe, e.side, e.barIdx, e.time, e.price, e.body, e.meanBody, e.bodyRatio, e.bodyAtr);
    db.exec("COMMIT");
  } catch (err) { db.exec("ROLLBACK"); throw err; }
}

export function insertFvgZones(db, { instrument, runId, timeframe, zones }) {
  requireInstrument(instrument);
  db.exec("BEGIN");
  try {
    const stmt = db.prepare(
      `INSERT INTO fvg_zones (run_id, instrument, timeframe, side, kind, top, bottom, created_bar_idx, created_time, origin_bar_idx, origin_time, size, size_atr, displacement_ratio, merged_bars, status, first_touch_bar_idx, first_touch_time, broken_bar_idx, broken_time, max_fill_pct)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    for (const z of zones) {
      stmt.run(runId, instrument, timeframe, z.side, z.kind, z.top, z.bottom, z.createdBarIdx, z.createdTime, z.originBarIdx, z.originTime,
        z.size, z.sizeAtr, z.displacementRatio, z.mergedBars, z.status, z.firstTouchBarIdx, z.firstTouchTime, z.brokenBarIdx, z.brokenTime, z.maxFillPct);
    }
    db.exec("COMMIT");
  } catch (err) { db.exec("ROLLBACK"); throw err; }
}

export function insertVolumeImbalance(db, { instrument, runId, timeframe, events }) {
  requireInstrument(instrument);
  db.exec("BEGIN");
  try {
    const stmt = db.prepare(
      "INSERT INTO volume_imbalance_events (run_id, instrument, timeframe, side, bar_idx, time, top, bottom, size, size_atr) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    );
    for (const e of events) stmt.run(runId, instrument, timeframe, e.side, e.barIdx, e.time, e.top, e.bottom, e.size, e.sizeAtr);
    db.exec("COMMIT");
  } catch (err) { db.exec("ROLLBACK"); throw err; }
}
