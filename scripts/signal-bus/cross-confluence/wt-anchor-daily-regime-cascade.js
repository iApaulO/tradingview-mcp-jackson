#!/usr/bin/env node
// Cascade / regime-alignment check on the 15m WT-anchor construction (#108/#109 baseline and
// #110's q5+D4M refinement), per iapaulo's direct ask: "how many times does the 15m play out same
// bullish inside a bullish daily or bear inside bear... do we lose this regime requirement."
//
// "Daily regime" = the side of the most recently confirmed DAILY WT extreme-fractal anchor
// (computeWtExtremeFractals on 1d candles -- the SAME anchor concept already validated as
// Strategy F on 1d, #106/#107, p=0.0000). A daily anchor's side persists as "the regime" from its
// own bar's time until the next OPPOSITE-side daily anchor supersedes it -- exactly matching
// iapaulo's "daily d4m is the regime, when that prints, thats the direction its going" description
// (2026-08-11), just built on the anchor construction rather than the D4M zone construction, since
// the anchor is what's already been validated end-to-end on 1d.
//
// For every 15m entry (side, entryTime), look up which daily regime was active at that moment
// (last daily anchor with anchorTime <= entryTime) and bucket into ALIGNED (15m side == daily
// regime side) vs MISALIGNED (opposite). Reports count, win rate, PF, costed expectancy per bucket,
// for both the #108/#109 baseline population and the #110 q5+D4M-refined population.
//
// Usage: node scripts/signal-bus/cross-confluence/wt-anchor-daily-regime-cascade.js

import { DatabaseSync } from "node:sqlite";
import { loadCandles } from "../../backtest/lib/load-candles.js";
import { computeMetrics } from "../../backtest/lib/metrics.js";
import { applyCosts, FEE_TIERS, REPRESENTATIVE_FUNDING_PCT_PER_HOUR } from "../../backtest/lib/costs.js";
import { computeWtExtremeFractals } from "../vmc-cipher-b/calc.js";
import { computeBoomHunter } from "../boom-hunter/calc.js";

const SMC_DB_PATH = new URL("../../../data/signal-bus/smc.db", import.meta.url);
const D4M_DB_PATH = new URL("../../../data/signal-bus/divergence-for-many.db", import.meta.url);
const TF = "15m";
const ATR_LEN = 14, ATR_MULT = 0.6, MAX_HOLD_BARS = 200;
const D4M_TOL_PCT = 0.012;

