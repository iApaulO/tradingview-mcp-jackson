#!/usr/bin/env node
// Wires Boom Hunter into the SMC signal bus, per iapaulo's request: "boom signals occurring in
// confluence with ob or in confluence with our other established signals." Writes three
// persistent fields onto every BULLISH order block (Boom Hunter's validated tradeable signals are
// long-only -- the short side (Break/senter3) only cleared significance on 1 of 4 comparisons in
// boom-hunter-full-signal-significance.js and isn't wired here):
//
//   boom_long_tier     -- which validated Long tier (lime/blue/yellow/gray/enter4) preceded this OB
//                         at its own price level, if any. enter4 graduated 2026-08-09 from dead code
//                         to a wired-in peer tier after testing significant on all 4 R/join cells
//                         (boom-hunter-full-signal-significance.js). Priority when >1 tier fires:
//                         lime/blue/yellow (statistically indistinguishable from each other, all beat
//                         gray) > gray > enter4 (smallest validated effect, +1.4-1.7pts vs the
//                         others' +1.5-2pts).
//   boom_full_sequence -- boom_long_tier present AND a Continuation fired after (same condition
//                         long-ob-continuation-significance.js validated: full vs neither +1.4-1.5pts
//                         p<0.01, full vs partial +1.8-2.0pts p<0.01).
//   boom_nested_depth  -- how many SLOWER timeframes also had a (any-tier) Long signal fire first, in
//                         sequence, near this OB's price, before this OB's own origin (only computed
//                         for boom_full_sequence OBs -- that's the population nested-cross-timeframe-
//                         significance.js actually tested).
//   boom_nested_boost  -- boom_nested_depth >= 1 AND recurrence_count >= 2. This is the ONE combo
//                         nested-recurrence-joint-significance.js found real: nesting added +2.5pts
//                         (1R, p=0.0209) / +2.8pts (1.5R, p=0.0182) WITHIN high-recurrence OBs, but
//                         did nothing on isolated OBs (gap=-0.4pts, p=0.60-0.61). Deliberately does
//                         NOT fire on low-recurrence OBs even if nested_depth>=1 -- that combination
//                         was tested and found null, wiring it in anyway would misrepresent the
//                         result.
//
// Run after build-historical.js AND build-confluence.js (needs recurrence_count already written)
// for smc.db, and after boom-hunter/build-historical.js for boom-hunter.db.
//
// Usage: node scripts/signal-bus/smc/build-boom-confluence.js [--pre-window=50] [--post-window=50] [--price-tolerance=0.01] [--nested-window=10]

import { DatabaseSync } from "node:sqlite";
import { openStore, updateBoomConfluence } from "./store.js";

const BOOM_DB_PATH = new URL("../../../data/signal-bus/boom-hunter.db", import.meta.url);
const LADDER_KEYS = ["1w", "1d", "4h", "3h", "2h", "1h", "15m", "5m"];
const BAR_DURATION_SEC = { "1w": 604800, "1d": 86400, "4h": 14400, "3h": 10800, "2h": 7200, "1h": 3600, "15m": 900, "5m": 300 };
// Priority when multiple tiers fire for the same OB -- lime/blue/yellow proved statistically
// indistinguishable from each other in long-ob-continuation-significance.js (all p>0.15 pairwise),
// all three beat gray, enter4 has the smallest validated effect of the wired-in set.
const TIER_PRIORITY = ["long_lime", "long_blue", "long_yellow", "long_gray", "long_enter4"];
const TIER_LABEL = { long_lime: "lime", long_blue: "blue", long_yellow: "yellow", long_gray: "gray", long_enter4: "enter4" };
const LONG_TYPES = TIER_PRIORITY;

const args = Object.fromEntries(process.argv.slice(2).map((a) => a.replace(/^--/, "").split("=")));
const PRE_WINDOW = parseInt(args["pre-window"] || "50", 10);
const POST_WINDOW = parseInt(args["post-window"] || "50", 10);
const PRICE_TOLERANCE_PCT = parseFloat(args["price-tolerance"] || "0.01");
const NESTED_WINDOW_BARS = parseInt(args["nested-window"] || "10", 10);

// Best-matching Long tier (by TIER_PRIORITY) that fired at or before ob.origin_bar_idx, within
// PRE_WINDOW bars, at a price within tolerance of the OB's own zone. Same condition as
// long-ob-continuation-significance.js's price-anchored "full sequence" classification.
function findBoomLongTier(longsByType, ob) {
  for (const type of TIER_PRIORITY) {
    const longs = longsByType.get(type) || [];
    const hit = longs.some((l) => {
      if (l.bar_idx > ob.origin_bar_idx || ob.origin_bar_idx - l.bar_idx > PRE_WINDOW) return false;
      const tol = l.price * PRICE_TOLERANCE_PCT;
      return ob.bar_low - tol <= l.price && l.price <= ob.bar_high + tol;
    });
    if (hit) return TIER_LABEL[type];
  }
  return null;
}

