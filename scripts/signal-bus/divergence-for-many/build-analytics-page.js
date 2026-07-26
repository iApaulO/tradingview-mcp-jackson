#!/usr/bin/env node
// Generates the analytics page from the live DB + a fresh permutation test, rather than a
// hand-transcribed snapshot -- rerun this after any signal-bus rebuild (build-historical.js) to
// keep the page in sync. Reads analytics-page-template.html (static HTML/CSS/JS, one placeholder:
// `const DATA = /*__DATA_JSON__*/;`) and writes analytics-page.html alongside it.
//
// Deterministic example selection (not hand-picked each run): the confluence spotlight is the
// zone with the highest confluence_count (ties broken by lowest zone id); the narrative example is
// the 4H zone with the most touches that has at least one polarity-flip retest, so re-running
// after new data produces a real, reproducible choice rather than whatever looked good this time.
//
// Usage: node scripts/signal-bus/divergence-for-many/build-analytics-page.js [--iterations=50000]

import { DatabaseSync } from "node:sqlite";
import { readFileSync, writeFileSync } from "fs";
import { execSync } from "child_process";
import { runConfluenceSignificanceTest } from "./confluence-significance.js";

const DB_PATH = new URL("../../../data/signal-bus/divergence-for-many.db", import.meta.url);
const TEMPLATE_PATH = new URL("analytics-page-template.html", import.meta.url);
const OUTPUT_PATH = new URL("analytics-page.html", import.meta.url);

const args = Object.fromEntries(process.argv.slice(2).map((a) => a.replace(/^--/, "").split("=")));
const ITERATIONS = parseInt(args.iterations || "50000", 10);

const TF_ORDER = [
  { tf: "1w", label: "Weekly" },
  { tf: "1d", label: "Daily" },
  { tf: "4h", label: "4 Hour" },
  { tf: "3h", label: "3 Hour" },
  { tf: "2h", label: "2 Hour" },
  { tf: "1h", label: "1 Hour" },
  { tf: "15m", label: "15 Min" },
  { tf: "5m", label: "5 Min" },
];

function bucketOf(count) {
  return count >= 4 ? 4 : count;
}

function gitCommit() {
  try {
    return execSync("git rev-parse HEAD", { cwd: new URL("../../../", import.meta.url), encoding: "utf8" }).trim();
  } catch {
    return "unknown";
  }
}

