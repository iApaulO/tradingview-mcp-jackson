// Shared builder for Strategy G's trade population, extracted 2026-08-15.
//
// WHY THIS EXISTS. The same construction was already copied verbatim into
// wt-anchor-swingline-vs-d4m.js (#123) and strategy-g-depth-gate.js (#133), and a third copy was
// about to be made for the out-of-sample work. Three hand-maintained copies of a trade
// construction is how two of them silently drift apart and produce numbers nobody can reconcile.
//
// The two EXISTING scripts are deliberately left untouched: both are attached to logged register
// rows whose numbers have been verified, and rewriting them to import this module would risk
// changing a published result to save duplication. New work uses this module; consolidating the
// older two is a follow-up to be done with a before/after reproduction check, not a drive-by edit.
//
// Construction (identical to #123/#133): WT2 extreme anchor + same-side SMC swing order-block
// confluence at entry + Boom Hunter q5 dropping at the anchor, held to the opposite-side order
// block's origin bar with a 0.6x ATR(14) stop. The three structure-filter variants are returned as
// per-trade booleans rather than pre-filtered, so callers slice them consistently.
//
// Also returns, per trade, the multi-timeframe context needed by #132/#133: agreement depth D, and
// whether the trade's own side agrees with the weekly and daily SuperTrend direction. All of it is
// computed under available_at discipline -- every rung contributes only its last bar CLOSED at or
// before the entry bar's open.

import { DatabaseSync } from "node:sqlite";
import { loadCandles } from "../../../backtest/lib/load-candles.js";
import { calcATRSeries, computeAdaptiveSuperTrend } from "../../../lib/adaptive-supertrend.js";
import { computeWtExtremeFractals } from "../../vmc-cipher-b/calc.js";
import { computeBoomHunter } from "../../boom-hunter/calc.js";
import { computeSwingPivotSeries } from "../../smc/calc.js";

const D4M_TOL_PCT = 0.012, ATR_LEN = 14, ATR_MULT = 0.6, MAX_HOLD_BARS = 200, ST_ATR_LEN = 10;
const LADDER = [["1w", 604800], ["1d", 86400], ["4h", 14400], ["3h", 10800], ["2h", 7200], ["1h", 3600], ["15m", 900], ["5m", 300]];

const dbFile = (base, instrument) =>
  new URL(`../../../../data/signal-bus/${instrument === "BTC" ? `${base}.db` : `${base}-eth.db`}`, import.meta.url);

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

