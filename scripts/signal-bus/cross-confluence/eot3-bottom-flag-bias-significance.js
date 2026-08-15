#!/usr/bin/env node
// Direct follow-up to #66: iapaulo's refinement is that a "mildly bullish" q5 bottom (no
// accompanying flag) occurring DURING an already-established bearish move should be more likely to
// fail than the pooled/unconditional read suggests -- and that if this is a real mechanical
// property (not a fluke), it should hold the same way on every timeframe, since Boom Hunter's own
// EOT3 formula (K13=0.9999, LPPeriod3=11) is identical across the ladder. #66 already ran the full
// ladder for the flag/no-flag split alone; this adds SMC's own prevailing trend bias as a third
// stratifying dimension, at the exact bar the episode starts -- same `biasAt()` binary-search
// pattern already established in vmc-cipher-b/divergence-smc-bias-stacking.js (#50), swing scope
// (that file's own finding: swing is the cleaner-performing scope for this kind of stacking check).
//
// Reuses #66's exact episode definition (q5 crosses down through 50 -> next crossover back above,
// or excluded if still ongoing) and flag definition (any Long-tier flag firing anywhere during the
// episode) -- now read from `boom-hunter.db`'s persisted `eot3_episodes` table rather than
// recomputed here, same as #66's own migration. Adds: SMC swing-scope bias (bullish/bearish) at the
// episode's start bar, same timeframe. Reports the 2x2 (flag x bias) forward-return breakdown,
// pooled and per-timeframe.
//
// Usage: node scripts/signal-bus/cross-confluence/eot3-bottom-flag-bias-significance.js [--iterations=20000] [--horizons=5,10,20,40]

import { DatabaseSync } from "node:sqlite";
import { writeFileSync, mkdirSync } from "fs";
import { execSync } from "child_process";
import { loadCandles } from "../../backtest/lib/load-candles.js";

const SMC_DB_PATH = new URL("../../../data/signal-bus/smc.db", import.meta.url);
const BOOM_DB_PATH = new URL("../../../data/signal-bus/boom-hunter.db", import.meta.url);
const LADDER_KEYS = ["1w", "1d", "4h", "3h", "2h", "1h", "15m", "5m"];

const args = Object.fromEntries(process.argv.slice(2).map((a) => a.replace(/^--/, "").split("=")));
const ITERATIONS = parseInt(args.iterations || "20000", 10);
const SEED = parseInt(args.seed || "42", 10);
const HORIZONS = (args.horizons || "5,10,20,40").split(",").map(Number);

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
function mean(v) { return v.length ? v.reduce((s, x) => s + x, 0) / v.length : null; }
function forwardReturn(candles, barIdx, horizon) {
  const endIdx = Math.min(candles.length - 1, barIdx + horizon);
  if (endIdx <= barIdx) return null;
  return candles[endIdx].c / candles[barIdx].c - 1;
}
// Same binary-search bias lookup as vmc-cipher-b/divergence-smc-bias-stacking.js (#50).
function biasAt(events, t) {
  if (!events || events.length === 0) return null;
  let lo = 0, hi = events.length - 1, ans = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (events[mid].time <= t) { ans = mid; lo = mid + 1; } else { hi = mid - 1; }
  }
  return ans === -1 ? null : events[ans].side;
}

function permutationTestMeans(groupALabels, values, iterations, seed) {
  const n = values.length;
  const realA = mean(values.filter((_, i) => groupALabels[i]));
  const realB = mean(values.filter((_, i) => !groupALabels[i]));
  if (realA == null || realB == null) return null;
  const realGap = realA - realB;
  const rng = mulberry32(seed);
  const permGaps = [];
  for (let i = 0; i < iterations; i++) {
    const shuffled = shuffle(groupALabels, rng);
    const a = [], b = [];
    for (let j = 0; j < n; j++) (shuffled[j] ? a : b).push(values[j]);
    if (a.length === 0 || b.length === 0) continue;
    permGaps.push(mean(a) - mean(b));
  }
  permGaps.sort((x, y) => x - y);
  const p = permGaps.filter((g) => g >= realGap).length / permGaps.length;
  return { realA, realB, realGap, p, nA: values.filter((_, i) => groupALabels[i]).length, nB: values.filter((_, i) => !groupALabels[i]).length };
}
function fmtPct(x) { return x != null ? (x * 100).toFixed(2) + "%" : "n/a"; }
function fmtGap(t) { return t ? `gap=${(t.realGap * 100).toFixed(2)}pts p=${t.p.toFixed(4)}${t.p < 0.05 ? "* (A>B)" : t.p > 0.95 ? "* (A<B, reversed)" : ""}` : "n/a"; }

