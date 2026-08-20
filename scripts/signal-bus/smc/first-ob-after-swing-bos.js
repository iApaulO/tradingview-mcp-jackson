#!/usr/bin/env node
// iapaulo's SIMPLIFIED EXECUTION RULE, 2026-08-19:
//   "long entry, first bullish entry at first confirmed ob after bos swing line"
//
// He simplified deliberately. The failed-CHoCH stage from his earlier description is, in his words,
// "predefined by the preceeding structure defined by arrow so the choch doesnt necessarily have to be
// in equation". So the CHoCH sequence drops out and the executable rule is two objects we already
// have, with no new modelling and no definitional choices of mine:
//
//   1. a SWING-scope BOS fires   ("the bos swing line")
//   2. the FIRST confirmed BULLISH order block created after it
//   3. LONG
//
// **NO NEW OBJECTS, NO INVENTED THRESHOLDS.** This is the first construction of his in this whole
// line of work that needs neither. Every prior attempt (#193 sweep recency, #194 wick-reject
// strictness, #196/#197 sharpness) required me to pick a number he never specified, and #197 showed
// two readings of one phrase giving opposite answers. This one has none of that.
//
// DECOMPOSITION, per #186 -- a gated result is meaningless without its ungated baseline:
//   (A) ALL bullish OBs, long                     -- the baseline the rule must beat
//   (B) first bullish OB after a BULLISH swing BOS -- his rule as I read it
//   (C) first bullish OB after ANY swing BOS       -- in case "bos swing line" is scope-only
//   (D) (B) capped to OBs arriving within 50 bars of the BOS -- "first ... after" with a horizon
//   (E) (B) entered on first TOUCH of the OB instead of at creation -- the #180 reclaim shape, which
//       is the one construction that has PASSED a pre-registration in this project
//
// Entry at the next bar's open in all arms. #143 frozen construction. BTC/ETH/SOL/XRP, 1h + 4h.
// **XRP is already spent (#195), so no gate is being consumed here.**

import { DatabaseSync } from "node:sqlite";
import { loadCandles } from "../../backtest/lib/load-candles.js";
import { FEE_TIERS, REPRESENTATIVE_FUNDING_PCT_PER_HOUR } from "../../backtest/lib/costs.js";
import { dbSuffix } from "../lib/instrument.js";
import { computeSMC } from "./calc.js";

const ATR_LEN = 14, ATR_MULT = 2.0, R_MULT = 2, HOLD_BARS = 200;
const SLIP_ENTRY_ATR = 0.05, SLIP_STOP_ATR = 0.15, SLIP_TARGET_ATR = 0;
const TAKER = FEE_TIERS.bitunix_futures_vip1.takerFeePct;
const MIN_N = 60;
const NEAR_BARS = 50;
const TOUCH_WINDOW = 100;

const TFS = ["1h", "4h"];
const INSTRUMENTS = ["BTC", "ETH", "SOL", "XRP"];

const mean = (xs) => (xs.length ? xs.reduce((s, x) => s + x, 0) / xs.length : NaN);
const sd = (xs) => { const m = mean(xs); return Math.sqrt(mean(xs.map((x) => (x - m) ** 2))); };

function atrSeries(c, L) {
  const tr = c.map((x, i) => (i === 0 ? x.h - x.l : Math.max(x.h - x.l, Math.abs(x.h - c[i - 1].c), Math.abs(x.l - c[i - 1].c))));
  const o = new Array(c.length).fill(NaN);
  let s = 0; for (let i = 0; i < L; i++) s += tr[i];
  o[L - 1] = s / L;
  for (let i = L; i < c.length; i++) o[i] = (o[i - 1] * (L - 1) + tr[i]) / L;
  return o;
}

