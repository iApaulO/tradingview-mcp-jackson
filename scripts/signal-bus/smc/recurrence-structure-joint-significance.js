#!/usr/bin/env node
// Joint test of the two real, separately-validated OB signals iapaulo pointed at live on the same
// chart: recurrence_count (order blocks stacking/overlapping on the SAME timeframe -- validated real
// at 1R/1.5R in recurrence-fixed-rr-significance.js, r=0.286-0.312, p=0) and structural attachment
// to a swing CHoCH/BOS (validated on 3h/4h tonight with a STRICT "clearly below/above" definition in
// cross-confluence/ob-structure-confluence-significance.js -- a LOOSER "attached/inside the zone"
// version of that same test reversed the effect, so both tolerance definitions are carried here in
// parallel rather than picked arbitrarily).
//
// Question: do the two signals combine -- does structural attachment sharpen the recurrence effect
// (or vice versa), or are they redundant/interfering? Same real methodology as
// recurrence-fixed-rr-significance.js throughout: real order_block_touches (not synthetic MFE),
// entry at the touch's next-bar open, stop at the OB's opposite edge, fixed R-multiple target,
// order-block-level permutation shuffle (preserves within-OB trade clustering, same as every other
// significance test in this suite).
//
// Usage: node scripts/signal-bus/smc/recurrence-structure-joint-significance.js [--iterations=20000] [--r=1,1.5]

import { DatabaseSync } from "node:sqlite";
import { writeFileSync, mkdirSync } from "fs";
import { execSync } from "child_process";
import { loadCandles } from "../../backtest/lib/load-candles.js";

const DB_PATH = new URL("../../../data/signal-bus/smc.db", import.meta.url);
const BAR_DURATION_SEC = { "1w": 604800, "1d": 86400, "4h": 14400, "3h": 10800, "2h": 7200, "1h": 3600, "15m": 900, "5m": 300 };
const MAX_HOLD_BARS = 200;

const args = Object.fromEntries(process.argv.slice(2).map((a) => a.replace(/^--/, "").split("=")));
const ITERATIONS = parseInt(args.iterations || "20000", 10);
const SEED = parseInt(args.seed || "42", 10);
const R_MULTIPLES = (args.r || "1,1.5").split(",").map(Number);

function gitCommit() {
  try { return execSync("git rev-parse HEAD", { cwd: new URL("../../../", import.meta.url), encoding: "utf8" }).trim(); }
  catch { return "unknown"; }
}
function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function shuffle(arr, rng) {
  const out = [...arr];
  for (let i = out.length - 1; i > 0; i--) { const j = Math.floor(rng() * (i + 1)); [out[i], out[j]] = [out[j], out[i]]; }
  return out;
}
function winRate(vals) { return vals.length ? vals.reduce((s, x) => s + x, 0) / vals.length : null; }

// Structure attachment, CORRECTED 2026-08-08 after iapaulo verified a real 4h case directly against
// the DB: swing bearish BOS at bar_idx 19418 (price 59073.01), bullish OB origin at bar_idx 19421 --
// a 3-bar gap. That was counted as "attached" by the old 60-bar time-window version, but iapaulo's
// own read of the chart says it isn't -- a few candles of separation means the OB did NOT form as
// part of the same structural event, regardless of price overlap. True attachment is bar-adjacency:
// the structure event's own bar_idx must be at or within a couple bars of the OB's origin_bar_idx,
// not "sometime in a 60-bar window." Tested per scope (swing vs internal) separately rather than
// merged, since iapaulo's live read flagged the DASHED (internal) CHoCH sitting at the same bar as
// the solid BOS as the more plausibly relevant one -- scope itself might matter, not just distance.
const MAX_ATTACH_BAR_GAP = 2;
function loadStructureAttachment(smcDb, obRows) {
  const byTf = new Map();
  for (const ob of obRows) {
    if (!byTf.has(ob.timeframe)) byTf.set(ob.timeframe, []);
    byTf.get(ob.timeframe).push(ob);
  }
  const attachSwing = new Map(), attachInternal = new Map();
  for (const [tf, obs] of byTf) {
    for (const scope of ["swing", "internal"]) {
      const target = scope === "swing" ? attachSwing : attachInternal;
      for (const side of ["bullish", "bearish"]) {
        const structSide = side === "bullish" ? "bearish" : "bullish";
        const structureEvents = smcDb.prepare(
          "SELECT bar_idx as barIdx FROM structure_events WHERE timeframe = ? AND scope = ? AND side = ? AND type IN ('CHOCH','BOS')",
        ).all(tf, scope, structSide);
        for (const ob of obs.filter((o) => o.side === side)) {
          const attached = structureEvents.some((s) => Math.abs(s.barIdx - ob.origin_bar_idx) <= MAX_ATTACH_BAR_GAP);
          target.set(ob.id, attached);
        }
      }
    }
  }
  return { attachSwing, attachInternal };
}

