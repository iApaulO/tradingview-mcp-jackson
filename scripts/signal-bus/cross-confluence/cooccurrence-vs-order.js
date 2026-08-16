#!/usr/bin/env node
// CO-OCCURRENCE vs ORDER -- separating two things #136 conflated, and running the cascade-vs-single
// test that #136 left descriptive.
//
// THE DISTINCTION (iapaulo, 2026-08-16). There are THREE objects here, not two:
//   1. top-down cascade  -- ordered, coarse leads fine. Claims HTF anticipates LTF.
//   2. bottom-up cascade -- ordered, fine leads coarse. Frequently mechanical.
//   3. CO-OCCURRENCE     -- N rungs agree within a window, ORDER IRRELEVANT.
//
// #136 tested 1 against 2, found them indistinguishable, and INFERRED that 3 is what carries the
// signal. That inference was never measured. Co-occurrence is a strictly LARGER set than
// (top-down union bottom-up): the cascade detector in #135 requires strict time ordering, so
// scrambled sequences (4h, then 1d, then 1h) and same-timestamp events fall through BOTH detectors
// and appear in neither population. Whatever their predictive value is, no test has seen it.
//
// This script builds co-occurrence CLUSTERS directly -- unordered by construction -- and then
// labels each cluster's internal order after the fact. That factorisation is what lets the two
// questions be asked separately on one population:
//
//   Q1 SIZE EFFECT (the cascade-vs-single test #136 owed): does cluster size K predict? K=1 is a
//      lone structure event, which is exactly the baseline #136 compared against descriptively
//      with no null. Tested here properly, and RUNG-STRATIFIED -- pooling across rungs would
//      confound cluster size with rung mix, since clusters concentrate at particular rungs and
//      #136 already showed per-rung baselines differ by up to 17x between instruments.
//
//   Q2 ORDER EFFECT: within clusters of the same size K, does the internal ORDER matter? Labels
//      are 'top_down' (strictly coarse->fine), 'bottom_up' (strictly fine->coarse), or 'mixed'
//      (neither -- the population no prior test could see). If order is genuinely uninformative
//      then the three labels should be indistinguishable at fixed K, AND the mixed group should
//      perform like the others rather than like noise.
//
// If Q1 is significant and Q2 is null, the conclusion is that agreement across scales matters and
// sequence does not -- which would make the ordered-cascade encoding of #135 a needless restriction
// that discards sample for nothing.
//
// available_at: a cluster is keyed at the time of its LAST member, since it is not observable until
// then. Outcome is measured on the FINEST rung present, over N bars of that rung (scale-matched).
//
// Usage: node scripts/signal-bus/cross-confluence/cooccurrence-vs-order.js
//        [--mult=1] [--horizon=20] [--iterations=20000]

import { DatabaseSync } from "node:sqlite";
import { writeFileSync, mkdirSync } from "fs";
import { loadCandles } from "../../backtest/lib/load-candles.js";

const args = Object.fromEntries(process.argv.slice(2).filter((a) => a.includes("=")).map((a) => a.replace(/^--/, "").split("=")));
const MULT = Number(args.mult || "1");
const HORIZON = parseInt(args.horizon || "20", 10);
const ITER = parseInt(args.iterations || "20000", 10);
const SEED = parseInt(args.seed || "42", 10);

const LADDER = [
  { tf: "1w", sec: 604800 }, { tf: "1d", sec: 86400 }, { tf: "4h", sec: 14400 }, { tf: "3h", sec: 10800 },
  { tf: "2h", sec: 7200 }, { tf: "1h", sec: 3600 }, { tf: "15m", sec: 900 }, { tf: "5m", sec: 300 },
];
const IDX = new Map(LADDER.map((l, i) => [l.tf, i]));
const smcDb = (inst) => new URL(`../../../data/signal-bus/${inst === "BTC" ? "smc.db" : "smc-eth.db"}`, import.meta.url);