function runTrade(c, atr, idx, side) {
  if (idx >= c.length) return null;
  const a = atr[idx];
  if (!Number.isFinite(a) || a <= 0) return null;
  const risk = ATR_MULT * a;
  const entry = side === "long" ? c[idx].o + SLIP_ENTRY_ATR * a : c[idx].o - SLIP_ENTRY_ATR * a;
  const stop = side === "long" ? entry - risk : entry + risk;
  const tgt = side === "long" ? entry + R_MULT * risk : entry - R_MULT * risk;
  const end = Math.min(c.length - 1, idx + HOLD_BARS);
  let pnl = null, hours = 0, won = 0;
  for (let j = idx; j <= end; j++) {
    const b = c[j];
    const hs = side === "long" ? b.l <= stop : b.h >= stop;
    const ht = side === "long" ? b.h >= tgt : b.l <= tgt;
    if (hs) { const f = side === "long" ? stop - SLIP_STOP_ATR * a : stop + SLIP_STOP_ATR * a;
      pnl = side === "long" ? (f - entry) / entry : (entry - f) / entry; hours = (b.t - c[idx].t) / 3600; won = 0; break; }
    if (ht) { const f = side === "long" ? tgt - SLIP_TARGET_ATR * a : tgt + SLIP_TARGET_ATR * a;
      pnl = side === "long" ? (f - entry) / entry : (entry - f) / entry; hours = (b.t - c[idx].t) / 3600; won = 1; break; }
  }
  if (pnl === null) {
    if (end <= idx) return null;
    const b = c[end];
    const f = side === "long" ? b.c - SLIP_ENTRY_ATR * a : b.c + SLIP_ENTRY_ATR * a;
    pnl = side === "long" ? (f - entry) / entry : (entry - f) / entry;
    hours = (b.t - c[idx].t) / 3600; won = pnl > 0 ? 1 : 0;
  }
  return { net: pnl - 2 * TAKER - REPRESENTATIVE_FUNDING_PCT_PER_HOUR * Math.max(0, hours), won };
}

const tstat = (g) => {
  const xs = g.map((x) => x.net);
  if (xs.length < 2) return NaN;
  const s = sd(xs) * Math.sqrt(xs.length / (xs.length - 1));
  return s > 0 ? mean(xs) / (s / Math.sqrt(xs.length)) : NaN;
};
const fmt = (label, g) => {
  if (g.length < MIN_N) return `    ${label.padEnd(46)}${String(g.length).padStart(5)}   below n>=${MIN_N}`;
  return `    ${label.padEnd(46)}${String(g.length).padStart(5)}${((g.filter((t) => t.won).length / g.length) * 100).toFixed(1).padStart(8)}%` +
         `${(mean(g.map((t) => t.net)) * 100).toFixed(4).padStart(12)}%${tstat(g).toFixed(2).padStart(9)}`;
};