async function collectEpisodes(tf) {
  const candles = await loadCandles(tf);

  const boomDb = new DatabaseSync(BOOM_DB_PATH, { readOnly: true });
  const rows = boomDb.prepare("SELECT start_bar_idx, end_bar_idx, start_time, has_flag FROM eot3_episodes WHERE timeframe = ?").all(tf);
  boomDb.close();

  const smcDb = new DatabaseSync(SMC_DB_PATH, { readOnly: true });
  const structureEvents = smcDb.prepare(
    "SELECT time, side FROM structure_events WHERE timeframe = ? AND scope = 'swing' ORDER BY time ASC",
  ).all(tf);
  smcDb.close();

  const episodes = rows.map((r) => ({
    barIdx: r.start_bar_idx,
    endIdx: r.end_bar_idx,
    hasFlag: !!r.has_flag,
    bias: biasAt(structureEvents, r.start_time), // SMC bias AT episode start, same timeframe
  }));
  return { candles, episodes };
}

function reportCell(label, candles, episodes, horizon) {
  const values = [], labels = [];
  for (const e of episodes) {
    const r = forwardReturn(candles, e.barIdx, horizon);
    if (r == null) continue;
    values.push(r); labels.push(e.hasFlag);
  }
  if (values.length === 0) { console.log(`    ${label} n=0`); return null; }
  const test = permutationTestMeans(labels, values, ITERATIONS, SEED + horizon);
  const withVals = values.filter((_, i) => labels[i]), withoutVals = values.filter((_, i) => !labels[i]);
  console.log(
    `    ${label} N=${horizon}: with-flag n=${withVals.length} meanRet=${fmtPct(mean(withVals))} upFrac=${fmtPct(withVals.length ? withVals.filter((r) => r > 0).length / withVals.length : null)}` +
    `  |  no-flag n=${withoutVals.length} meanRet=${fmtPct(mean(withoutVals))} upFrac=${fmtPct(withoutVals.length ? withoutVals.filter((r) => r > 0).length / withoutVals.length : null)}` +
    `  |  ${fmtGap(test)}`,
  );
  return test;
}

async function main() {
  console.log(`EOT3 q5 down-episode, flag-vs-no-flag, stratified by SMC swing bias at the episode's start (iapaulo's refinement: does trend context matter, and is it universal across the ladder?).\n`);

  const perTf = {};
  const byTfData = {};

  for (const tf of LADDER_KEYS) {
    const { candles, episodes } = await collectEpisodes(tf);
    byTfData[tf] = { candles, episodes };
    const bearish = episodes.filter((e) => e.bias === "bearish");
    const bullish = episodes.filter((e) => e.bias === "bullish");
    const noBias = episodes.filter((e) => e.bias == null);
    console.log(`=== ${tf} === ${episodes.length} episodes (${bearish.length} during bearish SMC bias, ${bullish.length} during bullish, ${noBias.length} no bias data)`);
    const tfResults = {};
    for (const [biasLabel, subset] of [["bearish-bias", bearish], ["bullish-bias", bullish]]) {
      for (const h of HORIZONS) {
        const t = reportCell(`[${biasLabel}]`, candles, subset, h);
        tfResults[`${biasLabel}_${h}`] = t;
      }
    }
    perTf[tf] = tfResults;
    console.log();
  }

  console.log(`=== POOLED (all timeframes) ===`);
  const pooledResults = {};
  for (const [biasLabel, biasValue] of [["bearish-bias", "bearish"], ["bullish-bias", "bullish"]]) {
    for (const h of HORIZONS) {
      const values = [], labels = [];
      for (const tf of LADDER_KEYS) {
        const { candles, episodes } = byTfData[tf];
        for (const e of episodes.filter((e2) => e2.bias === biasValue)) {
          const r = forwardReturn(candles, e.barIdx, h);
          if (r == null) continue;
          values.push(r); labels.push(e.hasFlag);
        }
      }
      if (values.length === 0) { console.log(`  [${biasLabel}] N=${h}: n=0`); continue; }
      const test = permutationTestMeans(labels, values, ITERATIONS, SEED + 500 + h);
      const withVals = values.filter((_, i) => labels[i]), withoutVals = values.filter((_, i) => !labels[i]);
      console.log(
        `  [${biasLabel}] N=${h}: with-flag n=${withVals.length} meanRet=${fmtPct(mean(withVals))} upFrac=${fmtPct(withVals.length ? withVals.filter((r) => r > 0).length / withVals.length : null)}` +
        `  |  no-flag n=${withoutVals.length} meanRet=${fmtPct(mean(withoutVals))} upFrac=${fmtPct(withoutVals.length ? withoutVals.filter((r) => r > 0).length / withoutVals.length : null)}` +
        `  |  ${fmtGap(test)}`,
      );
      pooledResults[`${biasLabel}_${h}`] = test;
    }
  }
  perTf.POOLED = pooledResults;

  const RESULTS_DIR = new URL("results/", import.meta.url);
  mkdirSync(RESULTS_DIR, { recursive: true });
  const payload = { perTf, horizons: HORIZONS, git_commit: gitCommit(), generated_at: new Date().toISOString() };
  const fname = `eot3_bottom_flag_bias_significance_${payload.generated_at.replace(/[:.]/g, "-")}.json`;
  writeFileSync(new URL(fname, RESULTS_DIR), JSON.stringify(payload, null, 2));
  console.log(`Saved: ${new URL(fname, RESULTS_DIR).pathname.replace(/^\/([A-Z]:)/, "$1")}`);
}

main().catch((err) => { console.error("Fatal:", err); process.exit(1); });
