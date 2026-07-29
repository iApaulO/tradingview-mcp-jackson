// SQLite storage for the SMC signal bus. Own DB file (data/signal-bus/smc.db, gitignored,
// regenerable), per the per-indicator-bus pattern established for Divergence for Many.

import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "fs";

const DB_DIR = new URL("../../../data/signal-bus/", import.meta.url);
const DB_PATH = new URL("smc.db", DB_DIR);

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

CREATE TABLE IF NOT EXISTS structure_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id INTEGER NOT NULL REFERENCES runs(id),
  timeframe TEXT NOT NULL,
  scope TEXT NOT NULL CHECK(scope IN ('internal','swing')),
  type TEXT NOT NULL CHECK(type IN ('BOS','CHOCH')),
  side TEXT NOT NULL CHECK(side IN ('bullish','bearish')),
  bar_idx INTEGER NOT NULL,
  time INTEGER NOT NULL,
  price REAL NOT NULL,
  color TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_structure_tf_time ON structure_events(timeframe, time);

CREATE TABLE IF NOT EXISTS eqh_eql_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id INTEGER NOT NULL REFERENCES runs(id),
  timeframe TEXT NOT NULL,
  side TEXT NOT NULL CHECK(side IN ('EQH','EQL')),
  level REAL NOT NULL,
  pivot_bar_idx INTEGER NOT NULL,
  pivot_time INTEGER NOT NULL,
  confirm_bar_idx INTEGER NOT NULL,
  confirm_time INTEGER NOT NULL,
  color TEXT NOT NULL,
  sweep_status TEXT CHECK(sweep_status IN ('unswept','swept_reversed','swept_continued')),
  sweep_time INTEGER,
  bars_to_sweep INTEGER,
  reversal_time INTEGER,
  bars_to_reversal INTEGER
);
CREATE INDEX IF NOT EXISTS idx_eqhl_tf_time ON eqh_eql_events(timeframe, confirm_time);

CREATE TABLE IF NOT EXISTS order_blocks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id INTEGER NOT NULL REFERENCES runs(id),
  timeframe TEXT NOT NULL,
  scope TEXT NOT NULL CHECK(scope IN ('internal','swing')),
  side TEXT NOT NULL CHECK(side IN ('bullish','bearish')),
  bar_high REAL NOT NULL,
  bar_low REAL NOT NULL,
  origin_bar_idx INTEGER NOT NULL,
  origin_time INTEGER NOT NULL,
  created_bar_idx INTEGER NOT NULL,
  created_time INTEGER NOT NULL,
  mitigated_bar_idx INTEGER,
  mitigated_time INTEGER,
  status TEXT NOT NULL,
  color TEXT NOT NULL,
  confluence_count INTEGER NOT NULL DEFAULT 1,
  recurrence_count INTEGER NOT NULL DEFAULT 1
);
CREATE INDEX IF NOT EXISTS idx_ob_tf ON order_blocks(timeframe);
CREATE INDEX IF NOT EXISTS idx_ob_price ON order_blocks(bar_low, bar_high);

