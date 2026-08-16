// SQLite storage for the cascade bus (data/signal-bus/cascade.db), following the same
// per-indicator-bus pattern as the rest of scripts/signal-bus/.
//
// A cascade is not a per-timeframe object -- it SPANS rungs by construction -- so unlike every
// other bus here these tables are not keyed on a single timeframe. `runs` records the build
// parameters instead, because a cascade population is meaningless without the window rule that
// produced it: #135 measured directly that scaling the propagation window to the responding rung
// yields 5,174 bottom-up cascades against 927 top-down at mult=8, while scaling to the initiator
// biases the opposite way. The window rule is part of the data's identity, not a footnote.
//
// WHAT IS PERSISTED. Maximal cascades only (see `maximalCascades` in calc.js) -- a cascade starting
// at rung k is a strict sub-sequence of one starting at k-1 when both pass through k at the same
// instant, and keeping both would double-count one propagation. Persisted across the whole
// parameter grid that #135 swept (both event families, both propagation directions, window
// multipliers 1/2/4) so sensitivity analysis is a query rather than a rebuild.

import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "fs";
import { migrateInstrument, requireInstrument } from "../lib/instrument.js";

const DB_DIR = new URL("../../../data/signal-bus/", import.meta.url);
const DB_FILES = { BTC: "cascade.db", ETH: "cascade-eth.db" };

function dbPathFor(instrument) {
  const file = DB_FILES[instrument];
  if (!file) throw new Error(`unknown instrument '${instrument}'; known: ${Object.keys(DB_FILES).join(", ")}`);
  return new URL(file, DB_DIR);
}

// hasTimeframe:false on every table -- cascades span rungs, so there is no single timeframe to
// index on. The instrument index is still wanted for the same defence-in-depth reason as elsewhere.
const INSTRUMENT_TABLES = [
  { name: "runs", hasTimeframe: false },
  { name: "cascades", hasTimeframe: false },
  { name: "cascade_steps", hasTimeframe: false },
];

const SCHEMA = `
CREATE TABLE IF NOT EXISTS runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  instrument TEXT NOT NULL DEFAULT 'BTC',
  event_family TEXT NOT NULL,
  window_scale TEXT NOT NULL,
  window_mults TEXT NOT NULL,
  source_event_count INTEGER NOT NULL,
  git_commit TEXT,
  generated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS cascades (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id INTEGER NOT NULL REFERENCES runs(id),
  instrument TEXT NOT NULL DEFAULT 'BTC',
  event_family TEXT NOT NULL,          -- 'supertrend' | 'smc_structure' | 'smc_choch'
  propagation TEXT NOT NULL CHECK(propagation IN ('top_down','bottom_up')),
  window_mult REAL NOT NULL,
  window_scale TEXT NOT NULL,
  direction TEXT NOT NULL,
  start_rung TEXT NOT NULL,
  start_rung_idx INTEGER NOT NULL,
  end_rung TEXT NOT NULL,
  end_rung_idx INTEGER NOT NULL,
  depth INTEGER NOT NULL,
  reached_end INTEGER NOT NULL,        -- ran out of ladder without stalling; NOT the same as full_ladder
  full_ladder INTEGER NOT NULL,        -- traversed all 8 rungs
  stalled_at TEXT,
  start_time INTEGER NOT NULL,
  -- The instant the last participating rung actually flipped. ANY forward test must key on this,
  -- not on start_time: the completed sequence is not observable until here. Using start_time would
  -- be look-ahead of exactly the kind that produced this project's two shipped bugs.
  known_at_time INTEGER NOT NULL,
  -- A stall is only knowable once its window has fully elapsed, which is strictly later again.
  stall_confirmed_time INTEGER,
  total_span_sec INTEGER NOT NULL,
  mean_latency_bars REAL
);
CREATE INDEX IF NOT EXISTS idx_casc_family ON cascades(event_family, propagation, window_mult);
CREATE INDEX IF NOT EXISTS idx_casc_known ON cascades(known_at_time);
CREATE INDEX IF NOT EXISTS idx_casc_depth ON cascades(depth);

CREATE TABLE IF NOT EXISTS cascade_steps (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  cascade_id INTEGER NOT NULL REFERENCES cascades(id),
  instrument TEXT NOT NULL DEFAULT 'BTC',
  step_idx INTEGER NOT NULL,
  rung TEXT NOT NULL,
  rung_idx INTEGER NOT NULL,
  time INTEGER NOT NULL,
  price REAL,
  -- Latency from the previous step, in the RECEIVING rung's own bars -- scale-free, so a 1w->1d
  -- latency and a 1h->15m latency are directly comparable. NULL on the first step.
  latency_bars REAL
);
CREATE INDEX IF NOT EXISTS idx_step_cascade ON cascade_steps(cascade_id);
`;

export function openStore(instrument = "BTC") {
  mkdirSync(DB_DIR, { recursive: true });
  const db = new DatabaseSync(dbPathFor(instrument));
  db.exec(SCHEMA);
  migrateInstrument(db, INSTRUMENT_TABLES);
  return db;
}

// Instrument-scoped, argument required -- same rule as every other bus.
export function clearAll(db, instrument) {
  requireInstrument(instrument);
  db.exec("BEGIN");
  try {
    for (const t of ["cascade_steps", "cascades", "runs"]) {
      db.prepare(`DELETE FROM ${t} WHERE instrument = ?`).run(instrument);
    }
    db.exec("COMMIT");
  } catch (err) { db.exec("ROLLBACK"); throw err; }
}

export function insertRun(db, { instrument, eventFamily, windowScale, windowMults, sourceEventCount, gitCommit }) {
  requireInstrument(instrument);
  const stmt = db.prepare(
    "INSERT INTO runs (instrument, event_family, window_scale, window_mults, source_event_count, git_commit, generated_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
  );
  const info = stmt.run(instrument, eventFamily, windowScale, windowMults.join(","), sourceEventCount, gitCommit, new Date().toISOString());
  return Number(info.lastInsertRowid);
}

export function insertCascades(db, { instrument, runId, eventFamily, windowScale, windowMult, cascades }) {
  requireInstrument(instrument);
  db.exec("BEGIN");
  try {
    const cStmt = db.prepare(
      `INSERT INTO cascades (run_id, instrument, event_family, propagation, window_mult, window_scale, direction,
        start_rung, start_rung_idx, end_rung, end_rung_idx, depth, reached_end, full_ladder, stalled_at,
        start_time, known_at_time, stall_confirmed_time, total_span_sec, mean_latency_bars)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    const sStmt = db.prepare(
      "INSERT INTO cascade_steps (cascade_id, instrument, step_idx, rung, rung_idx, time, price, latency_bars) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    );
    for (const c of cascades) {
      const info = cStmt.run(runId, instrument, eventFamily, c.propagation, windowMult, windowScale, c.direction,
        c.startRung, c.startRungIdx, c.endRung, c.endRungIdx, c.depth, c.reachedEnd ? 1 : 0, c.fullLadder ? 1 : 0, c.stalledAt,
        c.startTime, c.knownAtTime, c.stallConfirmedTime, c.totalSpanSec, c.meanLatencyBars);
      const cid = Number(info.lastInsertRowid);
      for (let i = 0; i < c.steps.length; i++) {
        const s = c.steps[i];
        sStmt.run(cid, instrument, i, s.rung, s.rungIdx, s.time, s.price ?? null, i === 0 ? null : c.latencies[i - 1]);
      }
    }
    db.exec("COMMIT");
  } catch (err) { db.exec("ROLLBACK"); throw err; }
}