function hasContinuationAfter(continuations, ob) {
  return continuations.some((c) => c >= ob.origin_bar_idx && c - ob.origin_bar_idx <= POST_WINDOW);
}

// Sequential cascade depth -- identical logic to nested-cross-timeframe-significance.js's
// checkNesting(): slower timeframe's Long signal must precede the OB's origin (real time,
// scaled to that slower timeframe's own bar duration), not just be nearby.
function nestedDepth(boomDb, ob, ownTimeframe, longsCache) {
  const ownIdx = LADDER_KEYS.indexOf(ownTimeframe);
  const slowerTfs = LADDER_KEYS.slice(0, ownIdx);
  let depth = 0;
  for (const tf of slowerTfs) {
    if (!longsCache.has(tf)) {
      longsCache.set(tf, boomDb.prepare(
        `SELECT bar_idx, time, price FROM events WHERE timeframe = ? AND type IN (${LONG_TYPES.map(() => "?").join(",")})`,
      ).all(tf, ...LONG_TYPES));
    }
    const windowSec = NESTED_WINDOW_BARS * BAR_DURATION_SEC[tf];
    const longs = longsCache.get(tf);
    const match = longs.some((l) => {
      if (l.time > ob.origin_time) return false;
      if (ob.origin_time - l.time > windowSec) return false;
      const tol = l.price * PRICE_TOLERANCE_PCT;
      return ob.bar_low - tol <= l.price && l.price <= ob.bar_high + tol;
    });
    if (match) depth++;
  }
  return depth;
}

function main() {
  const smcDb = openStore();
  const boomDb = new DatabaseSync(BOOM_DB_PATH, { readOnly: true });

  const obs = smcDb.prepare(
    "SELECT id, timeframe, origin_bar_idx, origin_time, bar_high, bar_low, recurrence_count FROM order_blocks WHERE side = 'bullish'",
  ).all();
  console.log(`${obs.length} bullish order blocks to tag.`);

  const obsByTf = new Map();
  for (const ob of obs) {
    if (!obsByTf.has(ob.timeframe)) obsByTf.set(ob.timeframe, []);
    obsByTf.get(ob.timeframe).push(ob);
  }

  const results = [];
  const nestedCacheByTf = new Map(); // own-timeframe -> Map(slowerTf -> longs[]), reused across OBs on the same tf

  for (const [tf, tfObs] of obsByTf) {
    const longsByType = new Map();
    for (const type of LONG_TYPES) {
      longsByType.set(type, boomDb.prepare("SELECT bar_idx, time, price FROM events WHERE timeframe = ? AND type = ?").all(tf, type));
    }
    const continuations = boomDb.prepare("SELECT bar_idx FROM events WHERE timeframe = ? AND type = 'continuation'").all(tf).map((r) => r.bar_idx);
    if (!nestedCacheByTf.has(tf)) nestedCacheByTf.set(tf, new Map());
    const longsCache = nestedCacheByTf.get(tf);

    for (const ob of tfObs) {
      const boomLongTier = findBoomLongTier(longsByType, ob);
      const boomFullSequence = boomLongTier != null && hasContinuationAfter(continuations, ob);
      const boomNestedDepth = boomFullSequence ? nestedDepth(boomDb, ob, tf, longsCache) : 0;
      const boomNestedBoost = boomFullSequence && boomNestedDepth >= 1 && ob.recurrence_count >= 2;
      results.push({ id: ob.id, boomLongTier, boomFullSequence, boomNestedDepth, boomNestedBoost });
    }
  }

  boomDb.close();
  updateBoomConfluence(smcDb, results);
  smcDb.close();

  const withTier = results.filter((r) => r.boomLongTier != null).length;
  const fullSeq = results.filter((r) => r.boomFullSequence).length;
  const nested = results.filter((r) => r.boomNestedDepth >= 1).length;
  const boosted = results.filter((r) => r.boomNestedBoost).length;
  console.log(`\n${withTier} order blocks with a Boom Hunter Long tier at their level`);
  console.log(`${fullSeq} full-sequence (tier + Continuation confirmed)`);
  console.log(`${nested} of those with nested_depth>=1 (slower-TF cascade)`);
  console.log(`${boosted} with boom_nested_boost (nested AND recurrence_count>=2 -- the validated combo)`);

  const tierCounts = {};
  for (const r of results) if (r.boomFullSequence) tierCounts[r.boomLongTier] = (tierCounts[r.boomLongTier] || 0) + 1;
  console.log(`\nFull-sequence by tier: ${JSON.stringify(tierCounts)}`);
}

main();
