#!/usr/bin/env node
// 4h STRUCTURE PAPER LEDGERS. **NO ORDERS ARE PLACED.** No broker client, no credentials, no order path.
//
// Two constructions, each with its own strategy key in the shared paper-trades.db, each carrying its
// own evidence tier. They are run by one file because the mechanics are identical; they are kept as
// SEPARATE strategy keys because their evidence is not, and flattening them would lose that.
//
//   MSS_R4_4h   tier `failed-preregistration`. #206 built it, #207 wired it, #208A FAILED it on four
//               fresh instruments one day later (-0.1436%, n=137, win 23.4% vs a 34.4% reference).
//               CLOSED for promotion. Its rows are NOT deleted -- forward data on a failed
//               construction is still informative, and deleting them would erase the fact that it
//               failed. Do not read its forward record as evidence for anything.
//
//   OB_SL_4h    tier `pre-registered-forward`. THE LIVE TEST. Bullish OB created on 4h while
//               swingBias == BULLISH (Strong Low), per
//               skills/ict-smc-trader/PREREGISTRATION-ob-strong-low-forward.md, committed
//               2026-08-21 BEFORE any qualifying trade existed. Every instrument in the corpus is
//               spent (XRP #195, BNB/ADA/LTC/LINK #208) and no more will be fetched, so FORWARD TIME
//               IS THE ONLY CLEAN GATE LEFT for this construction.
//
// Reference for OB_SL_4h is the PHASE-AVERAGED +0.3899% (#212), not the single-grid +0.6282% --
// that was the luckiest of four grid alignments and benchmarking against it would inflate the bar.
//
// **NO VERDICT MAY BE DECLARED BEFORE 60 RESOLVED TRADES** (spec F-3). Interim numbers print so the
// track is visible; stopping early on a good run is the commonest way a forward test is corrupted.
//
// Usage:
//   node scripts/signal-bus/cross-confluence/paper-trade-mss.js
//   node scripts/signal-bus/cross-confluence/paper-trade-mss.js --report

import { DatabaseSync } from "node:sqlite";
import { loadCandles } from "../../backtest/lib/load-candles.js";
import { buildMssR4, MSS_R4_REF } from "../smc/mss-r4-builder.js";
import { buildObStrongLow, OB_SL_REF, OB_SL_INSTRUMENTS } from "../smc/ob-strong-low-builder.js";

const REPORT_ONLY = process.argv.includes("--report");
const DB_URL = new URL("../../../data/signal-bus/paper-trades.db", import.meta.url);
const LIVE_CUTOFF_BARS = 2;
const BAR_SEC = 14400;
const VERDICT_FLOOR = 60;

const LEDGERS = [
  {
    key: "MSS_R4_4h", ref: MSS_R4_REF, insts: ["BTC", "ETH", "SOL", "XRP"],
    note: "CLOSED -- failed #208A. Forward record kept for the record only.",
    build: async (inst) => { const c = await loadCandles("4h", inst); return c && c.length >= 1000 ? buildMssR4(inst, c) : { trades: [] }; },
  },
  {
    key: "OB_SL_4h", ref: OB_SL_REF, insts: OB_SL_INSTRUMENTS,
    note: "LIVE pre-registered forward test. No verdict before 60 resolved.",
    build: async (inst) => buildObStrongLow(inst),
  },
];

const SCHEMA = `
CREATE TABLE IF NOT EXISTS strategy_positions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  strategy TEXT NOT NULL, tier TEXT NOT NULL, instrument TEXT NOT NULL, timeframe TEXT NOT NULL,
  side TEXT NOT NULL, entry_time INTEGER NOT NULL, entry_price REAL NOT NULL, risk_pct REAL NOT NULL,
  status TEXT NOT NULL, exit_time INTEGER, exit_price REAL, gross_pct REAL, net_pct REAL,
  opened_at TEXT NOT NULL, closed_at TEXT,
  UNIQUE(strategy, instrument, entry_time, side)
);
CREATE INDEX IF NOT EXISTS idx_sp_status ON strategy_positions(strategy, status);
`;

const iso = (t) => new Date(t * 1000).toISOString().slice(0, 16).replace("T", " ");
const mean = (xs) => (xs.length ? xs.reduce((s, x) => s + x, 0) / xs.length : NaN);

