#!/usr/bin/env node
// Tests iapaulo's actual causal model, corrected from the earlier (wrong) cross-sectional framing:
// OB attachment to a swing CHoCH/BOS initiates a move (stage 1), continuation happens after as a
// separate stage (stage 2), and stacking/recurrence happens later still as a third stage on top of
// that (stage 3) -- a SEQUENCE, not three competing/independent predictors of the same moment.
// "Controlling for recurrence" while testing attachment (recurrence-structure-joint-significance.js,
// ob-at-below-solid-structure-significance.js) was controlling for a downstream MEDIATOR of
// attachment's own effect, not a confound -- that mechanically erases a real upstream effect. If
// stacking is caused by a clean attachment+continuation, of course the attachment signal "disappears"
// once you hold the thing it causes constant.
//
// This test instead asks the sequential question directly: among order blocks that DID go on to
// stack (recurrence_count >= 2, i.e. something else confluent formed later), was the ORIGINATING
// (earliest-origin_time) order block in that overlap group itself attached to a swing CHoCH/BOS?
// Split stacks into "staged" (originator was attached) vs "unstaged" (originator was not) and
// compare real trade outcomes across ALL order blocks in each kind of stack, against isolated
// (recurrence_count == 1, never stacked at all) as the baseline.
//
// recurrence_count itself is SYMMETRIC (confluence.js: every member of an overlap group counts
// every other overlapping member, `1 + matches`) so it can't distinguish "started the stack" from
// "stacked onto it" on its own -- this recomputes that distinction directly, per timeframe+side
// group, same pairwise overlap test computeRecurrence uses (price range + active window overlap).
//
// Usage: node scripts/signal-bus/smc/staged-attachment-recurrence-significance.js [--iterations=20000] [--r=1,1.5] [--attach-window=60]

import { DatabaseSync } from "node:sqlite";
import { writeFileSync, mkdirSync } from "fs";
import { execSync } from "child_process";
import { loadCandles } from "../../backtest/lib/load-candles.js";

const DB_PATH = new URL("../../../data/signal-bus/smc.db", import.meta.url);
const LADDER_KEYS = ["1w", "1d", "4h", "3h", "2h", "1h", "15m", "5m"];
const BAR_DURATION_SEC = { "1w": 604800, "1d": 86400, "4h": 14400, "3h": 10800, "2h": 7200, "1h": 3600, "15m": 900, "5m": 300 };
const MAX_HOLD_BARS = 200;

const args = Object.fromEntries(process.argv.slice(2).map((a) => a.replace(/^--/, "").split("=")));
const ITERATIONS = parseInt(args.iterations || "20000", 10);
const SEED = parseInt(args.seed || "42", 10);
const R_MULTIPLES = (args.r || "1,1.5").split(",").map(Number);
const ATTACH_WINDOW_BARS = parseInt(args["attach-window"] || "60", 10);

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
function rangesOverlap(aLo, aHi, bLo, bHi) { return aLo <= bHi && bLo <= aHi; }
function windowsOverlap(aLo, aHi, bLo, bHi) { return aLo <= bHi && bLo <= aHi; }

// For each OB with recurrence_count >= 2, find the EARLIEST (by origin_time) OB among itself + its
// direct overlap partners -- that's the stack's originator. Returns Map(ob.id -> originatorId).
function findStackOriginators(obRows) {
  const byGroup = new Map();
  for (const ob of obRows) {
    const key = `${ob.timeframe}|${ob.side}`;
    if (!byGroup.has(key)) byGroup.set(key, []);
    byGroup.get(key).push(ob);
  }
  const originatorOf = new Map();
  for (const group of byGroup.values()) {
    for (const ob of group) {
      if (ob.recurrence_count < 2) { originatorOf.set(ob.id, ob.id); continue; }
      let earliest = ob;
      const obEnd = ob.mitigated_time ?? Infinity;
      for (const other of group) {
        if (other.id === ob.id) continue;
        if (!rangesOverlap(ob.bar_low, ob.bar_high, other.bar_low, other.bar_high)) continue;
        const otherEnd = other.mitigated_time ?? Infinity;
        if (!windowsOverlap(ob.created_time, obEnd, other.created_time, otherEnd)) continue;
        if (other.origin_time < earliest.origin_time) earliest = other;
      }
      originatorOf.set(ob.id, earliest.id);
    }
  }
  return originatorOf;
}