function main() {
  const db = new DatabaseSync(DB_PATH, { readOnly: true });

  const meta = db.prepare("SELECT COUNT(*) zones, MIN(created_time) rangeStart, MAX(confirmed_time) rangeEnd FROM zones").get();
  const totalTouches = db.prepare("SELECT COUNT(*) c FROM touches").get().c;

  const tfRows = db.prepare(
    `SELECT z.timeframe tf, COUNT(DISTINCT z.id) zones,
       SUM(CASE WHEN t.outcome='held' THEN 1 ELSE 0 END) held,
       SUM(CASE WHEN t.outcome='broken' THEN 1 ELSE 0 END) broken
     FROM zones z LEFT JOIN touches t ON t.zone_id = z.id GROUP BY z.timeframe`,
  ).all();
  const tfMap = new Map(tfRows.map((r) => [r.tf, r]));
  const timeframes = TF_ORDER.map(({ tf, label }) => {
    const r = tfMap.get(tf) || { zones: 0, held: 0, broken: 0 };
    return { tf, label, zones: r.zones, held: r.held || 0, broken: r.broken || 0 };
  });

  const bucketRows = db.prepare(
    `SELECT z.confluence_count cc, t.outcome, COUNT(*) c FROM touches t JOIN zones z ON z.id = t.zone_id GROUP BY z.confluence_count, t.outcome`,
  ).all();
  const bucketMap = new Map();
  for (const r of bucketRows) {
    const b = bucketOf(r.cc);
    if (!bucketMap.has(b)) bucketMap.set(b, { held: 0, broken: 0 });
    bucketMap.get(b)[r.outcome] += r.c;
  }
  const bucketLabels = { 1: "Isolated", 2: "2 timeframes", 3: "3 timeframes", 4: "4+ timeframes" };
  const buckets = [1, 2, 3, 4].map((count) => ({
    count,
    label: bucketLabels[count],
    held: bucketMap.get(count)?.held || 0,
    broken: bucketMap.get(count)?.broken || 0,
  }));

  const sideRows = db.prepare(`SELECT z.side, t.outcome, COUNT(*) c FROM touches t JOIN zones z ON z.id = t.zone_id GROUP BY z.side, t.outcome`).all();
  const sides = { bullish: { held: 0, broken: 0 }, bearish: { held: 0, broken: 0 } };
  for (const r of sideRows) sides[r.side][r.outcome] = r.c;

  const flipRows = db.prepare(`SELECT polarity_flip_retest, outcome, COUNT(*) c FROM touches GROUP BY polarity_flip_retest, outcome`).all();
  const polarityFlip = { fresh: { held: 0, broken: 0 }, retest: { held: 0, broken: 0 } };
  for (const r of flipRows) {
    const key = r.polarity_flip_retest ? "retest" : "fresh";
    polarityFlip[key][r.outcome] = r.c;
  }

  // Confluence spotlight: highest confluence_count in the dataset, ties broken by lowest id.
  const topZone = db.prepare("SELECT * FROM zones ORDER BY confluence_count DESC, id ASC LIMIT 1").get();
  const clusterMembers = db
    .prepare(`SELECT z2.timeframe, z2.price FROM zone_confluences zc JOIN zones z2 ON z2.id = zc.confluent_zone_id WHERE zc.zone_id = ?`)
    .all(topZone.id);
  const cluster = {
    price: topZone.price,
    timeframe: topZone.timeframe,
    side: topZone.side,
    confirmedTime: topZone.confirmed_time,
    members: clusterMembers,
  };

  // Narrative spotlight: 4H zone with the most touches that includes at least one polarity-flip
  // retest (the richest available story), deterministic across reruns.
  const narrativeZone = db
    .prepare(
      `SELECT z.*, COUNT(t.id) touchCount
       FROM zones z JOIN touches t ON t.zone_id = z.id
       WHERE z.timeframe = '4h' AND z.id IN (SELECT zone_id FROM touches WHERE polarity_flip_retest = 1)
       GROUP BY z.id ORDER BY touchCount DESC, z.id ASC LIMIT 1`,
    )
    .get();
  const narrativeTouches = db.prepare("SELECT * FROM touches WHERE zone_id = ? ORDER BY start_time").all(narrativeZone.id);
  const narrative = {
    price: narrativeZone.price,
    timeframe: narrativeZone.timeframe,
    side: narrativeZone.side,
    confirmedTime: narrativeZone.confirmed_time,
    expiresTime: narrativeZone.expires_time,
    touches: narrativeTouches.map((t) => ({
      start: t.start_time,
      end: t.end_time,
      bars: t.bars_count,
      outcome: t.outcome,
      approach: t.approach_direction,
      flip: !!t.polarity_flip_retest,
      penetration: t.max_penetration,
    })),
  };

  db.close();

  console.log(`Running significance test (${ITERATIONS} iterations) ...`);
  const sig = runConfluenceSignificanceTest({ iterations: ITERATIONS });
  console.log(`  r=${sig.correlation.real.toFixed(4)} p=${sig.correlation.p.toFixed(4)} | gap=${(sig.gap.real * 100).toFixed(2)}pts p=${sig.gap.p.toFixed(4)}`);

  const DATA = {
    meta: {
      totalZones: meta.zones,
      totalTouches,
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
    cluster,
    narrative,
    sides,
    polarityFlip,
  };

  const template = readFileSync(TEMPLATE_PATH, "utf8");
  const output = template.replace("/*__DATA_JSON__*/", JSON.stringify(DATA));
  writeFileSync(OUTPUT_PATH, output);
  console.log(`\nSaved: ${OUTPUT_PATH.pathname.replace(/^\/([A-Z]:)/, "$1")}`);
}

main();