async function buildOutcomes(rMultiple) {
  const db = new DatabaseSync(DB_PATH, { readOnly: true });
  const obRows = db.prepare("SELECT id, timeframe, side, bar_high, bar_low, origin_bar_idx, recurrence_count FROM order_blocks").all();
  const { attachSwing, attachInternal } = loadStructureAttachment(db, obRows);
  // FIXED 2026-08-08: binding one "?" per order block (83k+ now that the tracking cap is removed)
  // exceeds SQLite's bound-parameter limit. obRows is already every order block unfiltered, so the
  // IN-list was redundant anyway -- just pull all touches and look up via obById below.
  const touchRows = db.prepare("SELECT order_block_id, start_bar_idx FROM order_block_touches").all();
  db.close();

  const obById = new Map(obRows.map((o) => [o.id, o]));
  const entriesByTf = new Map();
  for (const t of touchRows) {
    const ob = obById.get(t.order_block_id);
    if (!entriesByTf.has(ob.timeframe)) entriesByTf.set(ob.timeframe, []);
    entriesByTf.get(ob.timeframe).push({ startBarIdx: t.start_bar_idx, ob });
  }

  const obOutcomes = new Map();
  for (const [tf, entries] of entriesByTf) {
    const candles = await loadCandles(tf);
    for (const e of entries) {
      const entryIdx = e.startBarIdx + 1;
      if (entryIdx >= candles.length) continue;
      const entryPrice = candles[entryIdx].o;
      const side = e.ob.side === "bullish" ? "long" : "short";
      const stopPrice = e.ob.side === "bullish" ? e.ob.bar_low : e.ob.bar_high;
      const risk = Math.abs(entryPrice - stopPrice);
      if (risk <= 0) continue;
      const targetPrice = side === "long" ? entryPrice + rMultiple * risk : entryPrice - rMultiple * risk;
      let outcome = null;
      const endCheck = Math.min(candles.length - 1, entryIdx + MAX_HOLD_BARS);
      for (let j = entryIdx; j <= endCheck; j++) {
        const bar = candles[j];
        const hitStop = side === "long" ? bar.l <= stopPrice : bar.h >= stopPrice;
        const hitTarget = side === "long" ? bar.h >= targetPrice : bar.l <= targetPrice;
        if (hitStop) { outcome = 0; break; }
        if (hitTarget) { outcome = 1; break; }
      }
      if (outcome == null) continue;
      if (!obOutcomes.has(e.ob.id)) {
        obOutcomes.set(e.ob.id, {
          recurrenceCount: e.ob.recurrence_count,
          attachedSwing: attachSwing.get(e.ob.id) || false,
          attachedInternal: attachInternal.get(e.ob.id) || false,
          wins: [],
        });
      }
      obOutcomes.get(e.ob.id).wins.push(outcome);
    }
  }
  return [...obOutcomes.values()];
}

