#!/usr/bin/env node
// Sanity check for the cascade bus. Asserts structural invariants rather than eyeballing counts --
// this project has shipped two real look-ahead bugs (1e64de8 and #124's touch-refresh clock) and
// neither was caught by a plausible-looking summary table.
//
// The cascade encoding has THREE distinct timestamps that are easy to conflate, and conflating them
// is precisely how look-ahead would enter:
//   start_time           when the cascade's first rung flipped
//   known_at_time        when its LAST participating rung flipped -- the earliest instant the
//                        completed sequence is observable, and the only valid key for a forward test
//   stall_confirmed_time when the next rung's window fully elapsed without a follow -- strictly
//                        later again, since a non-event is not knowable until its window closes
//
// Usage: node scripts/signal-bus/cascade/sanity-check.js [--instrument=BTC]

import { openStore } from "./store.js";

const args = Object.fromEntries(process.argv.slice(2).filter((a) => a.includes("=")).map((a) => a.replace(/^--/, "").split("=")));
const INSTRUMENT = args.instrument || "BTC";

const CHECKS = [
  {
    name: "known_at_time is never before start_time",
    sql: "SELECT COUNT(*) c FROM cascades WHERE known_at_time < start_time",
    why: "LOOK-AHEAD CANARY -- a cascade completing before it began means the sequence was assembled out of order",
  },
  {
    name: "stall_confirmed_time is never before known_at_time",
    sql: "SELECT COUNT(*) c FROM cascades WHERE stall_confirmed_time IS NOT NULL AND stall_confirmed_time < known_at_time",
    why: "LOOK-AHEAD CANARY -- a stall is a non-event and cannot be known until its window has fully elapsed",
  },
  {
    name: "depth equals the number of persisted steps",
    sql: "SELECT COUNT(*) c FROM (SELECT c.id, c.depth, COUNT(s.id) n FROM cascades c JOIN cascade_steps s ON s.cascade_id = c.id GROUP BY c.id, c.depth HAVING c.depth <> n)",
    why: "the summary field and the step rows must not disagree, or every downstream depth filter is wrong",
  },
  {
    name: "steps are strictly increasing in time within a cascade",
    sql: `SELECT COUNT(*) c FROM cascade_steps a JOIN cascade_steps b
          ON a.cascade_id = b.cascade_id AND b.step_idx = a.step_idx + 1 AND b.time <= a.time`,
    why: "strict time-ordering IS the hypothesis -- a sequence where a later rung fired first is not a cascade",
  },
  {
    name: "steps are strictly monotonic in rung index",
    sql: `SELECT COUNT(*) c FROM cascade_steps a JOIN cascade_steps b JOIN cascades k
          ON a.cascade_id = b.cascade_id AND b.step_idx = a.step_idx + 1 AND k.id = a.cascade_id
          WHERE (k.propagation = 'top_down' AND b.rung_idx <= a.rung_idx)
             OR (k.propagation = 'bottom_up' AND b.rung_idx >= a.rung_idx)`,
    why: "a top-down cascade must move to strictly finer rungs and a bottom-up one to strictly coarser; skipping is allowed, reversing is not",
  },
  {
    name: "reached_end and stalled_at are mutually exclusive",
    sql: "SELECT COUNT(*) c FROM cascades WHERE (reached_end = 1) = (stalled_at IS NOT NULL)",
    why: "a cascade either ran out of ladder or stalled, never both and never neither",
  },
  {
    name: "full_ladder implies depth = 8",
    sql: "SELECT COUNT(*) c FROM cascades WHERE full_ladder = 1 AND depth <> 8",
    why: "full_ladder is defined as traversing every rung; it is NOT the same as reached_end",
  },
  {
    name: "every cascade has depth >= 2",
    sql: "SELECT COUNT(*) c FROM cascades WHERE depth < 2",
    why: "a single flip is not a propagation",
  },
  {
    name: "step latencies are non-negative",
    sql: "SELECT COUNT(*) c FROM cascade_steps WHERE latency_bars IS NOT NULL AND latency_bars < 0",
    why: "latency is measured forward from the previous step",
  },
  {
    name: "first step has no latency, later steps all have one",
    sql: "SELECT COUNT(*) c FROM cascade_steps WHERE (step_idx = 0) <> (latency_bars IS NULL)",
    why: "latency is defined relative to a predecessor, so exactly the first step lacks it",
  },
  {
    name: "every row carries this instrument",
    sql: `SELECT COUNT(*) c FROM cascades WHERE instrument <> '${INSTRUMENT}'`,
    why: "per-instrument DB files plus an instrument column; a mismatch means a build wrote to the wrong file",
  },
];

function main() {
  const db = openStore(INSTRUMENT);
  console.log(`Cascade bus sanity check -- ${INSTRUMENT}\n`);
  const t = db.prepare("SELECT (SELECT COUNT(*) FROM cascades) c, (SELECT COUNT(*) FROM cascade_steps) s, (SELECT COUNT(*) FROM runs) r").get();
  console.log(`rows: ${t.c.toLocaleString()} cascades, ${t.s.toLocaleString()} steps, ${t.r} runs\n`);

  let failed = 0;
  for (const chk of CHECKS) {
    const bad = db.prepare(chk.sql).get().c;
    if (bad === 0) console.log(`  PASS  ${chk.name}`);
    else { failed++; console.log(`  FAIL  ${chk.name} -- ${bad.toLocaleString()} violations\n        (${chk.why})`); }
  }

  console.log(`\n--- propagation asymmetry by event family (context, not assertions) ---`);
  const rows = db.prepare(
    `SELECT event_family, propagation, COUNT(*) n, ROUND(AVG(depth), 3) mean_depth, SUM(depth >= 3) deep
     FROM cascades WHERE window_mult = 1 GROUP BY event_family, propagation ORDER BY event_family, propagation DESC`,
  ).all();
  for (const r of rows) {
    console.log(`  ${r.event_family.padEnd(14)} ${r.propagation.padEnd(10)} n=${String(r.n).padStart(5)}  mean depth=${r.mean_depth}  depth>=3: ${r.deep}`);
  }
  const full = db.prepare("SELECT COUNT(*) c FROM cascades WHERE full_ladder = 1").get().c;
  console.log(`  full 8-rung traversals across the entire persisted grid: ${full}`);

  db.close();
  console.log(failed === 0 ? `\nAll ${CHECKS.length} invariants pass.` : `\n${failed} of ${CHECKS.length} invariants FAILED.`);
  process.exit(failed === 0 ? 0 : 1);
}

main();