// FIXED per iapaulo: "unstaged" wasn't a clean control -- it just meant "not attached to a SWING
// CHoCH/BOS specifically," which still lets a real catalyst (internal-scope structure) through
// uncounted, diluting any true staged-vs-unstaged difference. Now checks BOTH scopes -- "attached"
// means a real structural catalyst of any granularity, not swing specifically -- so the negative
// control is genuinely "no visible structural catalyst at all," not "catalyst of a different kind."
async function loadAttachment(smcDb, obRows) {
  const byTf = new Map();
  for (const ob of obRows) {
    if (!byTf.has(ob.timeframe)) byTf.set(ob.timeframe, []);
    byTf.get(ob.timeframe).push(ob);
  }
  const attached = new Map();
  for (const [tf, obs] of byTf) {
    const windowSec = ATTACH_WINDOW_BARS * BAR_DURATION_SEC[tf];
    for (const side of ["bullish", "bearish"]) {
      const structSide = side === "bullish" ? "bearish" : "bullish";
      const structureEvents = smcDb.prepare(
        "SELECT time, price FROM structure_events WHERE timeframe = ? AND scope IN ('swing','internal') AND side = ? AND type IN ('CHOCH','BOS')",
      ).all(tf, structSide);
      for (const ob of obs.filter((o) => o.side === side)) {
        const qualifies = structureEvents.some((s) => {
          if (Math.abs(s.time - ob.origin_time) > windowSec) return false;
          return side === "bullish" ? ob.bar_high <= s.price : ob.bar_low >= s.price;
        });
        attached.set(ob.id, qualifies);
      }
    }
  }
  return attached;
}

