#!/usr/bin/env node
// Generates the SMC analytics page from the live DB + a fresh permutation test, same pattern as
// divergence-for-many/build-analytics-page.js. Rerun after any future signal-bus rebuild.
//
// Usage: node scripts/signal-bus/smc/build-analytics-page.js [--iterations=200000]

import { DatabaseSync } from "node:sqlite";
import { readFileSync, writeFileSync } from "fs";
import { execSync } from "child_process";
import { runSMCConfluenceSignificanceTest } from "./confluence-significance.js";

const DB_PATH = new URL("../../../data/signal-bus/smc.db", import.meta.url);
const TEMPLATE_PATH = new URL("analytics-page-template.html", import.meta.url);
const OUTPUT_PATH = new URL("analytics-page.html", import.meta.url);

const args = Object.fromEntries(process.argv.slice(2).map((a) => a.replace(/^--/, "").split("=")));
const ITERATIONS = parseInt(args.iterations || "200000", 10);

const TF_ORDER = [
  { tf: "1w", label: "Weekly" }, { tf: "1d", label: "Daily" }, { tf: "4h", label: "4 Hour" }, { tf: "3h", label: "3 Hour" },
  { tf: "2h", label: "2 Hour" }, { tf: "1h", label: "1 Hour" }, { tf: "15m", label: "15 Min" }, { tf: "5m", label: "5 Min" },
];

function gitCommit() {
  try {
    return execSync("git rev-parse HEAD", { cwd: new URL("../../../", import.meta.url), encoding: "utf8" }).trim();
  } catch {
    return "unknown";
  }
}

function main() {
  const db = new DatabaseSync(DB_PATH, { readOnly: true });

  const meta = db.prepare("SELECT COUNT(*) c, MIN(created_time) rangeStart, MAX(created_time) rangeEnd FROM order_blocks").get();
  const totalTouches = db.prepare("SELECT COUNT(*) c FROM order_block_touches").get().c;
  const poolSize =
    db.prepare("SELECT COUNT(*) c FROM order_blocks").get().c +
    db.prepare("SELECT COUNT(*) c FROM eqh_eql_events").get().c +
    db.prepare("SELECT COUNT(*) c FROM structure_events").get().c;

  const tfRows = db.prepare(
    `SELECT
       (SELECT COUNT(*) FROM structure_events se WHERE se.timeframe = tf) structureEvents,
       (SELECT COUNT(*) FROM eqh_eql_events ee WHERE ee.timeframe = tf) eqhEql,
       (SELECT COUNT(*) FROM order_blocks ob WHERE ob.timeframe = tf) orderBlocks,
       tf
     FROM (SELECT DISTINCT timeframe tf FROM structure_events)`,
  ).all();
  const tfMap = new Map(tfRows.map((r) => [r.tf, r]));
  const timeframes = TF_ORDER.map(({ tf, label }) => {
    const r = tfMap.get(tf) || { structureEvents: 0, eqhEql: 0, orderBlocks: 0 };
    return { tf, label, structureEvents: r.structureEvents, eqhEql: r.eqhEql, orderBlocks: r.orderBlocks };
  });

  const bucketRows = db.prepare(
    `SELECT ob.confluence_count cc, obt.outcome, COUNT(*) c FROM order_block_touches obt JOIN order_blocks ob ON ob.id = obt.order_block_id GROUP BY cc, obt.outcome`,
  ).all();
  const bucketMap = new Map();
  for (const r of bucketRows) {
    if (!bucketMap.has(r.cc)) bucketMap.set(r.cc, { held: 0, broken: 0 });
    bucketMap.get(r.cc)[r.outcome] += r.c;
  }
  const maxCC = Math.max(...bucketMap.keys());
  const buckets = [];
  for (let cc = 1; cc <= maxCC; cc++) {
    const v = bucketMap.get(cc);
    if (v) buckets.push({ count: cc, held: v.held, broken: v.broken });
  }

  const scopeSideRows = db
    .prepare(`SELECT ob.scope, ob.side, obt.outcome, COUNT(*) c FROM order_block_touches obt JOIN order_blocks ob ON ob.id = obt.order_block_id GROUP BY ob.scope, ob.side, obt.outcome`)
    .all();
  const scopeSide = {
    internal: { bullish: { held: 0, broken: 0 }, bearish: { held: 0, broken: 0 } },
    swing: { bullish: { held: 0, broken: 0 }, bearish: { held: 0, broken: 0 } },
  };
  for (const r of scopeSideRows) scopeSide[r.scope][r.side][r.outcome] = r.c;

  const narrativeOb = db
    .prepare(
      `SELECT ob.*, COUNT(t.id) tc FROM order_blocks ob JOIN order_block_touches t ON t.order_block_id = ob.id
       WHERE ob.status = 'mitigated' AND ob.timeframe IN ('4h','1d') AND ob.scope = 'swing'
       GROUP BY ob.id HAVING tc BETWEEN 4 AND 10 ORDER BY tc DESC, ob.id ASC LIMIT 1`,
    )
    .get();
  const narrativeTouches = db.prepare("SELECT * FROM order_block_touches WHERE order_block_id = ? ORDER BY start_time").all(narrativeOb.id);
  const narrative = {
    barLow: narrativeOb.bar_low,
    barHigh: narrativeOb.bar_high,
    timeframe: narrativeOb.timeframe,
    scope: narrativeOb.scope,
    side: narrativeOb.side,
    confluenceCount: narrativeOb.confluence_count,
    createdTime: narrativeOb.created_time,
    mitigatedTime: narrativeOb.mitigated_time,
    touches: narrativeTouches.map((t) => ({
      start: t.start_time,
      end: t.end_time,
      bars: t.bars_count,
      outcome: t.outcome,
      approach: t.approach_direction,
      penetrationPct: t.max_penetration_pct,
    })),
  };

  db.close();

  console.log(`Running significance test (${ITERATIONS} iterations) ...`);
  const sig = runSMCConfluenceSignificanceTest({ iterations: ITERATIONS });
  console.log(`  r=${sig.correlation.real.toFixed(4)} p=${sig.correlation.p.toFixed(5)} | gap=${(sig.gap.real * 100).toFixed(2)}pts p=${sig.gap.p.toFixed(5)}`);

  const DATA = {
    meta: {
      totalOrderBlocks: meta.c,
      totalTouches,
      poolSize,
      rangeStart: meta.rangeStart,
      rangeEnd: meta.rangeEnd,
      gitCommit: gitCommit(),
      generatedAt: new Date().toISOString(),
    },
    timeframes,
    confluence: {
      buckets,
      significance: {
        iterations: sig.iterations,
        correlation: { real: sig.correlation.real, p: sig.correlation.p },
        gap: { real: sig.gap.real, p: sig.gap.p },
      },
    },
    scopeSide,
    narrative,
  };

  const template = readFileSync(TEMPLATE_PATH, "utf8");
  const output = template.replace("/*__DATA_JSON__*/", JSON.stringify(DATA));
  writeFileSync(OUTPUT_PATH, output);
  console.log(`\nSaved: ${OUTPUT_PATH.pathname.replace(/^\/([A-Z]:)/, "$1")}`);
}

main();