async function main() {
  console.log('iapaulo: "long entry, first bullish entry at first confirmed ob after bos swing line"');
  console.log("No new objects, no invented thresholds -- swing BOS and bullish OB both already exist.");
  console.log(`(A) all bullish OBs = baseline.  (B) his rule.  (C) any swing BOS.  (D) <=${NEAR_BARS} bars.  (E) entry on first TOUCH.`);
  console.log(`${R_MULT}R @ ${ATR_MULT}x ATR(${ATR_LEN}), breakeven 33.3%. XRP already spent (#195).\n`);

  const pooled = {};
  const addp = (k, t) => { (pooled[k] ??= []).push(t); };

  for (const inst of INSTRUMENTS) {
    for (const tf of TFS) {
      const c = await loadCandles(tf, inst);
      if (c.length < 1000) continue;
      const atr = atrSeries(c, ATR_LEN);
      const idxOf = new Map(c.map((x, i) => [x.t, i]));
      let db;
      try { db = new DatabaseSync(new URL(`../../../data/signal-bus/smc${dbSuffix(inst)}.db`, import.meta.url), { readOnly: true }); }
      catch { console.log(`(${inst}: no smc db, skipped)`); continue; }

      const bos = db.prepare("SELECT time, side FROM structure_events WHERE timeframe=? AND instrument=? AND type='BOS' AND scope='swing' ORDER BY time").all(tf, inst);
      const obs = db.prepare("SELECT created_time, bar_high, bar_low FROM order_blocks WHERE timeframe=? AND instrument=? AND side='bullish' ORDER BY created_time").all(tf, inst);
      db.close();
      if (!bos.length || !obs.length) { console.log(`===== ${inst} ${tf}   swing BOS ${bos.length}, bullish OBs ${obs.length} -- skipped`); continue; }

      const obIdx = obs.map((o) => ({ ...o, i: idxOf.get(o.created_time) })).filter((o) => o.i !== undefined);
      const bullBos = bos.filter((b) => b.side === "bullish").map((b) => idxOf.get(b.time)).filter((v) => v !== undefined);
      const anyBos = bos.map((b) => idxOf.get(b.time)).filter((v) => v !== undefined);

      // first bullish OB created strictly after each BOS; de-duplicated so one OB is not counted twice
      // De-duplicate BY ORDER BLOCK, not by (OB, BOS) pair. Two swing BOS firing before any new OB
      // both resolve to the SAME next OB; keying on the pair would trade that OB twice and inflate n.
      const firstAfter = (bosList) => {
        const byOb = new Map();
        for (const b of bosList) {
          const hit = obIdx.find((o) => o.i > b);
          if (!hit) continue;
          const prev = byOb.get(hit.i);
          if (prev === undefined || b > prev) byOb.set(hit.i, b);   // nearest preceding BOS
        }
        return [...byOb.entries()].map(([i, b]) => ({ i, b }));
      };
      const B = firstAfter(bullBos);
      const C = firstAfter(anyBos);
      const D = B.filter((x) => x.i - x.b <= NEAR_BARS);

      // (E) entry on the first bar that TOUCHES the OB body after it is created
      // (F) HIS ACTUAL PRECONDITION: the arrow marks a STRONG LOW, which LuxAlgo prints only when
      // swingTrend.bias == BULLISH (source L733). Computed in our port since day one but never
      // exposed until 2026-08-19, so every prior test ran WITHOUT it.
      const { swingBias } = computeSMC(c);
      const BULL = 1, BEAR = -1;
      const F = B.filter((x) => swingBias[x.i] === BULL);
      const Fbear = B.filter((x) => swingBias[x.i] === BEAR);
      const allBullBias = obIdx.map((o) => o.i).filter((i) => swingBias[i] === BULL);

      const E = [];
      for (const x of B) {
        const o = obIdx.find((z) => z.i === x.i);
        if (!o) continue;
        const end = Math.min(c.length - 1, x.i + TOUCH_WINDOW);
        for (let j = x.i + 1; j <= end; j++) {
          if (c[j].l <= o.bar_high && c[j].h >= o.bar_low) { E.push({ i: j }); break; }
        }
      }

      console.log(`===== ${inst} ${tf}   swing BOS ${bos.length} (bullish ${bullBos.length})   bullish OBs ${obIdx.length}   (B) ${B.length}   (C) ${C.length}   (D) ${D.length}   (E) ${E.length}   (F strong-low) ${F.length}   (G weak-low) ${Fbear.length}`);
      console.log("    arm                                               n    win%   net%/trade        t");
      const mk = (list, key) => list.map((x) => runTrade(c, atr, (key ? x[key] : x) + 1, "long")).filter(Boolean);
      const rows = [
        ["(A) ALL bullish OBs at creation", mk(obIdx.map((o) => o.i), null)],
        ["(B) first bullish OB after BULLISH swing BOS", mk(B, "i")],
        ["(C) first bullish OB after ANY swing BOS", mk(C, "i")],
        [`(D) (B) within ${NEAR_BARS} bars of the BOS`, mk(D, "i")],
        ["(E) (B) entered on first TOUCH of the OB", mk(E, "i")],
        ["(F) (B) + STRONG LOW (swing bias BULLISH)", mk(F, "i")],
        ["(G) (B) + WEAK low (swing bias BEARISH)", mk(Fbear, "i")],
        ["(H) ALL bullish OBs + STRONG LOW", mk(allBullBias, null)],
      ];
      for (const [l, g] of rows) { console.log(fmt(l, g)); for (const t of g) addp(l, t); }
      console.log("");
    }
  }

  console.log("--- POOLED BTC/ETH/SOL/XRP, 1h+4h");
  console.log("    arm                                               n    win%   net%/trade        t");
  for (const k of Object.keys(pooled)) console.log(fmt(k, pooled[k]));
  console.log("\nHIS RULE WORKS only if (B) is positive AND beats (A). If (B) tracks (A), the swing-BOS");
  console.log("condition is selecting nothing and the result belongs to bullish OBs generally, not to his rule.");
}

main().catch((e) => { console.error("Fatal:", e); process.exit(1); });
