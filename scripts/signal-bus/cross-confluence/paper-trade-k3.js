#!/usr/bin/env node
// PAPER TRADING ENGINE -- K>=3 co-occurrence. **NO ORDERS ARE EVER PLACED.**
//
// This file contains no broker client, no API keys, no order-placement code of any kind, and is
// structurally incapable of executing a trade. It records SIMULATED fills against live market data
// so that the first unit of FORWARD evidence in this project can start accumulating.
//
// WHY K>=3 AND NOTHING ELSE. #143 pre-registered the construction and it PASSED on SOL, an
// instrument acquired after the configuration was sealed; #144 confirmed it is genuinely
// bidirectional with shorts outperforming longs on all three instruments, which refutes the drift
// confound; and #143's pass authorises exactly one thing -- the #33 ladder's paper/live-shadow
// stage. It has been sitting at that gate since. Every other candidate tested since has failed:
// #150, #151, #153, #155, #158, #162, #165, #169, #171. None of them belongs here.
//
// THE CONSTRUCTION IS #143'S, FROZEN, AND IS NOT RE-DERIVED. Same 2R at 2.0x ATR(14), 200-bar hold,
// stop-first on ambiguous bars, mark-to-market at the hold limit, 0.05/0.15 ATR asymmetric slippage,
// bitunix_futures_vip1 taker plus funding. Paper results are only comparable to the backtest if the
// rules are identical, so they are imported or copied verbatim rather than reimplemented.
//
// available_at IS THE WHOLE INTEGRITY OF THIS FILE. Live is where lookahead actually costs money,
// so three rules are enforced structurally rather than by care:
//   1. THE FORMING BAR IS NEVER USED. Only bars whose close time has passed are considered, and
//      LIVE_CUTOFF drops the most recent bar unconditionally.
//   2. A cluster is not actionable until its LAST member has fired (`knownAtTime`), and entry is
//      the OPEN of the first bar that starts strictly after that.
//   3. Position management only ever reads bars at or after the entry bar.
//
// IDEMPOTENT AND CRASH-SAFE. Every position is keyed by (instrument, rung, knownAtTime), so
// re-running never double-opens. State lives in its own SQLite file with WAL enabled, so a kill
// mid-write cannot corrupt the ledger -- the durability concern the build plan puts in Phase 0.
//
// Usage:
//   node scripts/signal-bus/cross-confluence/paper-trade-k3.js            # tick: open/manage/report
//   node scripts/signal-bus/cross-confluence/paper-trade-k3.js --report   # report only, no writes

import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "fs";
import { loadCandles } from "../../backtest/lib/load-candles.js";
import { FEE_TIERS, REPRESENTATIVE_FUNDING_PCT_PER_HOUR } from "../../backtest/lib/costs.js";
import { loadStructureEvents, buildCooccurrenceClusters } from "./lib/cooccurrence.js";

// ---- #143 frozen configuration, verbatim ----
const CLUSTER_MULT = 1, ATR_LEN = 14, ATR_MULT = 2.0, R_MULT = 2, HOLD_BARS = 200;
const SLIP_ENTRY_ATR = 0.05, SLIP_STOP_ATR = 0.15, SLIP_TARGET_ATR = 0;
const TAKER = FEE_TIERS.bitunix_futures_vip1.takerFeePct;
const MIN_K = 3;

// #145's standalone figures for H_cooccurrence_k3, used purely as the reconciliation reference.
const BACKTEST_REF = { winRate: 0.657, netPerTrade: 0.006232, tradesPerYear: 31.0 };

const INSTRUMENTS = ["BTC", "ETH", "SOL"];
const REPORT_ONLY = process.argv.includes("--report");
const DB_URL = new URL("../../../data/signal-bus/paper-trades.db", import.meta.url);

