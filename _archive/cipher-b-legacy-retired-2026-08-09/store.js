// SQLite storage for the Cipher B divergence signal bus. Own DB file (data/signal-bus/cipher-b.db,
// gitignored, regenerable), same per-indicator-bus pattern as smc.db / divergence-for-many.db.
//
// Schema note (2026-08-08): this is meant to run across the full 8-timeframe ladder and accumulate
// a genuinely large event set (smc's structure_events alone hit 15.5k rows on 5m for one source) --
// iapaulo's stated intent is eventually feeding this to a proper learning system once there's enough
// established data, not yet. So every column here is a raw, continuous value (oscillator/price at
// both pivots, bar-space AND real-time-space span) rather than a pre-collapsed boolean or a lossy
// summary -- normalization/feature engineering can be built later without a schema migration, but
// only if the raw ingredients were kept. `bar_span`/`time_span_sec` are stored precomputed (not
// left for a consumer to re-derive) specifically because cross-timeframe comparison needs the
// real-time span, not just the bar-count one -- a "steep" divergence on 5m and on 1W aren't the same
// thing in bar-space.
//
// Deliberately NOT built yet (next steps, own tables when built): forward-projection of the
// divergence line past its second pivot, and the resulting crossing/outcome events against future
// price -- that's the labeling step, and there's nothing to label until this table has real,
// reviewed data in it first.

import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "fs";

const DB_DIR = new URL("../../../data/signal-bus/", import.meta.url);
const DB_PATH = new URL("cipher-b.db", DB_DIR);

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

CREATE TABLE IF NOT EXISTS divergences (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id INTEGER NOT NULL REFERENCES runs(id),
  timeframe TEXT NOT NULL,
  source TEXT NOT NULL CHECK(source IN ('wt','wt2nd','rsi','stoch')),
  side TEXT NOT NULL CHECK(side IN ('bear','bull')),
  hidden INTEGER NOT NULL CHECK(hidden IN (0,1)),
  color TEXT NOT NULL,

  prev_bar_idx INTEGER NOT NULL,
  prev_time INTEGER NOT NULL,
  prev_osc_val REAL NOT NULL,
  prev_price_val REAL NOT NULL,

  bar_idx INTEGER NOT NULL,
  time INTEGER NOT NULL,
  osc_val REAL NOT NULL,
  price_val REAL NOT NULL,

  confirm_bar_idx INTEGER NOT NULL,
  confirm_time INTEGER NOT NULL,

  bar_span INTEGER NOT NULL,     -- bar_idx - prev_bar_idx
  time_span_sec INTEGER NOT NULL, -- time - prev_time
  slope REAL NOT NULL             -- (osc_val - prev_osc_val) / bar_span -- the "angle," bar-space
);
CREATE INDEX IF NOT EXISTS idx_div_tf_time ON divergences(timeframe, confirm_time);
CREATE INDEX IF NOT EXISTS idx_div_tf_source_side ON divergences(timeframe, source, side, hidden);

CREATE TABLE IF NOT EXISTS divergence_crossings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  divergence_id INTEGER NOT NULL REFERENCES divergences(id),
  crossing_num INTEGER NOT NULL,
  bar_idx INTEGER NOT NULL,
  time INTEGER NOT NULL,
  bars_since_confirm INTEGER NOT NULL,
  direction TEXT NOT NULL CHECK(direction IN ('above_to_below','below_to_above')),
  osc_val_at_cross REAL NOT NULL,
  projected_val_at_cross REAL NOT NULL,
  price_at_cross REAL NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_crossing_div ON divergence_crossings(divergence_id);
CREATE INDEX IF NOT EXISTS idx_crossing_time ON divergence_crossings(time);

CREATE TABLE IF NOT EXISTS divergence_smc_matches (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  divergence_id INTEGER NOT NULL REFERENCES divergences(id),
  scope TEXT NOT NULL CHECK(scope IN ('internal','swing')),
  structure_type TEXT NOT NULL CHECK(structure_type IN ('BOS','CHOCH')),
  structure_side TEXT NOT NULL CHECK(structure_side IN ('bullish','bearish')),
  structure_bar_idx INTEGER NOT NULL,
  structure_time INTEGER NOT NULL,
  structure_price REAL NOT NULL,
  price_diff_pct REAL NOT NULL,
  time_diff_bars INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_smcmatch_div ON divergence_smc_matches(divergence_id);
CREATE INDEX IF NOT EXISTS idx_smcmatch_scope ON divergence_smc_matches(scope);
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
    db.exec("DELETE FROM divergence_smc_matches");
    db.exec("DELETE FROM divergence_crossings");
    db.exec("DELETE FROM divergences");
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

// Attaches the real DB id onto each divergence object (mutates in place, same pattern smc/store.js
// uses for order_blocks -> order_block_touches) so a subsequent insertCrossings() call can
// reference the correct parent row -- crossings are computed after this returns, not inline, since
// they need the full forward series rather than anything per-row insertion produces.
export function insertAll(db, { runId, timeframe, divergences }) {
  db.exec("BEGIN");
  try {
    const stmt = db.prepare(
      `INSERT INTO divergences
         (run_id, timeframe, source, side, hidden, color,
          prev_bar_idx, prev_time, prev_osc_val, prev_price_val,
          bar_idx, time, osc_val, price_val,
          confirm_bar_idx, confirm_time, bar_span, time_span_sec, slope)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    for (const d of divergences) {
      const info = stmt.run(
        runId, timeframe, d.source, d.side, d.hidden ? 1 : 0, d.color,
        d.prevBarIdx, d.prevTime, d.prevOscVal, d.prevPriceVal,
        d.barIdx, d.time, d.oscVal, d.priceVal,
        d.confirmBarIdx, d.confirmTime, d.barIdx - d.prevBarIdx, d.time - d.prevTime, d.slope,
      );
      d.id = Number(info.lastInsertRowid);
    }
    db.exec("COMMIT");
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
}

export function insertCrossings(db, crossings) {
  db.exec("BEGIN");
  try {
    const stmt = db.prepare(
      `INSERT INTO divergence_crossings
         (divergence_id, crossing_num, bar_idx, time, bars_since_confirm, direction, osc_val_at_cross, projected_val_at_cross, price_at_cross)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    for (const c of crossings) {
      stmt.run(c.divergence.id, c.crossingNum, c.barIdx, c.time, c.barsSinceConfirm, c.direction, c.oscValAtCross, c.projectedValAtCross, c.priceAtCross);
    }
    db.exec("COMMIT");
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
}

export function insertSMCMatches(db, matches) {
  db.exec("BEGIN");
  try {
    const stmt = db.prepare(
      `INSERT INTO divergence_smc_matches
         (divergence_id, scope, structure_type, structure_side, structure_bar_idx, structure_time, structure_price, price_diff_pct, time_diff_bars)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    for (const m of matches) {
      stmt.run(m.divergence.id, m.scope, m.structureType, m.structureSide, m.structureBarIdx, m.structureTime, m.structurePrice, m.priceDiffPct, m.timeDiffBars);
    }
    db.exec("COMMIT");
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
}