async function buildOutcomes(rMultiple, candlesByTf, classification) {
  const db = new DatabaseSync(DB_PATH, { readOnly: true });
  const touchRows = db.prepare("SELECT order_block_id, start_bar_idx FROM order_block_touches").all();
  const obRows = db.prepare("SELECT id, timeframe, side, bar_high, bar_low FROM order_blocks").all();
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
    const candles = candlesByTf[tf];
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
      if (!obOutcomes.has(e.ob.id)) obOutcomes.set(e.ob.id, { classification: classification.get(e.ob.id), wins: [] });
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
function permutationTest(obsSubset, iterations, seed, predicateA) {
  const realA = groupStats(obsSubset, predicateA).winRate;
  const realB = groupStats(obsSubset, (o) => !predicateA(o)).winRate;
  if (realA == null || realB == null) return null;
  const realGap = realA - realB;
  const labels = obsSubset.map(predicateA);
  const rng = mulberry32(seed);
  const permGaps = [];
  for (let i = 0; i < iterations; i++) {
    const shuffled = shuffle(labels, rng);
    let winsX = 0, nX = 0, winsY = 0, nY = 0;
    for (let j = 0; j < obsSubset.length; j++) {
      const w = obsSubset[j].wins;
      if (shuffled[j]) { winsX += w.reduce((s, x) => s + x, 0); nX += w.length; }
      else { winsY += w.reduce((s, x) => s + x, 0); nY += w.length; }
    }
    if (nX === 0 || nY === 0) continue;
    permGaps.push(winsX / nX - winsY / nY);
  }
  permGaps.sort((a, b) => a - b);
  const p = permGaps.filter((g) => g >= realGap).length / permGaps.length;
  return { realA, realB, realGap, p };
}

async function runForRMultiple(rMultiple, candlesByTf, classification) {
  console.log(`\n=== ${rMultiple}R ===`);
  const obs = await buildOutcomes(rMultiple, candlesByTf, classification);
  const totalTrades = obs.reduce((s, o) => s + o.wins.length, 0);
  const counts = { staged: 0, unstaged: 0, isolated: 0 };
  for (const o of obs) counts[o.classification]++;
  console.log(`${obs.length} order blocks (staged=${counts.staged}, unstaged=${counts.unstaged}, isolated=${counts.isolated}), ${totalTrades} resolved trades.`);

  const stagedStats = groupStats(obs, (o) => o.classification === "staged");
  const unstagedStats = groupStats(obs, (o) => o.classification === "unstaged");
  const isolatedStats = groupStats(obs, (o) => o.classification === "isolated");
  console.log(`  staged (originator attached to a real CHoCH/BOS, any scope): n=${stagedStats.n}, winRate=${stagedStats.winRate != null ? (stagedStats.winRate * 100).toFixed(1) + "%" : "n/a"}`);
  console.log(`  unstaged (originator attached to NO structure event at all): n=${unstagedStats.n}, winRate=${unstagedStats.winRate != null ? (unstagedStats.winRate * 100).toFixed(1) + "%" : "n/a"}`);
  console.log(`  isolated (never stacked, recurrence=1):                      n=${isolatedStats.n}, winRate=${isolatedStats.winRate != null ? (isolatedStats.winRate * 100).toFixed(1) + "%" : "n/a"}`);

  const vsUnstaged = permutationTest(obs.filter((o) => o.classification !== "isolated"), ITERATIONS, SEED, (o) => o.classification === "staged");
  const vsIsolated = permutationTest(obs.filter((o) => o.classification !== "unstaged"), ITERATIONS, SEED + 1, (o) => o.classification === "staged");
  if (vsUnstaged) console.log(`\n  staged vs unstaged: gap=${(vsUnstaged.realGap * 100).toFixed(1)}pts p=${vsUnstaged.p.toFixed(4)}${vsUnstaged.p < 0.05 ? "*" : ""}`);
  if (vsIsolated) console.log(`  staged vs isolated:  gap=${(vsIsolated.realGap * 100).toFixed(1)}pts p=${vsIsolated.p.toFixed(4)}${vsIsolated.p < 0.05 ? "*" : ""}`);

  return { rMultiple, obCount: obs.length, tradeCount: totalTrades, counts, stagedStats, unstagedStats, isolatedStats, vsUnstaged, vsIsolated };
}

async function main() {
  const smcDb = new DatabaseSync(DB_PATH, { readOnly: true });
  const candlesByTf = {};
  for (const tf of LADDER_KEYS) candlesByTf[tf] = await loadCandles(tf);

  const obRows = smcDb.prepare(
    "SELECT id, timeframe, side, bar_high, bar_low, origin_time, created_time, mitigated_time, recurrence_count FROM order_blocks",
  ).all();
  console.log(`Finding stack originators across ${obRows.length} order blocks...`);
  const originatorOf = findStackOriginators(obRows);

  console.log(`Checking swing CHoCH/BOS attachment for originators (window=${ATTACH_WINDOW_BARS} bars)...`);
  const originatorIds = new Set(originatorOf.values());
  const originatorRows = obRows.filter((o) => originatorIds.has(o.id));
  const attachedOriginators = await loadAttachment(smcDb, originatorRows);
  smcDb.close();

  const classification = new Map();
  for (const ob of obRows) {
    if (ob.recurrence_count < 2) { classification.set(ob.id, "isolated"); continue; }
    const originatorId = originatorOf.get(ob.id);
    const isAttached = attachedOriginators.get(originatorId) || false;
    classification.set(ob.id, isAttached ? "staged" : "unstaged");
  }
  const summary = { staged: 0, unstaged: 0, isolated: 0 };
  for (const v of classification.values()) summary[v]++;
  console.log(`Classification: staged=${summary.staged}, unstaged=${summary.unstaged}, isolated=${summary.isolated}`);

  const results = {};
  for (const r of R_MULTIPLES) results[`${r}R`] = await runForRMultiple(r, candlesByTf, classification);

  const RESULTS_DIR = new URL("results/", import.meta.url);
  mkdirSync(RESULTS_DIR, { recursive: true });
  const payload = { results, attachWindowBars: ATTACH_WINDOW_BARS, git_commit: gitCommit(), generated_at: new Date().toISOString() };
  const fname = `staged_attachment_recurrence_significance_${payload.generated_at.replace(/[:.]/g, "-")}.json`;
  writeFileSync(new URL(fname, RESULTS_DIR), JSON.stringify(payload, null, 2));
  console.log(`\nSaved: ${new URL(fname, RESULTS_DIR).pathname.replace(/^\/([A-Z]:)/, "$1")}`);
}

main().catch((err) => { console.error("Fatal:", err); process.exit(1); });