// Drop the most recent bar unconditionally. Even a bar whose close time has passed may still be
// mid-write in the CSV pipeline, and one stale bar costs nothing while one forming bar is lookahead.
const LIVE_CUTOFF = 1;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS positions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  instrument TEXT NOT NULL,
  rung TEXT NOT NULL,
  known_at INTEGER NOT NULL,       -- cluster's available_at: last member's fire time
  k INTEGER NOT NULL,
  side TEXT NOT NULL,
  entry_time INTEGER NOT NULL,
  entry_price REAL NOT NULL,
  stop_price REAL NOT NULL,
  target_price REAL NOT NULL,
  atr_at_entry REAL NOT NULL,
  status TEXT NOT NULL,            -- open | target | stopped | timeout
  exit_time INTEGER,
  exit_price REAL,
  gross_pct REAL,
  net_pct REAL,
  hours_held REAL,
  opened_at TEXT NOT NULL,         -- wall clock, for audit
  closed_at TEXT,
  UNIQUE(instrument, rung, known_at)
);
CREATE INDEX IF NOT EXISTS idx_pos_status ON positions(status);
CREATE TABLE IF NOT EXISTS ticks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ran_at TEXT NOT NULL,
  opened INTEGER NOT NULL,
  closed INTEGER NOT NULL,
  open_after INTEGER NOT NULL,
  note TEXT
);
-- The single most important row in this database. Set ONCE on the first tick and never rewritten.
-- Without it the first run would open a position for every K>=3 cluster in nine years of history,
-- which is replaying the backtest into the ledger and calling it forward evidence -- the precise
-- self-deception this whole register exists to prevent. Clusters whose knownAtTime precedes this
-- moment are BACKTEST and are ignored permanently.
CREATE TABLE IF NOT EXISTS meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  set_at TEXT NOT NULL
);
`;

function openLedger() {
  mkdirSync(new URL("./", DB_URL), { recursive: true });
  const db = new DatabaseSync(DB_URL);
  db.exec("PRAGMA journal_mode=WAL");
  db.exec(SCHEMA);
  return db;
}
function atrSeries(c, L) {
  const tr = c.map((x, i) => (i === 0 ? x.h - x.l : Math.max(x.h - x.l, Math.abs(x.h - c[i - 1].c), Math.abs(x.l - c[i - 1].c))));
  const o = new Array(c.length).fill(NaN);
  if (c.length < L) return o;
  let s = 0; for (let i = 0; i < L; i++) s += tr[i];
  o[L - 1] = s / L;
  for (let i = L; i < c.length; i++) o[i] = (o[i - 1] * (L - 1) + tr[i]) / L;
  return o;
}
const iso = (t) => new Date(t * 1000).toISOString().slice(0, 16).replace("T", " ");

async function main() {
  console.log("=".repeat(78));
  console.log("  K>=3 CO-OCCURRENCE -- PAPER TRADING.  NO ORDERS ARE PLACED. SIMULATED FILLS ONLY.");
  console.log("=".repeat(78));
  console.log(`  #143 frozen config | ${R_MULT}R @ ${ATR_MULT}x ATR(${ATR_LEN}) | hold<=${HOLD_BARS} | slip ${SLIP_ENTRY_ATR}/${SLIP_STOP_ATR} | taker ${(TAKER * 100).toFixed(3)}% + funding`);
  console.log(`  ledger: data/signal-bus/paper-trades.db${REPORT_ONLY ? "   [REPORT ONLY -- no writes]" : ""}\n`);

  const db = openLedger();
  let opened = 0, closed = 0;

  // PAPER_START: fixed on the first real tick, immutable thereafter. Everything before it is
  // history and is never traded. In --report mode nothing is written, so a report run before the
  // first tick shows the gate as not yet set rather than silently establishing it.
  let startRow = db.prepare("SELECT value, set_at FROM meta WHERE key='paper_start'").get();
  if (!startRow && !REPORT_ONLY) {
    const now = Math.floor(Date.now() / 1000);
    db.prepare("INSERT INTO meta (key,value,set_at) VALUES ('paper_start',?,?)").run(String(now), new Date().toISOString());
    startRow = { value: String(now), set_at: new Date().toISOString() };
    console.log(`  ** PAPER_START set to ${iso(now)} UTC. Clusters before this are history and will never be traded. **\n`);
  }
  const PAPER_START = startRow ? Number(startRow.value) : null;
  if (PAPER_START === null) {
    console.log("  PAPER_START not set yet -- run without --report to begin paper trading.\n");
  } else {
    console.log(`  PAPER_START ${iso(PAPER_START)} UTC (set ${startRow.set_at.slice(0, 16).replace("T", " ")})\n`);
  }

  for (const inst of INSTRUMENTS) {
    let clusters;
    try { clusters = buildCooccurrenceClusters(loadStructureEvents(inst), { mult: CLUSTER_MULT }).filter((c) => c.K >= MIN_K); }
    catch (e) { console.log(`  ${inst}: ${e.message}`); continue; }

    const byRung = new Map();
    for (const c of clusters) {
      if (!byRung.has(c.outcomeRung)) byRung.set(c.outcomeRung, []);
      byRung.get(c.outcomeRung).push(c);
    }

    for (const [rung, list] of byRung) {
      const all = await loadCandles(rung, inst);
      // RULE 1: the forming bar is never used.
      const candles = all.slice(0, all.length - LIVE_CUTOFF);
      if (candles.length < ATR_LEN + 2) continue;
      const atr = atrSeries(candles, ATR_LEN);
      const times = candles.map((x) => x.t);
      const firstAfter = (t) => { let lo = 0, hi = times.length - 1, r = -1;
        while (lo <= hi) { const m = (lo + hi) >> 1; if (times[m] > t) { r = m; hi = m - 1; } else lo = m + 1; } return r; };

      // ---- OPEN new positions ----
      for (const c of list) {
        if (PAPER_START === null || c.knownAtTime < PAPER_START) continue; // history, never traded
        const idx = firstAfter(c.knownAtTime);          // RULE 2
        if (idx < 0 || idx >= candles.length) continue; // entry bar not closed yet -> wait
        const a = atr[idx];
        if (!Number.isFinite(a) || a <= 0) continue;
        const exists = db.prepare("SELECT id FROM positions WHERE instrument=? AND rung=? AND known_at=?").get(inst, rung, c.knownAtTime);
        if (exists) continue;
        if (REPORT_ONLY) continue;

        const side = c.direction === "bullish" ? "long" : "short";
        const risk = ATR_MULT * a;
        const entry = side === "long" ? candles[idx].o + SLIP_ENTRY_ATR * a : candles[idx].o - SLIP_ENTRY_ATR * a;
        const stop = side === "long" ? entry - risk : entry + risk;
        const target = side === "long" ? entry + R_MULT * risk : entry - R_MULT * risk;
        db.prepare(`INSERT INTO positions (instrument,rung,known_at,k,side,entry_time,entry_price,stop_price,target_price,atr_at_entry,status,opened_at)
                    VALUES (?,?,?,?,?,?,?,?,?,?,'open',?)`)
          .run(inst, rung, c.knownAtTime, c.K, side, candles[idx].t, entry, stop, target, a, new Date().toISOString());
        opened++;
      }

      // ---- MANAGE open positions on this rung ----
      const open = db.prepare("SELECT * FROM positions WHERE instrument=? AND rung=? AND status='open'").all(inst, rung);
      for (const p of open) {
        const start = times.indexOf(p.entry_time);
        if (start < 0) continue;
        const end = Math.min(candles.length - 1, start + HOLD_BARS);
        const a = p.atr_at_entry, side = p.side;
        let outcome = null;
        for (let j = start; j <= end; j++) {                 // RULE 3
          const b = candles[j];
          const hitStop = side === "long" ? b.l <= p.stop_price : b.h >= p.stop_price;
          const hitTarget = side === "long" ? b.h >= p.target_price : b.l <= p.target_price;
          if (hitStop) {                                      // stop-first on ambiguous bars
            const fill = side === "long" ? p.stop_price - SLIP_STOP_ATR * a : p.stop_price + SLIP_STOP_ATR * a;
            outcome = { status: "stopped", t: b.t, fill }; break;
          }
          if (hitTarget) {
            const fill = side === "long" ? p.target_price - SLIP_TARGET_ATR * a : p.target_price + SLIP_TARGET_ATR * a;
            outcome = { status: "target", t: b.t, fill }; break;
          }
        }
        if (!outcome && end >= start + HOLD_BARS) {           // mark to market at the hold limit
          const b = candles[end];
          const fill = side === "long" ? b.c - SLIP_ENTRY_ATR * a : b.c + SLIP_ENTRY_ATR * a;
          outcome = { status: "timeout", t: b.t, fill };
        }
        if (!outcome || REPORT_ONLY) continue;                // still running
        const gross = side === "long" ? (outcome.fill - p.entry_price) / p.entry_price : (p.entry_price - outcome.fill) / p.entry_price;
        const hours = (outcome.t - p.entry_time) / 3600;
        const net = gross - 2 * TAKER - REPRESENTATIVE_FUNDING_PCT_PER_HOUR * Math.max(0, hours);
        db.prepare("UPDATE positions SET status=?, exit_time=?, exit_price=?, gross_pct=?, net_pct=?, hours_held=?, closed_at=? WHERE id=?")
          .run(outcome.status, outcome.t, outcome.fill, gross, net, hours, new Date().toISOString(), p.id);
        closed++;
      }
    }
  }

  // ---- LEDGER ----
  const openPos = db.prepare("SELECT * FROM positions WHERE status='open' ORDER BY entry_time DESC").all();
  const done = db.prepare("SELECT * FROM positions WHERE status!='open' ORDER BY exit_time").all();
  if (!REPORT_ONLY) db.prepare("INSERT INTO ticks (ran_at,opened,closed,open_after,note) VALUES (?,?,?,?,?)")
    .run(new Date().toISOString(), opened, closed, openPos.length, "tick");

  console.log(`  this tick: opened ${opened}, closed ${closed}\n`);
  console.log(`  OPEN POSITIONS (${openPos.length})`);
  if (!openPos.length) console.log("    none");
  for (const p of openPos.slice(0, 15)) {
    console.log(`    ${p.instrument.padEnd(4)}${p.rung.padEnd(4)}K=${p.k}  ${p.side.padEnd(5)} entry ${iso(p.entry_time)} @${p.entry_price.toFixed(2)}  stop ${p.stop_price.toFixed(2)}  target ${p.target_price.toFixed(2)}`);
  }
  if (openPos.length > 15) console.log(`    ... and ${openPos.length - 15} more`);

  console.log(`\n  CLOSED (${done.length})`);
  if (done.length) {
    const wins = done.filter((p) => p.net_pct > 0).length;
    const net = done.reduce((s, p) => s + p.net_pct, 0) / done.length;
    const byStatus = {};
    for (const p of done) byStatus[p.status] = (byStatus[p.status] || 0) + 1;
    console.log(`    win ${((wins / done.length) * 100).toFixed(1)}%   net ${(net * 100).toFixed(4)}%/trade   ${JSON.stringify(byStatus)}`);
    console.log("\n  RECONCILIATION vs #145 backtest standalone (win 65.7%, net +0.6232%/trade)");
    console.log(`    win rate   paper ${((wins / done.length) * 100).toFixed(1)}%  vs backtest ${(BACKTEST_REF.winRate * 100).toFixed(1)}%   delta ${(((wins / done.length) - BACKTEST_REF.winRate) * 100).toFixed(1)}pp`);
    console.log(`    net/trade  paper ${(net * 100).toFixed(4)}%  vs backtest ${(BACKTEST_REF.netPerTrade * 100).toFixed(4)}%   delta ${((net - BACKTEST_REF.netPerTrade) * 100).toFixed(4)}pp`);
    console.log(`    ** n=${done.length}. Divergence is uninformative until n is large; #142 put capacity at ~30 trades/yr/instrument. **`);
  } else {
    console.log("    none yet -- nothing to reconcile.");
  }
  db.close();
  console.log("\n  Reminder: PAPER ONLY. This file has no broker client and places no orders.");
}

main().catch((e) => { console.error("Fatal:", e); process.exit(1); });