async function main() {
  console.log("=".repeat(84));
  console.log("  4h STRUCTURE PAPER LEDGERS.  NO ORDERS ARE PLACED. SIMULATED FILLS ONLY.");
  console.log("=".repeat(84));

  const db = new DatabaseSync(DB_URL);
  db.exec("PRAGMA journal_mode=WAL");
  db.exec(SCHEMA);
  const startRow = db.prepare("SELECT value FROM meta WHERE key='paper_start'").get();
  if (!startRow) { console.log("  PAPER_START not set -- run paper-trade-k3.js once first.\n"); db.close(); return; }
  const PAPER_START = Number(startRow.value);
  console.log(`  PAPER_START ${iso(PAPER_START)} UTC (shared, immutable)${REPORT_ONLY ? "   [REPORT ONLY -- no writes]" : ""}\n`);

  for (const L of LEDGERS) {
    let inserted = 0, resolved = 0;
    console.log(`  --- ${L.key}   tier=${L.ref.tier}   (${L.ref.rows})`);
    console.log(`      ${L.note}`);

    for (const inst of L.insts) {
      const { trades } = await L.build(inst);
      if (!trades.length) continue;
      let edge = 0;
      try { const c = await loadCandles("4h", inst); edge = c[c.length - 1].t; } catch { continue; }

      for (const t of trades.filter((x) => x.entryTime >= PAPER_START)) {
        const isFinal = t.status === "resolved" && t.exitTime <= edge - LIVE_CUTOFF_BARS * BAR_SEC;
        const exists = db.prepare("SELECT id, status FROM strategy_positions WHERE strategy=? AND instrument=? AND entry_time=? AND side=?")
          .get(L.key, inst, t.entryTime, t.side);
        if (!exists) {
          if (REPORT_ONLY) continue;
          db.prepare(`INSERT INTO strategy_positions (strategy,tier,instrument,timeframe,side,entry_time,entry_price,risk_pct,status,exit_time,exit_price,gross_pct,net_pct,opened_at,closed_at)
                      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
            .run(L.key, L.ref.tier, inst, "4h", t.side, t.entryTime, t.entryPrice, t.riskPct,
                 isFinal ? "resolved" : "open", isFinal ? t.exitTime : null, isFinal ? t.exitPrice : null,
                 isFinal ? t.grossPct : null, isFinal ? t.netPct : null,
                 new Date().toISOString(), isFinal ? new Date().toISOString() : null);
          inserted++; if (isFinal) resolved++;
        } else if (exists.status === "open" && isFinal && !REPORT_ONLY) {
          db.prepare("UPDATE strategy_positions SET status='resolved', exit_time=?, exit_price=?, gross_pct=?, net_pct=?, closed_at=? WHERE id=?")
            .run(t.exitTime, t.exitPrice, t.grossPct, t.netPct, new Date().toISOString(), exists.id);
          resolved++;
        }
      }
    }

    const openN = db.prepare("SELECT COUNT(*) c FROM strategy_positions WHERE strategy=? AND status='open'").get(L.key).c;
    const done = db.prepare("SELECT net_pct FROM strategy_positions WHERE strategy=? AND status='resolved'").all(L.key);
    console.log(`      this tick: +${inserted} inserted, ${resolved} resolved   |   ledger: ${openN} open, ${done.length} resolved`);
    if (done.length) {
      const w = done.filter((r) => r.net_pct > 0).length / done.length;
      console.log(`      forward: win ${(w * 100).toFixed(1)}% (ref ${(L.ref.win * 100).toFixed(1)}%)   net ${(mean(done.map((r) => r.net_pct)) * 100).toFixed(4)}% (ref ${(L.ref.net * 100).toFixed(4)}%)`);
    }
    if (L.key === "OB_SL_4h") {
      console.log(`      ${done.length >= VERDICT_FLOOR
        ? "n >= 60 REACHED -- the spec's criteria may now be evaluated ONCE."
        : `NO VERDICT YET: ${done.length}/${VERDICT_FLOOR} resolved. Interim numbers are not a result.`}`);
    }
    console.log("");
  }
  console.log("  PAPER ONLY. No broker client, no credentials, no order path in this file.");
  db.close();
}

main().catch((e) => { console.error("Fatal:", e); process.exit(1); });
