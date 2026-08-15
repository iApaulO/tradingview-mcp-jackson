// SQLite storage for the SMC signal bus. Own DB file (data/signal-bus/smc.db, gitignored,
// regenerable), per the per-indicator-bus pattern established for Divergence for Many.

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
// build detectable (a BTC-labelled row sitting inside smc-eth.db is a visible bug) rather than
// silent, and clearAll stays instrument-scoped for the same reason.
const DB_FILES = {
  BTC: "smc.db",
  ETH: "smc-eth.db",
};

function dbPathFor(instrument) {
  const file = DB_FILES[instrument];
  if (!file) throw new Error(`unknown instrument '${instrument}'; known: ${Object.keys(DB_FILES).join(", ")}`);
  return new URL(file, DB_DIR);
}

const INSTRUMENT_TABLES = [
  { name: "runs", hasTimeframe: true },
  { name: "structure_events", hasTimeframe: true },
  { name: "eqh_eql_events", hasTimeframe: true },
  { name: "order_blocks", hasTimeframe: true },
  { name: "order_block_touches", hasTimeframe: false },
  { name: "order_block_proximity_events", hasTimeframe: false },
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

CREATE TABLE IF NOT EXISTS structure_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  instrument TEXT NOT NULL DEFAULT 'BTC',
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
  instrument TEXT NOT NULL DEFAULT 'BTC',
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
  instrument TEXT NOT NULL DEFAULT 'BTC',
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
  recurrence_count INTEGER NOT NULL DEFAULT 1,
  boom_long_tier TEXT,
  boom_full_sequence INTEGER NOT NULL DEFAULT 0,
  boom_nested_depth INTEGER NOT NULL DEFAULT 0,
  boom_nested_boost INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_ob_tf ON order_blocks(timeframe);
CREATE INDEX IF NOT EXISTS idx_ob_price ON order_blocks(bar_low, bar_high);

CREATE TABLE IF NOT EXISTS order_block_touches (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  instrument TEXT NOT NULL DEFAULT 'BTC',
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

CREATE TABLE IF NOT EXISTS order_block_proximity_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  instrument TEXT NOT NULL DEFAULT 'BTC',
  order_block_id INTEGER NOT NULL REFERENCES order_blocks(id),
  start_bar_idx INTEGER NOT NULL,
  start_time INTEGER NOT NULL,
  end_bar_idx INTEGER NOT NULL,
  end_time INTEGER NOT NULL,
  bars_count INTEGER NOT NULL,
  closest_approach_pct REAL NOT NULL,
  approach_direction TEXT NOT NULL CHECK(approach_direction IN ('above','below')),
  ongoing INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_obp_ob ON order_block_proximity_events(order_block_id);
`;

// order_blocks predates the boom_* columns (added 2026-08-09) -- CREATE TABLE IF NOT EXISTS is a
// no-op against an existing table, so an already-built smc.db needs these added explicitly. Safe
// to run every openStore() call: SQLite errors on a column that already exists, which is the only
// case this swallows -- any other ALTER failure still throws.
function migrate(db) {
  const boomColumns = [
    "ALTER TABLE order_blocks ADD COLUMN boom_long_tier TEXT",
    "ALTER TABLE order_blocks ADD COLUMN boom_full_sequence INTEGER NOT NULL DEFAULT 0",
    "ALTER TABLE order_blocks ADD COLUMN boom_nested_depth INTEGER NOT NULL DEFAULT 0",
    "ALTER TABLE order_blocks ADD COLUMN boom_nested_boost INTEGER NOT NULL DEFAULT 0",
  ];
  for (const sql of boomColumns) {
    try { db.exec(sql); } catch (err) { if (!/duplicate column name/i.test(err.message)) throw err; }
  }
}

export function openStore(instrument = "BTC") {
  mkdirSync(DB_DIR, { recursive: true });
  const db = new DatabaseSync(dbPathFor(instrument));
  db.exec(SCHEMA);
  migrate(db);
  migrateInstrument(db, INSTRUMENT_TABLES);
  return db;
}

// Instrument-scoped by design (2026-08-15) -- an unscoped DELETE here would let an ETH rebuild
// destroy the entire BTC corpus, including the 83,584 order blocks behind Strategy A2 and every
// order-block finding in the register. Required argument, never defaulted.
export function clearAll(db, instrument) {
  requireInstrument(instrument);
  db.exec("BEGIN");
  try {
    for (const t of [
      "order_block_proximity_events",
      "order_block_touches",
      "order_blocks",
      "eqh_eql_events",
      "structure_events",
      "runs",
    ]) {
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

// Loads every element across all timeframes for ONE instrument, shaped for confluence.js's generic
// pool format. Instrument-scoped 2026-08-15: without the filter this would pool BTC and ETH
// elements into a single cross-instrument confluence calculation, which is meaningless.
export function loadConfluencePool(db, instrument) {
  requireInstrument(instrument);
  const obs = db.prepare("SELECT id, timeframe, side, bar_low, bar_high, created_time, mitigated_time FROM order_blocks WHERE instrument = ?").all(instrument);
  const eqhl = db.prepare("SELECT id, timeframe, side, level, confirm_time FROM eqh_eql_events WHERE instrument = ?").all(instrument);
  const structure = db.prepare("SELECT id, timeframe, side, price, time FROM structure_events WHERE instrument = ?").all(instrument);

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

// Writes back Boom Hunter cross-referencing (build-boom-confluence.js): boomLongTier (which
// validated Long tier, if any, preceded this bullish OB at its price level -- 'lime'|'blue'|
// 'yellow'|'gray'|'enter4'|null), boomFullSequence (that tier AND a Continuation confirmed after,
// the exact condition validated in long-ob-continuation-significance.js / the enter4 test in
// boom-hunter-full-signal-significance.js), boomNestedDepth (sequential slower-TF cascade count,
// nested-cross-timeframe-significance.js), boomNestedBoost (nestedDepth>=1 AND recurrence_count>=2
// -- the ONLY combination nested-recurrence-joint-significance.js found significant; nesting alone
// was null on low-recurrence OBs, p=0.60-0.61, so this flag deliberately does not fire there).
export function updateBoomConfluence(db, orderBlocks) {
  db.exec("BEGIN");
  try {
    const stmt = db.prepare(
      "UPDATE order_blocks SET boom_long_tier = ?, boom_full_sequence = ?, boom_nested_depth = ?, boom_nested_boost = ? WHERE id = ?",
    );
    for (const ob of orderBlocks) {
      stmt.run(ob.boomLongTier ?? null, ob.boomFullSequence ? 1 : 0, ob.boomNestedDepth, ob.boomNestedBoost ? 1 : 0, ob.id);
    }
    db.exec("COMMIT");
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
}

export function insertAll(db, { instrument, runId, timeframe, structureEvents, eqhEqlEvents, orderBlocks }) {
  requireInstrument(instrument);
  db.exec("BEGIN");
  try {
    const structStmt = db.prepare(
      "INSERT INTO structure_events (run_id, instrument, timeframe, scope, type, side, bar_idx, time, price, color) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    );
    for (const e of structureEvents) structStmt.run(runId, instrument, timeframe, e.scope, e.type, e.side, e.barIdx, e.time, e.price, e.color);

    const eqStmt = db.prepare(
      `INSERT INTO eqh_eql_events (run_id, instrument, timeframe, side, level, pivot_bar_idx, pivot_time, confirm_bar_idx, confirm_time, color, sweep_status, sweep_time, bars_to_sweep, reversal_time, bars_to_reversal)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    for (const e of eqhEqlEvents) {
      eqStmt.run(
        runId, instrument, timeframe, e.side, e.level, e.pivotBarIdx, e.pivotTime, e.confirmBarIdx, e.confirmTime, e.color,
        e.sweepStatus ?? null, e.sweepTime ?? null, e.barsToSweep ?? null, e.reversalTime ?? null, e.barsToReversal ?? null,
      );
    }

    const obStmt = db.prepare(
      `INSERT INTO order_blocks (run_id, instrument, timeframe, scope, side, bar_high, bar_low, origin_bar_idx, origin_time, created_bar_idx, created_time, mitigated_bar_idx, mitigated_time, status, color)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    const touchStmt = db.prepare(
      `INSERT INTO order_block_touches (order_block_id, instrument, start_bar_idx, start_time, end_bar_idx, end_time, bars_count, max_penetration_pct, approach_direction, outcome, ongoing)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    const proximityStmt = db.prepare(
      `INSERT INTO order_block_proximity_events (order_block_id, instrument, start_bar_idx, start_time, end_bar_idx, end_time, bars_count, closest_approach_pct, approach_direction, ongoing)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    for (const ob of orderBlocks) {
      const info = obStmt.run(
        runId, instrument, timeframe, ob.scope, ob.side, ob.barHigh, ob.barLow, ob.originBarIdx, ob.originTime,
        ob.createdBarIdx, ob.createdTime, ob.mitigatedBarIdx, ob.mitigatedTime, ob.status, ob.color,
      );
      const obId = Number(info.lastInsertRowid);
      for (const t of ob.touches || []) {
        touchStmt.run(obId, instrument, t.startBarIdx, t.startTime, t.endBarIdx, t.endTime, t.barsCount, t.maxPenetrationPct, t.approachDirection, t.outcome, t.ongoing ? 1 : 0);
      }
      for (const p of ob.proximityEvents || []) {
        proximityStmt.run(obId, instrument, p.startBarIdx, p.startTime, p.endBarIdx, p.endTime, p.barsCount, p.closestApproachPct, p.approachDirection, p.ongoing ? 1 : 0);
      }
    }
    db.exec("COMMIT");
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
}
