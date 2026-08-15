#!/usr/bin/env node
// Sanity check for the ICT Concepts bus. Verifies structural invariants that must hold if the port
// is faithful, rather than eyeballing counts -- the two port bugs this project has shipped
// (1e68eb4-era look-ahead, #124's touch-refresh clock) would both have been caught by an assertion
// like these, and neither was caught by a plausible-looking summary table.
//
// Usage: node scripts/signal-bus/ict/sanity-check.js [--instrument=BTC]

import { openStore } from "./store.js";

const args = Object.fromEntries(process.argv.slice(2).filter((a) => a.includes("=")).map((a) => a.replace(/^--/, "").split("=")));
const INSTRUMENT = args.instrument || "BTC";

const CHECKS = [
  {
    name: "every zone has top > bottom",
    sql: "SELECT COUNT(*) c FROM fvg_zones WHERE top <= bottom",
    why: "the imbalance condition guarantees it geometrically; a violation means the FVG/IFVG box corners were mapped wrongly",
  },
  {
    name: "origin_bar_idx is exactly created_bar_idx - 2",
    sql: "SELECT COUNT(*) c FROM fvg_zones WHERE origin_bar_idx <> created_bar_idx - 2",
    why: "the gap spans bars i-2..i and is confirmed at i; any other offset means the detection bar drifted",
  },
  {
    name: "no zone breaks at or before its own creation bar",
    sql: "SELECT COUNT(*) c FROM fvg_zones WHERE broken_bar_idx IS NOT NULL AND broken_bar_idx <= created_bar_idx",
    why: "LOOK-AHEAD CANARY -- a zone resolving before it exists means future data reached backwards",
  },
  {
    name: "no zone is first touched before its creation bar",
    sql: "SELECT COUNT(*) c FROM fvg_zones WHERE first_touch_bar_idx IS NOT NULL AND first_touch_bar_idx <= created_bar_idx",
    why: "LOOK-AHEAD CANARY -- same class as above, on the partial-penetration path",
  },
  {
    name: "broken zones are flagged broken and carry a break bar",
    sql: "SELECT COUNT(*) c FROM fvg_zones WHERE (status = 'broken') <> (broken_bar_idx IS NOT NULL)",
    why: "status and the break timestamp must agree or downstream filters silently disagree with each other",
  },
  {
    name: "broken zones record full fill",
    sql: "SELECT COUNT(*) c FROM fvg_zones WHERE status = 'broken' AND max_fill_pct < 1",
    why: "a full traversal is by definition a 100% fill",
  },
  {
    name: "active zones were never touched",
    sql: "SELECT COUNT(*) c FROM fvg_zones WHERE status = 'active' AND first_touch_bar_idx IS NOT NULL",
    why: "a touched zone must be promoted out of 'active'",
  },
  {
    name: "fill percentage stays in [0,1]",
    sql: "SELECT COUNT(*) c FROM fvg_zones WHERE max_fill_pct < 0 OR max_fill_pct > 1",
    why: "it is a clamped ratio",
  },
  {
    name: "displacement body always exceeds its own trailing mean",
    sql: "SELECT COUNT(*) c FROM displacement_events WHERE body <= mean_body",
    why: "L_bodyUP/DN require body > meanBody by construction",
  },
  {
    name: "volume-imbalance zones have top > bottom",
    sql: "SELECT COUNT(*) c FROM volume_imbalance_events WHERE top <= bottom",
    why: "normalised at write time",
  },
  {
    name: "every row is labelled with this instrument",
    sql: `SELECT COUNT(*) c FROM fvg_zones WHERE instrument <> '${INSTRUMENT}'`,
    why: "per-instrument DB files plus an instrument column; a mismatch means a build wrote to the wrong file",
  },
];

function main() {
  const db = openStore(INSTRUMENT);
  console.log(`ICT bus sanity check -- ${INSTRUMENT}\n`);

  const totals = db.prepare("SELECT (SELECT COUNT(*) FROM fvg_zones) f, (SELECT COUNT(*) FROM displacement_events) d, (SELECT COUNT(*) FROM volume_imbalance_events) v").get();
  console.log(`rows: ${totals.f.toLocaleString()} FVG/IFVG zones, ${totals.d.toLocaleString()} displacement, ${totals.v.toLocaleString()} volume-imbalance\n`);

  let failed = 0;
  for (const chk of CHECKS) {
    const bad = db.prepare(chk.sql).get().c;
    if (bad === 0) console.log(`  PASS  ${chk.name}`);
    else { failed++; console.log(`  FAIL  ${chk.name} -- ${bad.toLocaleString()} violations\n        (${chk.why})`); }
  }

  // Descriptive, not pass/fail: the base rates a reader needs before interpreting any FVG finding.
  console.log(`\n--- base rates (context, not assertions) ---`);
  const byKind = db.prepare("SELECT kind, COUNT(*) n, SUM(status='broken') broken, AVG(size_atr) avg_size_atr FROM fvg_zones GROUP BY kind").all();
  for (const r of byKind) {
    console.log(`  ${r.kind.padEnd(5)} n=${r.n.toLocaleString().padStart(8)}  broken=${((r.broken / r.n) * 100).toFixed(1)}%  mean size=${r.avg_size_atr ? r.avg_size_atr.toFixed(3) : "n/a"} ATR`);
  }
  const unfilled = db.prepare("SELECT COUNT(*) c FROM fvg_zones WHERE status <> 'broken'").get().c;
  console.log(`  unfilled zones: ${unfilled.toLocaleString()} (${((unfilled / totals.f) * 100).toFixed(2)}%) -- any construction conditioning on "unfilled FVG" inherits this as its population ceiling`);

  db.close();
  console.log(failed === 0 ? `\nAll ${CHECKS.length} invariants pass.` : `\n${failed} of ${CHECKS.length} invariants FAILED.`);
  process.exit(failed === 0 ? 0 : 1);
}

main();