CREATE TABLE IF NOT EXISTS order_block_touches (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  order_block_id INTEGER NOT NULL REFERENCES order_blocks(id),
  start_bar_idx INTEGER NOT NULL,
  start_time INTEGER NOT NULL,
  end_bar_idx INTEGER NOT NULL,
  end_time INTEGER NOT NULL,
  bars_count INTEGER NOT NULL,
  max_penetration_pct REAL NOT NULL,
  approach_direction TEXT NOT NULL,
  outcome TEXT NOT NULL CHECK(outcome IN ('held','broken')),
  ongoing INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_obt_ob ON order_block_touches(order_block_id);
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
    db.exec("DELETE FROM order_block_touches");
    db.exec("DELETE FROM order_blocks");
    db.exec("DELETE FROM eqh_eql_events");
    db.exec("DELETE FROM structure_events");
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

// Loads every element across all timeframes, shaped for confluence.js's generic pool format.
export function loadConfluencePool(db) {
  const obs = db.prepare("SELECT id, timeframe, side, bar_low, bar_high, created_time, mitigated_time FROM order_blocks").all();
  const eqhl = db.prepare("SELECT id, timeframe, side, level, confirm_time FROM eqh_eql_events").all();
  const structure = db.prepare("SELECT id, timeframe, side, price, time FROM structure_events").all();

  const pool = [
    ...obs.map((o) => ({
      type: "orderblock",
      id: o.id,
      timeframe: o.timeframe,
      side: o.side,
      priceLow: o.bar_low,
      priceHigh: o.bar_high,
      activeStart: o.created_time,
      activeEnd: o.mitigated_time,
    })),
    ...eqhl.map((e) => ({
      type: "eqhl",
      id: e.id,
      timeframe: e.timeframe,
      side: e.side === "EQH" ? "bearish" : "bullish", // EQH is red/bearish-context, EQL green/bullish-context
      price: e.level,
      activeStart: e.confirm_time,
    })),
    ...structure.map((s) => ({
      type: "structure",
      id: s.id,
      timeframe: s.timeframe,
      side: s.side,
      price: s.price,
      activeStart: s.time,
    })),
  ];

  // Order blocks reshaped for the "target" list confluence.js writes results onto (same rows as
  // above, just without the type discriminant, since these are the ones being scored).
  const targets = obs.map((o) => ({
    id: o.id,
    timeframe: o.timeframe,
    side: o.side,
    priceLow: o.bar_low,
    priceHigh: o.bar_high,
    activeStart: o.created_time,
    activeEnd: o.mitigated_time,
  }));

  return { pool, targets };
}

export function updateConfluence(db, orderBlocks) {
  db.exec("BEGIN");
  try {
    const stmt = db.prepare("UPDATE order_blocks SET confluence_count = ?, recurrence_count = ? WHERE id = ?");
    for (const ob of orderBlocks) stmt.run(ob.confluenceCount, ob.recurrenceCount, ob.id);
    db.exec("COMMIT");
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
}

export function insertAll(db, { runId, timeframe, structureEvents, eqhEqlEvents, orderBlocks }) {
  db.exec("BEGIN");
  try {
    const structStmt = db.prepare(
      "INSERT INTO structure_events (run_id, timeframe, scope, type, side, bar_idx, time, price, color) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
    );
    for (const e of structureEvents) structStmt.run(runId, timeframe, e.scope, e.type, e.side, e.barIdx, e.time, e.price, e.color);

    const eqStmt = db.prepare(
      `INSERT INTO eqh_eql_events (run_id, timeframe, side, level, pivot_bar_idx, pivot_time, confirm_bar_idx, confirm_time, color, sweep_status, sweep_time, bars_to_sweep, reversal_time, bars_to_reversal)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    for (const e of eqhEqlEvents) {
      eqStmt.run(
        runId, timeframe, e.side, e.level, e.pivotBarIdx, e.pivotTime, e.confirmBarIdx, e.confirmTime, e.color,
        e.sweepStatus ?? null, e.sweepTime ?? null, e.barsToSweep ?? null, e.reversalTime ?? null, e.barsToReversal ?? null,
      );
    }

    const obStmt = db.prepare(
      `INSERT INTO order_blocks (run_id, timeframe, scope, side, bar_high, bar_low, origin_bar_idx, origin_time, created_bar_idx, created_time, mitigated_bar_idx, mitigated_time, status, color)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    const touchStmt = db.prepare(
      `INSERT INTO order_block_touches (order_block_id, start_bar_idx, start_time, end_bar_idx, end_time, bars_count, max_penetration_pct, approach_direction, outcome, ongoing)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    for (const ob of orderBlocks) {
      const info = obStmt.run(
        runId, timeframe, ob.scope, ob.side, ob.barHigh, ob.barLow, ob.originBarIdx, ob.originTime,
        ob.createdBarIdx, ob.createdTime, ob.mitigatedBarIdx, ob.mitigatedTime, ob.status, ob.color,
      );
      const obId = Number(info.lastInsertRowid);
      for (const t of ob.touches || []) {
        touchStmt.run(obId, t.startBarIdx, t.startTime, t.endBarIdx, t.endTime, t.barsCount, t.maxPenetrationPct, t.approachDirection, t.outcome, t.ongoing ? 1 : 0);
      }
    }
    db.exec("COMMIT");
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
}
