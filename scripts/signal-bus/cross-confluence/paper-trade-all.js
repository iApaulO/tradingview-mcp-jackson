#!/usr/bin/env node
// MULTI-STRATEGY PAPER LEDGER. **NO ORDERS ARE PLACED.** No broker client, no credentials, no
// order-placement path anywhere in this file.
//
// WHY THIS SUPERSEDES THE K>=3-ONLY LEDGER. #172 put only K>=3 into paper, gated on "passed a
// pre-registration". That was the wrong gate. **Paper's job is not to re-adjudicate which
// construction is best -- it is to answer ONE question: does a validated construction behave
// FORWARD the way it behaved in backtest?** That question applies to every construction that has
// been validated, at whatever evidence tier, and gating it on the strictest tier meant the ledger
// accumulated at ~30 trades/yr/instrument and would have taken most of a year to say anything.
//
// #167 established that A2, A and G are all BI-DIRECTIONAL and all clear costs, alongside K>=3.
// Their frequencies differ by two orders of magnitude -- A ~5,255/yr, A2 ~1,951/yr, G ~76/yr,
// H ~31/yr -- so running all four turns "months before n means anything" into days for the fast
// ones while the slow one accumulates in the background. Nothing is lost by including them and a
// year of waiting is lost by excluding them.
//
// **EVIDENCE TIER IS RECORDED PER STRATEGY AND MUST NOT BE FLATTENED.** H passed a pre-registration
// on an instrument sealed in advance (#143) and is the only one that did. A2/A/G are OOS-validated
// (#120/#121) and directionally sound (#167) but were never pre-registered. Those are different
// standards of evidence and the ledger carries the distinction so a future reader cannot lose it.
//
// EACH STRATEGY KEEPS ITS OWN CONSTRUCTION. H uses 2.0x ATR; A/A2/G use 0.6x. #138 showed H FAILS
// out-of-sample at 0.6x purely because the risk unit is too small against a 0.10% round trip, so
// forcing one geometry on all four would test constructions that were never validated. The builders
// are IMPORTED from portfolio-backtest.js, never reimplemented -- a second copy of a population
// definition is how two copies silently diverge.
//
// HOW ENTRIES AND EXITS ARE HANDLED, and why this is not circular. The builders are deterministic
// functions of the candle data: given more data they resolve more trades, and a trade's entry is
// fixed the moment its signal bar closes. So each tick re-runs the builders and:
//   * any trade whose entryTime >= PAPER_START and is not yet in the ledger is INSERTED as open;
//   * any ledger row whose builder-computed exit now lands on a CLOSED bar is marked resolved.
// **The truncation trap is handled explicitly: a builder marks an unresolved trade as exiting at the
// last available bar (mark-to-market), which is indistinguishable in shape from a real timeout. A
// row is therefore only closed when its exit bar is at least LIVE_CUTOFF bars behind the newest
// data, so a provisional mark-to-market at the data edge is never recorded as a finished trade.**
//
// PAPER_START is shared with the K>=3 ledger and is NEVER reset: clusters and signals before it are
// history. Without that gate the first tick would insert every historical trade -- 47,239 for A
// alone -- and print a spectacular fictitious track record.
//
// Usage:
//   node scripts/signal-bus/cross-confluence/paper-trade-all.js
//   node scripts/signal-bus/cross-confluence/paper-trade-all.js --report

import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "fs";
import { loadCandles } from "../../backtest/lib/load-candles.js";
import { applyCosts } from "../../backtest/lib/costs.js";
import {
  buildStrategyA, buildStrategyA2, buildStrategyG, buildStrategyH, PORTFOLIO_COST_PARAMS,
} from "./portfolio-backtest.js";

const REPORT_ONLY = process.argv.includes("--report");
const DB_URL = new URL("../../../data/signal-bus/paper-trades.db", import.meta.url);
const LIVE_CUTOFF_BARS = 2;   // an exit must be this far behind the data edge to count as final
const LADDER = ["1w", "1d", "4h", "3h", "2h", "1h", "15m", "5m"];

// strategy -> [builder, evidence tier, register rows]
const STRATEGIES = [
  ["H_cooccurrence_k3", buildStrategyH, "pre-registered", "#143 #144"],
  ["A2_engulfment_only", buildStrategyA2, "oos-validated", "#120 #121 #167"],
  ["A_recurrence", buildStrategyA, "oos-validated", "#167"],
  ["G_wt_anchor_ct_15m", buildStrategyG, "oos-validated", "#106-#125 #167"],
];