export async function buildGPopulation(instrument = "BTC", tf = "15m") {
  const candles = await loadCandles(tf, instrument);
  const atr14 = atr(candles, ATR_LEN);
  const { events: anchors } = computeWtExtremeFractals(candles);
  const { series } = computeBoomHunter(candles);
  const q5 = series.q5;
  const { swingHighLevel, swingLowLevel } = computeSwingPivotSeries(candles);
  const nB = candles.length;

  // Ladder state on the base timeline, available_at enforced.
  const dirs = [];
  for (const [rtf, stepSec] of LADDER) {
    const c = rtf === tf ? candles : await loadCandles(rtf, instrument);
    const { dir } = computeAdaptiveSuperTrend(c, calcATRSeries(c, ST_ATR_LEN));
    const s = new Int8Array(nB).fill(-1);
    let j = 0;
    for (let i = 0; i < nB; i++) {
      const cutoff = candles[i].t - stepSec;
      while (j + 1 < c.length && c[j + 1].t <= cutoff) j++;
      if (c[j].t <= cutoff && Number.isFinite(dir[j])) s[i] = dir[j] > 0 ? 1 : 0;
    }
    dirs.push(s);
  }
  const D = new Int8Array(nB).fill(-1), top = new Int8Array(nB).fill(-1), daily = new Int8Array(nB).fill(-1);
  for (let i = 0; i < nB; i++) {
    let ok = true;
    for (const s of dirs) if (s[i] < 0) { ok = false; break; }
    if (!ok) continue;
    top[i] = dirs[0][i]; daily[i] = dirs[1][i];
    let d = 0;
    while (d < dirs.length && dirs[d][i] === top[i]) d++;
    D[i] = d;
  }

  const smcDb = new DatabaseSync(dbFile("smc", instrument), { readOnly: true });
  const d4mDb = new DatabaseSync(dbFile("divergence-for-many", instrument), { readOnly: true });
  const obRows = smcDb.prepare("SELECT side, bar_high, bar_low, created_bar_idx, origin_bar_idx FROM order_blocks WHERE timeframe = ? AND scope = ?").all(tf, "swing");
  const bySide = {
    bullish: obRows.filter((o) => o.side === "bullish").sort((a, b) => a.origin_bar_idx - b.origin_bar_idx),
    bearish: obRows.filter((o) => o.side === "bearish").sort((a, b) => a.origin_bar_idx - b.origin_bar_idx),
  };
  const d4mZones = d4mDb.prepare("SELECT side, price, confirmed_time, expires_time FROM zones").all();
  smcDb.close(); d4mDb.close();

  const hasD4m = (side, price, atTime) => {
    const tol = price * D4M_TOL_PCT;
    for (const z of d4mZones) {
      if (z.side !== side || z.confirmed_time > atTime) continue;
      if (z.expires_time != null && z.expires_time < atTime) continue;
      if (Math.abs(z.price - price) <= tol) return true;
    }
    return false;
  };
  const beyondSwing = (side, price, barIdx) => {
    if (side === "bullish") { const l = swingLowLevel[barIdx]; return Number.isFinite(l) && price < l; }
    const h = swingHighLevel[barIdx]; return Number.isFinite(h) && price > h;
  };

  function simulate(entryIdx, side, atrAtAnchor, afterBarIdx) {
    const entryPrice = candles[entryIdx].o;
    const risk = ATR_MULT * atrAtAnchor;
    const stop = side === "long" ? entryPrice - risk : entryPrice + risk;
    const opp = side === "long" ? "bearish" : "bullish";
    const nextOpp = bySide[opp].find((ob) => ob.origin_bar_idx > afterBarIdx);
    const exitIdx = Math.min(candles.length - 1, nextOpp ? nextOpp.origin_bar_idx : entryIdx + MAX_HOLD_BARS, entryIdx + MAX_HOLD_BARS);
    if (exitIdx <= entryIdx) return null;
    let exitPrice = candles[exitIdx].c, exitTime = candles[exitIdx].t;
    for (let j = entryIdx; j <= exitIdx; j++) {
      const bar = candles[j];
      if (side === "long" ? bar.l <= stop : bar.h >= stop) { exitPrice = stop; exitTime = bar.t; break; }
    }
    const pnlPct = side === "long" ? (exitPrice - entryPrice) / entryPrice : (entryPrice - exitPrice) / entryPrice;
    return { side, entryTime: candles[entryIdx].t, entryPrice, exitTime, exitPrice, pnlPct };
  }

  const trades = [];
  for (const a of anchors) {
    const entryIdx = a.barIdx + 1;
    if (entryIdx >= candles.length) continue;
    const atrAtAnchor = atr14[a.barIdx];
    if (!Number.isFinite(atrAtAnchor) || atrAtAnchor <= 0) continue;
    const ob = obRows.find((o) => o.side === a.side && o.created_bar_idx <= a.barIdx + 2 && a.price >= o.bar_low && a.price <= o.bar_high);
    if (!ob) continue;
    if (a.barIdx - 1 < 0) continue;
    const q5Now = q5[a.barIdx], q5Then = q5[a.barIdx - 1];
    if (!Number.isFinite(q5Now) || !Number.isFinite(q5Then) || !(q5Now < q5Then)) continue;
    if (D[entryIdx] < 0) continue;
    const side = a.side === "bullish" ? "long" : "short";
    const t = simulate(entryIdx, side, atrAtAnchor, a.barIdx);
    if (!t) continue;
    const obMid = (ob.bar_high + ob.bar_low) / 2;
    trades.push({
      ...t,
      D: D[entryIdx],
      agreesWeekly: (a.side === "bullish") === (top[entryIdx] === 1),
      agreesDaily: (a.side === "bullish") === (daily[entryIdx] === 1),
      hasD4m: hasD4m(a.side, obMid, t.entryTime),
      hasSwing: beyondSwing(a.side, obMid, a.barIdx),
    });
  }
  trades.sort((a, b) => a.entryTime - b.entryTime);
  return trades;
}

export const G_VARIANTS = {
  "D4M_ONLY (shipped G)": (t) => t.hasD4m,
  SWINGLINE_ONLY: (t) => t.hasSwing,
  BOTH: (t) => t.hasD4m && t.hasSwing,
};