function groupStats(obs, predicate) {
  const wins = [];
  for (const o of obs) if (predicate(o)) wins.push(...o.wins);
  return { n: wins.length, winRate: winRate(wins) };
}

// Permutation test on the INTERACTION: within the high-recurrence subset, does attachment still
// separate win rate? Shuffle attachment labels at the OB level (not trade level), same discipline as
// every other test in this suite.
function permutationTestInteraction(obsSubset, iterations, seed, field) {
  const realAttached = groupStats(obsSubset, (o) => o[field]).winRate;
  const realUnattached = groupStats(obsSubset, (o) => !o[field]).winRate;
  if (realAttached == null || realUnattached == null) return null;
  const realGap = realAttached - realUnattached;

  const labels = obsSubset.map((o) => o[field]);
  const rng = mulberry32(seed);
  const permGaps = [];
  for (let i = 0; i < iterations; i++) {
    const shuffled = shuffle(labels, rng);
    let winsA = 0, nA = 0, winsB = 0, nB = 0;
    for (let j = 0; j < obsSubset.length; j++) {
      const w = obsSubset[j].wins;
      if (shuffled[j]) { winsA += w.reduce((s, x) => s + x, 0); nA += w.length; }
      else { winsB += w.reduce((s, x) => s + x, 0); nB += w.length; }
    }
    if (nA === 0 || nB === 0) continue;
    permGaps.push(winsA / nA - winsB / nB);
  }
  permGaps.sort((a, b) => a - b);
  const p = permGaps.filter((g) => g >= realGap).length / permGaps.length;
  return { realAttached, realUnattached, realGap, p, n: permGaps.length };
}

