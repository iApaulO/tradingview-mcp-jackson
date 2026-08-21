#!/usr/bin/env node
// MSS R4 PAPER LEDGER. **NO ORDERS ARE PLACED.** No broker client, no credentials, no order path.
//
// Wires #206's trim-robust construction -- MSS (bullish 4h SWING CHoCH) entry, 2.0x ATR stop, 4R
// target, maker costing -- into the shared paper ledger, authorized by iapaulo 2026-08-20.
//
// WHY A SEPARATE SCRIPT RATHER THAN A ROW IN paper-trade-all.js: that ledger is BTC-only by
// construction (its builders read the BTC portfolio databases). MSS fires ~4x/yr on BTC 4h alone --
// a BTC-only forward track would take years to say anything. #206 validated the construction POOLED
// across BTC/ETH/SOL/XRP, so the paper track runs all four, ~15 signals/yr, same ledger db, same
// UNIQUE(strategy, instrument, entry_time, side) key, same immutable PAPER_START.
//
// EVIDENCE TIER: "in-sample". NOT pre-registered, NOT out-of-sample -- weaker than every other
// strategy in the ledger (H/A/A2 pre-registered, G oos-validated) and recorded as such per row.
// This forward track IS the confirmation route (#204/#206): XRP was spent in #195, so forward time
// is one of only two honest tests left for this construction.
//
// The population comes from mss-r4-builder.js and ONLY from there -- one definition, one place. The
// builder returns `open` for any trade whose 200-bar window runs off the data edge, so the
// truncation trap (#paper-trade-all) cannot occur here by construction; a LIVE_CUTOFF guard is
// still applied to stop a just-closed bar's stop/target from being trusted before the bar is
// safely behind the edge.
//
// Usage:
//   node scripts/signal-bus/cross-confluence/paper-trade-mss.js
//   node scripts/signal-bus/cross-confluence/paper-trade-mss.js --report

import { DatabaseSync } from "node:sqlite";
import { loadCandles } from "../../backtest/lib/load-candles.js";
import { buildMssR4, MSS_R4_REF } from "../smc/mss-r4-builder.js";

