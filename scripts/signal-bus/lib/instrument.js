// Shared instrument-scoping helper for every signal-bus store.
//
// WHY THIS EXISTS (2026-08-15): until now every signal-bus table was keyed on `timeframe` alone,
// with the traded instrument implicit and unrecorded -- the whole historical dataset behind
// register rows #1-#126 is BTC, but nothing in the schema says so. The moment a second instrument
// (ETH, per the 2026-08-15 scope change) is built into the same tables, its rows become
// indistinguishable from BTC's: `SELECT ... FROM order_blocks WHERE timeframe = '15m'` would
// silently return a mixed-instrument population and corrupt every existing finding, with no way
// to separate them afterwards. smc.db's order_blocks alone holds 83,584 rows with no instrument
// marker.
//
// The fix is deliberately boring: one `instrument` column on EVERY table (including child tables
// that could technically inherit it through a foreign key), defaulting to 'BTC' so the existing
// corpus is correctly labelled retroactively, plus instrument-leading composite indexes so the
// added WHERE clause doesn't cost a scan.
//
// Child tables (touches, zone_confluences, order_block_touches, order_block_proximity_events)
// carry the column redundantly on purpose. They are reachable by FK, but several analysis scripts
// query them directly, and a redundant column is far cheaper than a corrupted 7.9M-row table --
// vmc-cipher-b.db's touches table is exactly that size.

export const DEFAULT_INSTRUMENT = "BTC";

// Instruments the pipeline is allowed to write. Deliberately a closed set: a typo'd or
// silently-empty instrument is the failure mode this whole migration exists to prevent, so an
// unknown value must fail loudly at the write boundary rather than create a third population.
export const KNOWN_INSTRUMENTS = new Set(["BTC", "ETH"]);

// Call at every store write entry point. Throws rather than defaulting -- defaulting is what
// would let an ETH build land in the BTC population unnoticed, which is the exact bug this
// module prevents.
export function requireInstrument(instrument) {
  if (!instrument) {
    throw new Error(
      "instrument is required (e.g. 'BTC' or 'ETH'). Refusing to write an unlabelled row -- " +
        "see scripts/signal-bus/lib/instrument.js for why defaulting here is unsafe.",
    );
  }
  if (!KNOWN_INSTRUMENTS.has(instrument)) {
    throw new Error(
      `unknown instrument '${instrument}'. Known: ${[...KNOWN_INSTRUMENTS].join(", ")}. ` +
        "Add it to KNOWN_INSTRUMENTS deliberately rather than letting a typo create a new population.",
    );
  }
  return instrument;
}

// Idempotent, safe to run on every openStore() call. SQLite's ALTER TABLE ADD COLUMN with a
// constant non-NULL default is a schema-only operation -- it does not rewrite existing rows, so
// this stays fast even against the 7.9M-row touches table. Existing rows read back as 'BTC',
// which IS the backfill; no UPDATE pass is needed or performed.
//
// tables: [{ name, hasTimeframe }]
export function migrateInstrument(db, tables) {
  for (const { name, hasTimeframe } of tables) {
    try {
      db.exec(`ALTER TABLE ${name} ADD COLUMN instrument TEXT NOT NULL DEFAULT '${DEFAULT_INSTRUMENT}'`);
    } catch (err) {
      // Only an already-applied migration may be swallowed; anything else is a real failure.
      if (!/duplicate column name/i.test(err.message)) throw err;
    }
    // Instrument-leading composite index mirrors the existing timeframe indexes, so the added
    // `WHERE instrument = ?` predicate is served by an index rather than forcing a table scan.
    if (hasTimeframe) {
      db.exec(`CREATE INDEX IF NOT EXISTS idx_${name}_inst_tf ON ${name}(instrument, timeframe)`);
    } else {
      db.exec(`CREATE INDEX IF NOT EXISTS idx_${name}_inst ON ${name}(instrument)`);
    }
  }
}