async function runForRMultiple(rMultiple) {
  console.log(`\n=== ${rMultiple}R ===`);
  const obs = await buildOutcomes(rMultiple);
  const totalTrades = obs.reduce((s, o) => s + o.wins.length, 0);
  console.log(`${obs.length} order blocks, ${totalTrades} resolved trades.`);

  let maxRecurrence = -Infinity; for (const o of obs) if (o.recurrenceCount > maxRecurrence) maxRecurrence = o.recurrenceCount; // avoid Math.max(...) call-stack limit
  const highRecurrence = (o) => o.recurrenceCount >= 2;
  const lowRecurrence = (o) => o.recurrenceCount === 1;

  const swingCells = {
    lowRec_noAttach: groupStats(obs, (o) => lowRecurrence(o) && !o.attachedSwing),
    lowRec_attach: groupStats(obs, (o) => lowRecurrence(o) && o.attachedSwing),
    highRec_noAttach: groupStats(obs, (o) => highRecurrence(o) && !o.attachedSwing),
    highRec_attach: groupStats(obs, (o) => highRecurrence(o) && o.attachedSwing),
  };
  console.log(`Swing-scope attachment (bar-adjacent, gap<=${MAX_ATTACH_BAR_GAP}), cross-tabulated with recurrence:`);
  for (const [label, c] of Object.entries(swingCells)) {
    console.log(`  ${label.padEnd(18)} n=${String(c.n).padEnd(6)} winRate=${c.winRate != null ? (c.winRate * 100).toFixed(1) + "%" : "n/a"}`);
  }

  const internalCells = {
    lowRec_noAttach: groupStats(obs, (o) => lowRecurrence(o) && !o.attachedInternal),
    lowRec_attach: groupStats(obs, (o) => lowRecurrence(o) && o.attachedInternal),
    highRec_noAttach: groupStats(obs, (o) => highRecurrence(o) && !o.attachedInternal),
    highRec_attach: groupStats(obs, (o) => highRecurrence(o) && o.attachedInternal),
  };
  console.log(`Internal-scope attachment (bar-adjacent, gap<=${MAX_ATTACH_BAR_GAP}), cross-tabulated with recurrence:`);
  for (const [label, c] of Object.entries(internalCells)) {
    console.log(`  ${label.padEnd(18)} n=${String(c.n).padEnd(6)} winRate=${c.winRate != null ? (c.winRate * 100).toFixed(1) + "%" : "n/a"}`);
  }

  const highRecObs = obs.filter(highRecurrence), lowRecObs = obs.filter(lowRecurrence);
  console.log("\nInteraction test, swing-scope attachment, within each recurrence stratum:");
  const highIntSwing = permutationTestInteraction(highRecObs, ITERATIONS, SEED, "attachedSwing");
  const lowIntSwing = permutationTestInteraction(lowRecObs, ITERATIONS, SEED + 1, "attachedSwing");
  if (highIntSwing) console.log(`  high-recurrence: attached=${(highIntSwing.realAttached * 100).toFixed(1)}% unattached=${(highIntSwing.realUnattached * 100).toFixed(1)}% gap=${(highIntSwing.realGap * 100).toFixed(1)}pts p=${highIntSwing.p.toFixed(4)}${highIntSwing.p < 0.05 ? "*" : ""}`);
  if (lowIntSwing) console.log(`  low-recurrence:  attached=${(lowIntSwing.realAttached * 100).toFixed(1)}% unattached=${(lowIntSwing.realUnattached * 100).toFixed(1)}% gap=${(lowIntSwing.realGap * 100).toFixed(1)}pts p=${lowIntSwing.p.toFixed(4)}${lowIntSwing.p < 0.05 ? "*" : ""}`);

  console.log("\nInteraction test, internal-scope attachment, within each recurrence stratum:");
  const highIntInternal = permutationTestInteraction(highRecObs, ITERATIONS, SEED + 2, "attachedInternal");
  const lowIntInternal = permutationTestInteraction(lowRecObs, ITERATIONS, SEED + 3, "attachedInternal");
  if (highIntInternal) console.log(`  high-recurrence: attached=${(highIntInternal.realAttached * 100).toFixed(1)}% unattached=${(highIntInternal.realUnattached * 100).toFixed(1)}% gap=${(highIntInternal.realGap * 100).toFixed(1)}pts p=${highIntInternal.p.toFixed(4)}${highIntInternal.p < 0.05 ? "*" : ""}`);
  if (lowIntInternal) console.log(`  low-recurrence:  attached=${(lowIntInternal.realAttached * 100).toFixed(1)}% unattached=${(lowIntInternal.realUnattached * 100).toFixed(1)}% gap=${(lowIntInternal.realGap * 100).toFixed(1)}pts p=${lowIntInternal.p.toFixed(4)}${lowIntInternal.p < 0.05 ? "*" : ""}`);

  return {
    rMultiple, obCount: obs.length, tradeCount: totalTrades, maxRecurrence,
    cellsSwing: swingCells, cellsInternal: internalCells,
    highRecurrenceInteractionSwing: highIntSwing, lowRecurrenceInteractionSwing: lowIntSwing,
    highRecurrenceInteractionInternal: highIntInternal, lowRecurrenceInteractionInternal: lowIntInternal,
  };
}

async function main() {
  const results = {};
  for (const r of R_MULTIPLES) results[`${r}R`] = await runForRMultiple(r);

  const RESULTS_DIR = new URL("results/", import.meta.url);
  mkdirSync(RESULTS_DIR, { recursive: true });
  const payload = { results, git_commit: gitCommit(), generated_at: new Date().toISOString() };
  const fname = `recurrence_structure_joint_significance_${payload.generated_at.replace(/[:.]/g, "-")}.json`;
  writeFileSync(new URL(fname, RESULTS_DIR), JSON.stringify(payload, null, 2));
  console.log(`\nSaved: ${new URL(fname, RESULTS_DIR).pathname.replace(/^\/([A-Z]:)/, "$1")}`);
}

main().catch((err) => { console.error("Fatal:", err); process.exit(1); });