const REPORT_ONLY = process.argv.includes("--report");
const DB_URL = new URL("../../../data/signal-bus/paper-trades.db", import.meta.url);
const STRATEGY = "MSS_R4_4h";
const INSTRUMENTS = ["BTC", "ETH", "SOL", "XRP"];
const LIVE_CUTOFF_BARS = 2;
const BAR_SEC = 14400;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS strategy_positions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  strategy TEXT NOT NULL,
  tier TEXT NOT NULL,
  instrument TEXT NOT NULL,
  timeframe TEXT NOT NULL,
  side TEXT NOT NULL,
  entry_time INTEGER NOT NULL,
  entry_price REAL NOT NULL,
  risk_pct REAL NOT NULL,
  status TEXT NOT NULL,
  exit_time INTEGER,
  exit_price REAL,
  gross_pct REAL,
  net_pct REAL,
  opened_at TEXT NOT NULL,
  closed_at TEXT,
  UNIQUE(strategy, instrument, entry_time, side)
);
CREATE INDEX IF NOT EXISTS idx_sp_status ON strategy_positions(strategy, status);
`;

const iso = (t) => new Date(t * 1000).toISOString().slice(0, 16).replace("T", " ");
const mean = (xs) => (xs.length ? xs.reduce((s, x) => s + x, 0) / xs.length : NaN);

async function main() {
  console.log("=".repeat(80));
  console.log("  MSS R4 PAPER LEDGER.  NO ORDERS ARE PLACED. SIMULATED FILLS ONLY.");
  console.log("=".repeat(80));

  const db = new DatabaseSync(DB_URL);
  db.exec("PRAGMA journal_mode=WAL");
  db.exec(SCHEMA);
  const startRow = db.prepare("SELECT value FROM meta WHERE key='paper_start'").get();
  if (!startRow) { console.log("  PAPER_START not set -- run paper-trade-k3.js once first.\n"); db.close(); return; }
  const PAPER_START = Number(startRow.value);
  console.log(`  PAPER_START ${iso(PAPER_START)} UTC (shared, immutable)${REPORT_ONLY ? "   [REPORT ONLY]" : ""}`);
  console.log(`  construction #206 R4: MSS entry, 2.0x ATR stop, 4R target, maker. tier=${MSS_R4_REF.tier} (${MSS_R4_REF.rows})\n`);

  let inserted = 0, resolved = 0;
  for (const inst of INSTRUMENTS) {
    const candles = await loadCandles("4h", inst);
    if (candles.length < 1000) { console.log(`  ${inst}: insufficient candles, skipped`); continue; }
    const edge = candles[candles.length - 1].t;
    const { trades } = buildMssR4(inst, candles);
    const live = trades.filter((t) => t.entryTime >= PAPER_START);

    for (const t of live) {
      const isFinal = t.status === "resolved" && t.exitTime <= edge - LIVE_CUTOFF_BARS * BAR_SEC;
      const exists = db.prepare("SELECT id, status FROM strategy_positions WHERE strategy=? AND instrument=? AND entry_time=? AND side=?")
        .get(STRATEGY, inst, t.entryTime, t.side);
      if (!exists) {
        if (REPORT_ONLY) continue;
        db.prepare(`INSERT INTO strategy_positions (strategy,tier,instrument,timeframe,side,entry_time,entry_price,risk_pct,status,exit_time,exit_price,gross_pct,net_pct,opened_at,closed_at)
                    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
          .run(STRATEGY, MSS_R4_REF.tier, inst, "4h", t.side, t.entryTime, t.entryPrice, t.riskPct,
               isFinal ? "resolved" : "open",
               isFinal ? t.exitTime : null, isFinal ? t.exitPrice : null,
               isFinal ? t.grossPct : null, isFinal ? t.netPct : null,
               new Date().toISOString(), isFinal ? new Date().toISOString() : null);
        inserted++; if (isFinal) resolved++;
        console.log(`  + ${inst} entry ${iso(t.entryTime)} @ ${t.entryPrice}  stop ${t.stopPrice.toFixed(2)}  target ${t.targetPrice.toFixed(2)}  ${isFinal ? `RESOLVED ${t.outcome} net ${(t.netPct * 100).toFixed(2)}%` : "OPEN"}`);
      } else if (exists.status === "open" && isFinal && !REPORT_ONLY) {
        db.prepare("UPDATE strategy_positions SET status='resolved', exit_time=?, exit_price=?, gross_pct=?, net_pct=?, closed_at=? WHERE id=?")
          .run(t.exitTime, t.exitPrice, t.grossPct, t.netPct, new Date().toISOString(), exists.id);
        resolved++;
        console.log(`  = ${inst} entry ${iso(t.entryTime)} RESOLVED ${t.outcome}  net ${(t.netPct * 100).toFixed(2)}%`);
      }
    }
  }

  const openN = db.prepare("SELECT COUNT(*) c FROM strategy_positions WHERE strategy=? AND status='open'").get(STRATEGY).c;
  const done = db.prepare("SELECT net_pct FROM strategy_positions WHERE strategy=? AND status='resolved'").all(STRATEGY);
  console.log(`\n  this tick: inserted ${inserted}, resolved ${resolved}.  ledger: open ${openN}, resolved ${done.length}`);
  if (done.length) {
    const w = done.filter((r) => r.net_pct > 0).length / done.length;
    console.log(`  forward so far: win ${(w * 100).toFixed(1)}% (ref ${(MSS_R4_REF.win * 100).toFixed(1)}%)  net ${(mean(done.map((r) => r.net_pct)) * 100).toFixed(4)}% (ref ${(MSS_R4_REF.net * 100).toFixed(4)}%)`);
  }
  console.log("  Expect ~15 signals/yr across four instruments and a 34% reference win rate -- long");
  console.log("  losing streaks are the EXPECTED behaviour of this construction, not a failure signal.");
  console.log("\n  PAPER ONLY. No broker client, no credentials, no order path in this file.");
  db.close();
}

main().catch((e) => { console.error("Fatal:", e); process.exit(1); });