function atr(candles, length) {
  const tr = candles.map((c, i) => {
    if (i === 0) return c.h - c.l;
    const pc = candles[i - 1].c;
    return Math.max(c.h - c.l, Math.abs(c.h - pc), Math.abs(c.l - pc));
  });
  const out = new Array(candles.length).fill(NaN);
  if (candles.length < length) return out;
  let seed = 0;
  for (let i = 0; i < length; i++) seed += tr[i];
  out[length - 1] = seed / length;
  for (let i = length; i < candles.length; i++) out[i] = (out[i - 1] * (length - 1) + tr[i]) / length;
  return out;
}
function expectancy(trades) { return trades.length ? trades.reduce((s, t) => s + t.pnlPct, 0) / trades.length : null; }
function mulberry32(seed) {
  let a = seed >>> 0;
  return function () { a |= 0; a = (a + 0x6d2b79f5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

async function main() {
  const confirmedParams = { takerFeePct: FEE_TIERS.bitunix_futures_vip1.takerFeePct, fundingPctPerHour: REPRESENTATIVE_FUNDING_PCT_PER_HOUR };
  const smcDb = new DatabaseSync(SMC_DB_PATH, { readOnly: true });
  const d4mDb = new DatabaseSync(D4M_DB_PATH, { readOnly: true });

  // -- Daily regime timeline --
  const dailyCandles = await loadCandles("1d");
  const { events: dailyAnchors } = computeWtExtremeFractals(dailyCandles);
  const regimeTimeline = dailyAnchors
    .map((a) => ({ time: dailyCandles[a.barIdx].t, side: a.side }))
    .sort((a, b) => a.time - b.time);
  console.log(`Daily regime timeline: ${regimeTimeline.length} anchors, ${new Date(dailyCandles[0].t * 1000).toISOString().slice(0, 10)} -> ${new Date(dailyCandles[dailyCandles.length - 1].t * 1000).toISOString().slice(0, 10)}`);
  // episode length stats (t is unix SECONDS, per load-candles.js)
  const episodeLengthsDays = [];
  for (let i = 1; i < regimeTimeline.length; i++) episodeLengthsDays.push((regimeTimeline[i].time - regimeTimeline[i - 1].time) / 86400);
  if (episodeLengthsDays.length) {
    const mean = episodeLengthsDays.reduce((s, x) => s + x, 0) / episodeLengthsDays.length;
    const sorted = [...episodeLengthsDays].sort((a, b) => a - b);
    console.log(`Regime episode length: mean=${mean.toFixed(1)}d, median=${sorted[Math.floor(sorted.length / 2)].toFixed(1)}d, min=${sorted[0].toFixed(1)}d, max=${sorted[sorted.length - 1].toFixed(1)}d`);
  }

  function regimeAt(time) {
    let side = null;
    for (const r of regimeTimeline) { if (r.time > time) break; side = r.side; }
    return side;
  }

  // -- 15m population (baseline #108/#109 + #110 refined) --
  const candles = await loadCandles(TF);
  const atr14 = atr(candles, ATR_LEN);
  const { events: anchors } = computeWtExtremeFractals(candles);
  const { series } = computeBoomHunter(candles);
  const q5 = series.q5;

  const obRows = smcDb.prepare("SELECT side, bar_high, bar_low, created_bar_idx, origin_bar_idx FROM order_blocks WHERE timeframe = ? AND scope = ?").all(TF, "swing");
  const swingObsBySide = {
    bullish: obRows.filter((o) => o.side === "bullish").sort((a, b) => a.origin_bar_idx - b.origin_bar_idx),
    bearish: obRows.filter((o) => o.side === "bearish").sort((a, b) => a.origin_bar_idx - b.origin_bar_idx),
  };
  const d4mZones = d4mDb.prepare("SELECT side, price, confirmed_time, expires_time FROM zones").all();
  function hasD4mConfluence(side, obPrice, atTime) {
    const tol = obPrice * D4M_TOL_PCT;
    for (const z of d4mZones) {
      if (z.side !== side) continue;
      if (z.confirmed_time > atTime) continue;
      if (z.expires_time != null && z.expires_time < atTime) continue;
      if (Math.abs(z.price - obPrice) <= tol) return true;
    }
    return false;
  }
  function simulate(entryIdx, side, atrAtAnchor, afterBarIdx) {
    const entryPrice = candles[entryIdx].o;
    const risk = ATR_MULT * atrAtAnchor;
    const stopPrice = side === "long" ? entryPrice - risk : entryPrice + risk;
    const oppositeSide = side === "long" ? "bearish" : "bullish";
    const nextOppositeOB = swingObsBySide[oppositeSide].find((ob) => ob.origin_bar_idx > afterBarIdx);
    const naturalExitIdx = Math.min(candles.length - 1, nextOppositeOB ? nextOppositeOB.origin_bar_idx : entryIdx + MAX_HOLD_BARS, entryIdx + MAX_HOLD_BARS);
    if (naturalExitIdx <= entryIdx) return null;
    let exitPrice = candles[naturalExitIdx].c, exitTime = candles[naturalExitIdx].t;
    for (let j = entryIdx; j <= naturalExitIdx; j++) {
      const bar = candles[j];
      const hitStop = side === "long" ? bar.l <= stopPrice : bar.h >= stopPrice;
      if (hitStop) { exitPrice = stopPrice; exitTime = bar.t; break; }
    }
    const pnlPct = side === "long" ? (exitPrice - entryPrice) / entryPrice : (entryPrice - exitPrice) / entryPrice;
    return { side, entryTime: candles[entryIdx].t, entryPrice, exitTime, exitPrice, pnlPct };
  }

  const baseline = { aligned: [], misaligned: [], noRegime: 0 };
  const refined = { aligned: [], misaligned: [], noRegime: 0 };

  for (const a of anchors) {
    const entryIdx = a.barIdx + 1;
    if (entryIdx >= candles.length) continue;
    const atrAtAnchor = atr14[a.barIdx];
    if (!Number.isFinite(atrAtAnchor) || atrAtAnchor <= 0) continue;
    const ob = obRows.find((o) => o.side === a.side && o.created_bar_idx <= a.barIdx + 2 && a.price >= o.bar_low && a.price <= o.bar_high);
    if (!ob) continue;
    const side = a.side === "bullish" ? "long" : "short";
    const trade = simulate(entryIdx, side, atrAtAnchor, a.barIdx);
    if (!trade) continue;

    const entryTime = candles[entryIdx].t;
    const regime = regimeAt(entryTime);
    if (regime == null) { baseline.noRegime++; continue; }
    const aligned = regime === a.side;
    (aligned ? baseline.aligned : baseline.misaligned).push(trade);

    // refined (#110): + q5 dropping, + same-side D4M confluence
    if (a.barIdx - 1 < 0) continue;
    const q5Now = q5[a.barIdx], q5Then = q5[a.barIdx - 1];
    if (!Number.isFinite(q5Now) || !Number.isFinite(q5Then) || !(q5Now < q5Then)) continue;
    const obMidPrice = (ob.bar_high + ob.bar_low) / 2;
    if (!hasD4mConfluence(a.side, obMidPrice, entryTime)) continue;
    (aligned ? refined.aligned : refined.misaligned).push(trade);
  }
  smcDb.close();
  d4mDb.close();

  function report(label, trades) {
    if (trades.length === 0) { console.log(`  ${label}: n=0`); return; }
    const gross = computeMetrics(trades);
    const costed = applyCosts(trades, confirmedParams);
    const exp = expectancy(trades), cexp = expectancy(costed);
    console.log(`  ${label}: n=${gross.trade_count}  win=${(gross.win_rate * 100).toFixed(1)}%  PF=${gross.profit_factor?.toFixed(2)}  gross_exp=${(exp * 100).toFixed(4)}%/trade  costed_exp=${(cexp * 100).toFixed(4)}%/trade${cexp > 0 ? " (CLEARS)" : ""}`);
  }

  console.log(`\n===== 15m baseline (#108/#109) split by daily-regime alignment =====`);
  const baseTotal = baseline.aligned.length + baseline.misaligned.length;
  console.log(`  total classified=${baseTotal}, no-regime-yet(skipped)=${baseline.noRegime}, aligned=${((baseline.aligned.length / baseTotal) * 100).toFixed(1)}%`);
  report("ALIGNED (15m side == daily regime)", baseline.aligned);
  report("MISALIGNED (15m side != daily regime)", baseline.misaligned);

  console.log(`\n===== 15m refined (#110: + q5 drop + D4M line) split by daily-regime alignment =====`);
  const refTotal = refined.aligned.length + refined.misaligned.length;
  console.log(`  total classified=${refTotal}, aligned=${refTotal ? ((refined.aligned.length / refTotal) * 100).toFixed(1) : "n/a"}%`);
  report("ALIGNED (15m side == daily regime)", refined.aligned);
  report("MISALIGNED (15m side != daily regime)", refined.misaligned);

  // significance: does aligned beat misaligned? (aligned mean vs random-label-shuffle null)
  function alignmentSignificance(aligned, misaligned) {
    const pool = [...applyCosts(aligned, confirmedParams).map((t) => ({ pnlPct: t.pnlPct, isAligned: true })),
                  ...applyCosts(misaligned, confirmedParams).map((t) => ({ pnlPct: t.pnlPct, isAligned: false }))];
    const n = pool.length;
    if (n < 30) return null;
    const nAligned = aligned.length;
    const realAlignedMean = pool.filter((t) => t.isAligned).reduce((s, t) => s + t.pnlPct, 0) / nAligned;
    const vals = pool.map((t) => t.pnlPct);
    const rng = mulberry32(42);
    const ITERATIONS = 20000;
    let geq = 0;
    for (let it = 0; it < ITERATIONS; it++) {
      // shuffle (Fisher-Yates) and take first nAligned as the "aligned" draw
      const shuffled = vals.slice();
      for (let i = shuffled.length - 1; i > 0; i--) { const j = Math.floor(rng() * (i + 1)); [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]]; }
      let sum = 0; for (let i = 0; i < nAligned; i++) sum += shuffled[i];
      if (sum / nAligned >= realAlignedMean) geq++;
    }
    return { n, nAligned, realAlignedMean, p: geq / ITERATIONS };
  }

  const baseSig = alignmentSignificance(baseline.aligned, baseline.misaligned);
  if (baseSig) console.log(`\nBaseline alignment significance: does ALIGNED beat a random same-size draw from the pooled aligned+misaligned set? n=${baseSig.n} (${baseSig.nAligned} aligned)  aligned mean=${(baseSig.realAlignedMean * 100).toFixed(4)}%  p=${baseSig.p.toFixed(4)}${baseSig.p < 0.05 ? "*" : ""}`);

  const refSig = alignmentSignificance(refined.aligned, refined.misaligned);
  if (refSig) console.log(`Refined alignment significance: n=${refSig.n} (${refSig.nAligned} aligned)  aligned mean=${(refSig.realAlignedMean * 100).toFixed(4)}%  p=${refSig.p.toFixed(4)}${refSig.p < 0.05 ? "*" : ""}`);
}

main().catch((err) => { console.error("Fatal:", err); process.exit(1); });