// #145 standalone reference figures, for reconciliation only.
const REF = {
  H_cooccurrence_k3: { win: 0.657, net: 0.006232 },
  A2_engulfment_only: { win: 0.551, net: 0.002366 },
  A_recurrence: { win: 0.561, net: 0.002631 },
  G_wt_anchor_ct_15m: { win: 0.210, net: 0.004100 },
};

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
  status TEXT NOT NULL,          -- open | resolved
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
  console.log("  MULTI-STRATEGY PAPER LEDGER.  NO ORDERS ARE PLACED. SIMULATED FILLS ONLY.");
  console.log("=".repeat(80));

  mkdirSync(new URL("./", DB_URL), { recursive: true });
  const db = new DatabaseSync(DB_URL);
  db.exec("PRAGMA journal_mode=WAL");
  db.exec(SCHEMA);

  const startRow = db.prepare("SELECT value, set_at FROM meta WHERE key='paper_start'").get();
  if (!startRow) { console.log("  PAPER_START not set -- run paper-trade-k3.js once first.\n"); db.close(); return; }
  const PAPER_START = Number(startRow.value);
  console.log(`  PAPER_START ${iso(PAPER_START)} UTC${REPORT_ONLY ? "   [REPORT ONLY -- no writes]" : ""}`);
  console.log("  Signals before that timestamp are HISTORY and are never inserted.\n");

  // BTC only: the portfolio builders read the BTC databases directly (see #145).
  const candlesByTf = {};
  for (const tf of LADDER) candlesByTf[tf] = await loadCandles(tf);
  const newestByTf = {};
  for (const tf of LADDER) newestByTf[tf] = candlesByTf[tf].length ? candlesByTf[tf][candlesByTf[tf].length - 1].t : 0;
  const barSec = { "1w": 604800, "1d": 86400, "4h": 14400, "3h": 10800, "2h": 7200, "1h": 3600, "15m": 900, "5m": 300 };

  let inserted = 0, resolved = 0;
  for (const [name, builder, tier, rows] of STRATEGIES) {
    const raw = await builder(candlesByTf);
    const costed = applyCosts(raw, PORTFOLIO_COST_PARAMS);
    const live = costed.filter((t) => t.entryTime >= PAPER_START);

    for (const t of live) {
      const exists = db.prepare("SELECT id, status FROM strategy_positions WHERE strategy=? AND instrument=? AND entry_time=? AND side=?")
        .get(name, "BTC", t.entryTime, t.side);
      // is the builder's exit final, or a mark-to-market at the data edge?
      const edge = newestByTf[t.timeframe] || 0;
      const isFinal = t.exitTime != null && edge > 0 && t.exitTime <= edge - LIVE_CUTOFF_BARS * (barSec[t.timeframe] || 3600);

      if (!exists) {
        if (REPORT_ONLY) continue;
        db.prepare(`INSERT INTO strategy_positions (strategy,tier,instrument,timeframe,side,entry_time,entry_price,risk_pct,status,exit_time,exit_price,gross_pct,net_pct,opened_at,closed_at)
                    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
          .run(name, tier, "BTC", t.timeframe, t.side, t.entryTime, t.entryPrice, t.riskPct,
               isFinal ? "resolved" : "open",
               isFinal ? t.exitTime : null, isFinal ? t.exitPrice : null,
               isFinal ? t.pnlPct : null, isFinal ? t.costedPnlPct ?? t.pnlPct : null,
               new Date().toISOString(), isFinal ? new Date().toISOString() : null);
        inserted++; if (isFinal) resolved++;
      } else if (exists.status === "open" && isFinal && !REPORT_ONLY) {
        db.prepare("UPDATE strategy_positions SET status='resolved', exit_time=?, exit_price=?, gross_pct=?, net_pct=?, closed_at=? WHERE id=?")
          .run(t.exitTime, t.exitPrice, t.pnlPct, t.costedPnlPct ?? t.pnlPct, new Date().toISOString(), exists.id);
        resolved++;
      }
    }
    const openN = db.prepare("SELECT COUNT(*) c FROM strategy_positions WHERE strategy=? AND status='open'").get(name).c;
    const doneRows = db.prepare("SELECT net_pct FROM strategy_positions WHERE strategy=? AND status='resolved'").all(name);
    const ref = REF[name];
    let line = `  ${name.padEnd(20)} ${tier.padEnd(15)} signals_since_start=${String(live.length).padStart(5)}  open=${String(openN).padStart(4)}  resolved=${String(doneRows.length).padStart(4)}`;
    if (doneRows.length) {
      const w = doneRows.filter((r) => r.net_pct > 0).length / doneRows.length;
      const nm = mean(doneRows.map((r) => r.net_pct));
      line += `  win ${(w * 100).toFixed(1)}% (ref ${(ref.win * 100).toFixed(1)}%)  net ${(nm * 100).toFixed(4)}% (ref ${(ref.net * 100).toFixed(4)}%)`;
    }
    console.log(line);
    console.log(`  ${" ".repeat(20)} evidence: ${rows}`);
  }

  console.log(`\n  this tick: inserted ${inserted}, resolved ${resolved}`);
  const tot = db.prepare("SELECT COUNT(*) c FROM strategy_positions").get().c;
  const totOpen = db.prepare("SELECT COUNT(*) c FROM strategy_positions WHERE status='open'").get().c;
  console.log(`  ledger totals: ${tot} positions, ${totOpen} open`);
  console.log("\n  Reconciliation is only meaningful once resolved n is large. Fast strategies (A, A2)");
  console.log("  reach that in days; H at ~31/yr will take months. Tier is recorded per row and must");
  console.log("  not be flattened -- only H passed a pre-registration.");
  console.log("\n  PAPER ONLY. No broker client, no credentials, no order path in this file.");
  db.close();
}

main().catch((e) => { console.error("Fatal:", e); process.exit(1); });
