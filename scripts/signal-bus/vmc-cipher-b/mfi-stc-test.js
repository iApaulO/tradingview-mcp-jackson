#!/usr/bin/env node
// MFI x STC -- the most orthogonal pair in Market Cipher B, never tested together.
//
// #181 measured the component redundancy matrix and found MFI and STC essentially independent:
// normalised mutual information 0.0010-0.0048 across both instruments and all three rungs, the
// lowest of any pair in the indicator. Everything else clusters -- wt1, wt2 and Cipher A's wt2 are
// ONE measurement at r 0.973-0.9993 -- so if there is combinatorial value anywhere in Cipher B, this
// is the pair with the most room for it.
//
// **INDEPENDENCE IS NECESSARY, NOT SUFFICIENT, and this project has the scars.** #150 and #151 both
// passed an independence check and then carried no edge whatsoever. Orthogonality says two signals
// COULD add information; it says nothing about whether either predicts anything. This test asks the
// second question.
//
// NO FORWARD-RETURN STAGE. #154 -> #155, #161 -> #162 and #168 -> #169 all showed a forward-return
// contrast failing the R-multiple rebuild, three times in one session, which is enough to treat as a
// standing rule. Candidates go straight to #143's frozen trade construction.
//
// DESIGN. STC supplies the EVENT (it has two documented signal families already ported); MFI supplies
// the GATE (it is a continuous regime series with no natural event). Two STC families are tested
// because #54 and #58 established they are genuinely different objects:
//   stcCross  -- threshold cross out of oversold/overbought. #54 falsified its standalone rules.
//   stcUTurn  -- directional turn inside the 25-75 band. Fires far more often.
// The MFI gate is its SIGN at the signal bar: aligned (MFI > 0 for a bullish signal, < 0 for bearish)
// versus opposed. #37 tested an MFI gate on Cipher B's buySignal and falsified it -- but that row
// recorded the failure as specific to a SAME-BAR operationalisation and explicitly left the general
// question open, and #181 then showed MFI is a genuinely independent channel. So this is not a
// re-run of #37: different trigger, and a redundancy measurement #37 did not have.
//
// The comparison that matters is ALIGNED versus UNGATED, not aligned versus opposed. A gate that
// merely splits a population into a better and a worse half proves the gate carries information; a
// gate worth using must beat taking every signal.

import { loadCandles } from "../../backtest/lib/load-candles.js";
import { FEE_TIERS, REPRESENTATIVE_FUNDING_PCT_PER_HOUR } from "../../backtest/lib/costs.js";
import { computeMfi, computeStcCrossSignals, computeStcUTurnSignals } from "./calc.js";
import { dbSuffix } from "../lib/instrument.js";

// ---- #143 frozen construction ----
const ATR_LEN = 14, ATR_MULT = 2.0, R_MULT = 2, HOLD_BARS = 200;
const SLIP_ENTRY_ATR = 0.05, SLIP_STOP_ATR = 0.15, SLIP_TARGET_ATR = 0;
const TAKER = FEE_TIERS.bitunix_futures_vip1.takerFeePct;
const MIN_N = 60;
const TFS = ["4h", "1h", "15m"];
const INSTRUMENTS = ["BTC", "ETH"];

void dbSuffix;
const mean = (xs) => (xs.length ? xs.reduce((s, x) => s + x, 0) / xs.length : NaN);

function atrSeries(c, L) {
  const tr = c.map((x, i) => (i === 0 ? x.h - x.l : Math.max(x.h - x.l, Math.abs(x.h - c[i - 1].c), Math.abs(x.l - c[i - 1].c))));
  const o = new Array(c.length).fill(NaN);
  let s = 0; for (let i = 0; i < L; i++) s += tr[i];
  o[L - 1] = s / L;
  for (let i = L; i < c.length; i++) o[i] = (o[i - 1] * (L - 1) + tr[i]) / L;
  return o;
}

function runTrade(c, atr, idx, side) {
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

async function main() {
  console.log("MFI x STC -- the most orthogonal pair in Cipher B (#181: normalised MI 0.0010-0.0048).");
  console.log("Independence is NECESSARY, NOT SUFFICIENT -- #150 and #151 both passed one and carried no edge.");
  console.log(`#143 frozen construction, no forward-return stage. ${R_MULT}R @ ${ATR_MULT}x ATR(${ATR_LEN}), 2R breakeven = 33.3%.`);
  console.log("The comparison that matters is ALIGNED vs UNGATED: a gate must beat taking every signal.\n");

  for (const inst of INSTRUMENTS) {
    for (const tf of TFS) {
      const c = await loadCandles(tf, inst);
      if (c.length < 500) continue;
      const atr = atrSeries(c, ATR_LEN);
      const mfi = computeMfi(c);

      for (const [fam, fn] of [["stcCross", computeStcCrossSignals], ["stcUTurn", computeStcUTurnSignals]]) {
        const { events } = fn(c);
        const buckets = { ungated: [], aligned: [], opposed: [] };
        for (const e of events) {
          const i = e.confirmedBarIdx + 1;                 // available_at: enter the bar AFTER the signal
          if (i < 1 || i >= c.length) continue;
          const side = e.side === "bullish" ? "long" : "short";
          const m = mfi[e.confirmedBarIdx];
          if (!Number.isFinite(m)) continue;
          const t = runTrade(c, atr, i, side);
          if (!t) continue;
          buckets.ungated.push(t);
          const alignedNow = e.side === "bullish" ? m > 0 : m < 0;
          (alignedNow ? buckets.aligned : buckets.opposed).push(t);
        }
        if (buckets.ungated.length < MIN_N) continue;
        console.log(`${inst} ${tf}  ${fam}`);
        console.log("    gate          n      win%     net%/trade    vs ungated");
        const base = mean(buckets.ungated.map((t) => t.net));
        for (const k of ["ungated", "aligned", "opposed"]) {
          const g = buckets[k];
          if (g.length < 30) { console.log(`    ${k.padEnd(12)}${String(g.length).padStart(5)}   (n<30)`); continue; }
          const nm = mean(g.map((t) => t.net));
          console.log(
            `    ${k.padEnd(12)}${String(g.length).padStart(5)}${(g.filter((t) => t.won).length / g.length * 100).toFixed(1).padStart(10)}%` +
            `${(nm * 100).toFixed(4).padStart(14)}%` +
            `${k === "ungated" ? "        --" : ((nm - base) * 100).toFixed(4).padStart(10) + "pp"}`,
          );
        }
        console.log("");
      }
    }
  }
}

main().catch((e) => { console.error("Fatal:", e); process.exit(1); });