function mulberry32(seed) {
  let a = seed >>> 0;
  return function () { a |= 0; a = (a + 0x6d2b79f5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
const mean = (xs) => (xs.length ? xs.reduce((s, x) => s + x, 0) / xs.length : null);

// Unordered clustering. Events are swept in time order; a cluster absorbs later same-direction
// events from rungs it does not already contain, while they fall inside a window scaled to the
// COARSEST rung present so far. The window can only grow as coarser rungs join -- matching #135's
// symmetric 'coarser' rule, which is the only scaling that does not bias one travel direction.
function buildClusters(eventsByRung, mult) {
  const all = [];
  for (const { tf } of LADDER) for (const e of eventsByRung.get(tf) || []) all.push({ ...e, rung: tf, rungIdx: IDX.get(tf) });
  all.sort((a, b) => a.time - b.time);

  const clusters = [];
  const used = new Array(all.length).fill(false);
  for (let i = 0; i < all.length; i++) {
    if (used[i]) continue;
    const seed = all[i];
    const members = [seed];
    const rungs = new Set([seed.rung]);
    let windowSec = mult * LADDER[seed.rungIdx].sec;
    used[i] = true;
    for (let j = i + 1; j < all.length; j++) {
      if (used[j]) continue;
      const cand = all[j];
      if (cand.time - seed.time > windowSec) break; // time-sorted, so nothing later can qualify
      if (cand.direction !== seed.direction) continue;
      if (rungs.has(cand.rung)) continue; // one event per rung per cluster
      members.push(cand);
      rungs.add(cand.rung);
      used[j] = true;
      // A coarser rung joining widens the window; it never narrows.
      windowSec = Math.max(windowSec, mult * LADDER[cand.rungIdx].sec);
    }
    // Order label, computed AFTER clustering so the clustering itself is order-blind.
    const byTime = [...members].sort((a, b) => a.time - b.time);
    let strictDown = true, strictUp = true;
    for (let k = 1; k < byTime.length; k++) {
      if (byTime[k].rungIdx <= byTime[k - 1].rungIdx) strictDown = false;
      if (byTime[k].rungIdx >= byTime[k - 1].rungIdx) strictUp = false;
    }
    const order = members.length === 1 ? "single" : strictDown ? "top_down" : strictUp ? "bottom_up" : "mixed";
    const finest = members.reduce((a, b) => (b.rungIdx > a.rungIdx ? b : a));
    clusters.push({
      K: members.length,
      order,
      direction: seed.direction,
      // Not observable until the last member fires.
      knownAtTime: Math.max(...members.map((m) => m.time)),
      outcomeRung: finest.rung,
    });
  }
  return clusters;
}

async function attachOutcomes(clusters, instrument) {
  const byRung = new Map();
  for (const c of clusters) {
    if (!byRung.has(c.outcomeRung)) byRung.set(c.outcomeRung, []);
    byRung.get(c.outcomeRung).push(c);
  }
  const series = new Map();
  for (const [rung, list] of byRung) {
    const candles = await loadCandles(rung, instrument);
    const times = candles.map((x) => x.t), closes = candles.map((x) => x.c);
    series.set(rung, closes);
    for (const c of list) {
      let lo = 0, hi = times.length - 1, idx = -1;
      while (lo <= hi) { const m = (lo + hi) >> 1; if (times[m] > c.knownAtTime) { idx = m; hi = m - 1; } else lo = m + 1; }
      if (idx < 0 || idx + HORIZON >= closes.length) { c.signed = null; continue; }
      const raw = (closes[idx + HORIZON] - closes[idx]) / closes[idx];
      c.signed = c.direction === "bullish" ? raw : -raw;
      c.entryIdx = idx;
    }
  }
  return { clusters: clusters.filter((c) => c.signed != null), series };
}

// Rung-stratified gap between two labelled groups, with a label-permutation null computed WITHIN
// each rung so the test can never be won by rung mix alone.
function stratifiedGap(groupA, groupB, rng, iterations) {
  const rungs = new Set([...groupA, ...groupB].map((c) => c.outcomeRung));
  let wSum = 0, gapSum = 0;
  const perRung = [];
  for (const r of rungs) {
    const a = groupA.filter((c) => c.outcomeRung === r).map((c) => c.signed);
    const b = groupB.filter((c) => c.outcomeRung === r).map((c) => c.signed);
    if (a.length < 10 || b.length < 10) continue;
    const w = a.length + b.length;
    perRung.push({ rung: r, nA: a.length, nB: b.length, mA: mean(a), mB: mean(b), gap: mean(a) - mean(b) });
    gapSum += w * (mean(a) - mean(b));
    wSum += w;
  }
  if (!wSum) return null;
  const realGap = gapSum / wSum;

  let geq = 0;
  for (let it = 0; it < iterations; it++) {
    let gs = 0, ws = 0;
    for (const r of rungs) {
      const pool = [...groupA.filter((c) => c.outcomeRung === r), ...groupB.filter((c) => c.outcomeRung === r)].map((c) => c.signed);
      const nA = groupA.filter((c) => c.outcomeRung === r).length;
      if (nA < 10 || pool.length - nA < 10) continue;
      // shuffle within this rung only
      for (let i = pool.length - 1; i > 0; i--) { const j = Math.floor(rng() * (i + 1)); [pool[i], pool[j]] = [pool[j], pool[i]]; }
      const mA = mean(pool.slice(0, nA)), mB = mean(pool.slice(nA));
      gs += pool.length * (mA - mB); ws += pool.length;
    }
    if (ws && gs / ws >= realGap) geq++;
  }
  return { realGap, p: geq / iterations, perRung };
}

async function runInstrument(inst, out, rng) {
  const db = new DatabaseSync(smcDb(inst), { readOnly: true });
  const ev = new Map();
  for (const { tf } of LADDER) {
    ev.set(tf, db.prepare("SELECT time, side AS direction, price FROM structure_events WHERE timeframe = ? AND scope = 'swing' ORDER BY time").all(tf));
  }
  db.close();

  const raw = buildClusters(ev, MULT);
  const { clusters } = await attachOutcomes(raw, inst);

  console.log(`\n${"#".repeat(96)}`);
  console.log(`## ${inst} -- ${clusters.length.toLocaleString()} co-occurrence clusters with resolvable outcomes (mult=${MULT})`);
  console.log(`${"#".repeat(96)}`);

  const byK = (k) => clusters.filter((c) => (k === "3+" ? c.K >= 3 : c.K === k));
  console.log(`\nQ1 -- SIZE EFFECT (cluster size K; K=1 is a lone structure event)`);
  console.log(`  K       n        mean signed    win%`);
  for (const k of [1, 2, "3+"]) {
    const g = byK(k);
    if (!g.length) continue;
    console.log(`  ${String(k).padEnd(7)} ${String(g.length).padStart(7)}  ${(mean(g.map((c) => c.signed)) * 100).toFixed(4).padStart(11)}%  ${((g.filter((c) => c.signed > 0).length / g.length) * 100).toFixed(1).padStart(5)}%`);
  }
  const sizeTest = stratifiedGap(clusters.filter((c) => c.K >= 2), byK(1), rng, ITER);
  if (sizeTest) {
    console.log(`  K>=2 minus K=1, RUNG-STRATIFIED: gap=${(sizeTest.realGap * 100).toFixed(4)}pp  p=${sizeTest.p.toFixed(4)}${sizeTest.p < 0.05 ? "*" : ""}`);
    for (const r of sizeTest.perRung) console.log(`     ${r.rung.padEnd(4)} nK>=2=${String(r.nA).padStart(4)} ${(r.mA * 100).toFixed(4)}%  nK=1=${String(r.nB).padStart(5)} ${(r.mB * 100).toFixed(4)}%  gap=${(r.gap * 100).toFixed(4)}pp`);
  }

  console.log(`\nQ2 -- ORDER EFFECT (within K>=2 only; 'mixed' is the population no prior test could see)`);
  console.log(`  order        n        mean signed    win%`);
  const multi = clusters.filter((c) => c.K >= 2);
  for (const o of ["top_down", "bottom_up", "mixed"]) {
    const g = multi.filter((c) => c.order === o);
    if (!g.length) continue;
    console.log(`  ${o.padEnd(12)} ${String(g.length).padStart(7)}  ${(mean(g.map((c) => c.signed)) * 100).toFixed(4).padStart(11)}%  ${((g.filter((c) => c.signed > 0).length / g.length) * 100).toFixed(1).padStart(5)}%`);
  }
  const orderTest = stratifiedGap(multi.filter((c) => c.order === "top_down"), multi.filter((c) => c.order !== "top_down"), rng, ITER);
  if (orderTest) console.log(`  top_down minus (bottom_up+mixed), RUNG-STRATIFIED: gap=${(orderTest.realGap * 100).toFixed(4)}pp  p=${orderTest.p.toFixed(4)}${orderTest.p < 0.05 ? "*" : ""}`);

  out[inst] = {
    n: clusters.length,
    size: [1, 2, "3+"].map((k) => { const g = byK(k); return { K: k, n: g.length, mean_pct: g.length ? mean(g.map((c) => c.signed)) * 100 : null }; }),
    size_test: sizeTest ? { gap_pp: sizeTest.realGap * 100, p: sizeTest.p, per_rung: sizeTest.perRung } : null,
    order: ["top_down", "bottom_up", "mixed"].map((o) => { const g = multi.filter((c) => c.order === o); return { order: o, n: g.length, mean_pct: g.length ? mean(g.map((c) => c.signed)) * 100 : null }; }),
    order_test: orderTest ? { gap_pp: orderTest.realGap * 100, p: orderTest.p } : null,
  };
}

async function main() {
  const rng = mulberry32(SEED);
  const out = {};
  console.log(`CO-OCCURRENCE vs ORDER -- SMC structure events, window mult=${MULT}, horizon=${HORIZON} bars of the finest rung`);
  console.log(`Q1 answers the cascade-vs-single test #136 left descriptive. Q2 asks whether ORDER adds anything at fixed size.`);
  for (const inst of ["BTC", "ETH"]) await runInstrument(inst, out, rng);

  const RESULTS_DIR = new URL("results/", import.meta.url);
  mkdirSync(RESULTS_DIR, { recursive: true });
  const fname = `cooccurrence_vs_order_${new Date().toISOString().replace(/[:.]/g, "-")}.json`;
  writeFileSync(new URL(fname, RESULTS_DIR), JSON.stringify({ generated_at: new Date().toISOString(), mult: MULT, horizon: HORIZON, iterations: ITER, seed: SEED, results: out }, null, 2));
  console.log(`\nSaved: ${new URL(fname, RESULTS_DIR).pathname.replace(/^\/([A-Z]:)/, "$1")}`);
}

main().catch((err) => { console.error("Fatal:", err); process.exit(1); });
