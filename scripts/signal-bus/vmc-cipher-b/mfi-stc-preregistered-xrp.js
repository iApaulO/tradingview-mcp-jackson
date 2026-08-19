#!/usr/bin/env node
// PRE-REGISTERED SINGLE RUN -- MFI-gated STC U-turns on 4h, XRP.
//
// Specification: skills/ict-smc-trader/PREREGISTRATION-mfi-stc.md, committed before Cipher B had
// ever been computed on XRP -- no vmc-cipher-b-xrp.db exists and no register row reports a Cipher B
// result on XRP. That guarantee is WEAKER than #180's and the spec says so: XRP candles already
// exist (fetched for #180) and Cipher B computes in memory from candles, so nothing stood between
// the data and a result except not having run it. The honest claim is "never evaluated on this
// instrument", not "the data did not exist".
//
// **THIS RUNS ONCE.** Every constant is hard-coded, not a flag. Changing any value after seeing a
// result invalidates the run and must be recorded as such rather than quietly re-run.
//
// THE CLAIM (#181 -> #184): MFI and STC are the most orthogonal pair in Cipher B (normalised MI
// 0.0010-0.0048), and gating STC U-turns on MFI sign produced the only two profitable cells in a
// twelve-cell sweep -- BTC 4h +0.7635% at 39.7% win (n=136) and ETH 4h +0.4116% at 37.1% (n=143).
// #184 examined twelve cells and 4h won, which is a selection it cannot rule out from within. This
// is the test that can.
//
// `stcCross` is deliberately EXCLUDED: #184 found it profitable in no cell on any instrument.
// Including it here would be a second shot at the same target.

import { loadCandles } from "../../backtest/lib/load-candles.js";
import { FEE_TIERS, REPRESENTATIVE_FUNDING_PCT_PER_HOUR } from "../../backtest/lib/costs.js";
import { computeMfi, computeStcUTurnSignals } from "./calc.js";

// ---- FROZEN. Do not parameterise. ----
const INSTRUMENT = "XRP";
const TF = "4h";
const ATR_LEN = 14, ATR_MULT = 2.0, R_MULT = 2, HOLD_BARS = 200;
const SLIP_ENTRY_ATR = 0.05, SLIP_STOP_ATR = 0.15, SLIP_TARGET_ATR = 0;
const TAKER = FEE_TIERS.bitunix_futures_vip1.takerFeePct;
const MIN_N = 60;

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
    const hitStop = side === "long" ? b.l <= stop : b.h >= stop;
    const hitTgt = side === "long" ? b.h >= tgt : b.l <= tgt;
    if (hitStop) {
      const f = side === "long" ? stop - SLIP_STOP_ATR * a : stop + SLIP_STOP_ATR * a;
      pnl = side === "long" ? (f - entry) / entry : (entry - f) / entry;
      hours = (b.t - c[idx].t) / 3600; won = 0; break;
    }
    if (hitTgt) {
      const f = side === "long" ? tgt - SLIP_TARGET_ATR * a : tgt + SLIP_TARGET_ATR * a;
      pnl = side === "long" ? (f - entry) / entry : (entry - f) / entry;
      hours = (b.t - c[idx].t) / 3600; won = 1; break;
    }
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
  console.log(`PRE-REGISTERED RUN -- MFI-gated STC U-turns, ${INSTRUMENT} ${TF}, executed once.`);
  console.log("Spec: skills/ict-smc-trader/PREREGISTRATION-mfi-stc.md");
  console.log(`Event: STC U-turn inside 25-75. Gate: MFI sign at the signal bar. Entry: next bar open.`);
  console.log(`${R_MULT}R @ ${ATR_MULT}x ATR(${ATR_LEN}), hold<=${HOLD_BARS}, slip ${SLIP_ENTRY_ATR}/${SLIP_STOP_ATR}, taker+funding.`);
  console.log("2R breakeven = 33.3% before costs.\n");

  const c = await loadCandles(TF, INSTRUMENT);
  const atr = atrSeries(c, ATR_LEN);
  const mfi = computeMfi(c);
  const { events } = computeStcUTurnSignals(c);

  const b = { ungated: [], aligned: [], opposed: [] };
  for (const e of events) {
    const i = e.confirmedBarIdx + 1;
    if (i < 1 || i >= c.length) continue;
    const m = mfi[e.confirmedBarIdx];
    if (!Number.isFinite(m)) continue;
    const side = e.side === "bullish" ? "long" : "short";
    const t = runTrade(c, atr, i, side);
    if (!t) continue;
    b.ungated.push(t);
    ((e.side === "bullish" ? m > 0 : m < 0) ? b.aligned : b.opposed).push(t);
  }

  console.log(`${INSTRUMENT} ${TF}: ${c.length.toLocaleString()} bars, ${new Date(c[0].t * 1000).toISOString().slice(0, 10)} -> ${new Date(c[c.length - 1].t * 1000).toISOString().slice(0, 10)}`);
  console.log("  arm           n      win%     net%/trade    vs ungated");
  const base = mean(b.ungated.map((t) => t.net));
  for (const k of ["ungated", "aligned", "opposed"]) {
    const g = b[k];
    if (!g.length) { console.log(`  ${k.padEnd(12)} none`); continue; }
    const nm = mean(g.map((t) => t.net));
    console.log(
      `  ${k.padEnd(12)}${String(g.length).padStart(5)}${((g.filter((t) => t.won).length / g.length) * 100).toFixed(1).padStart(10)}%` +
      `${(nm * 100).toFixed(4).padStart(14)}%${k === "ungated" ? "        --" : ((nm - base) * 100).toFixed(4).padStart(10) + "pp"}`,
    );
  }

  // ---- criteria from PREREGISTRATION section 3, evaluated mechanically ----
  const aN = b.aligned.length;
  const aNet = mean(b.aligned.map((t) => t.net));
  const nOk = aN >= MIN_N;
  const c1 = nOk && aNet > 0;
  const c2 = nOk && aNet > base;

  console.log("\n---- CRITERIA (PREREGISTRATION section 3) ----");
  console.log(`  3. n >= ${MIN_N} in the aligned cell ........ ${nOk ? "MET" : "NOT MET"}  (n=${aN})`);
  console.log(`  1. aligned net > 0 ..................... ${c1 ? "MET" : "NOT MET"}  (${(aNet * 100).toFixed(4)}%)`);
  console.log(`  2. aligned beats ungated ............... ${c2 ? "MET" : "NOT MET"}  (${(base * 100).toFixed(4)}% -> ${(aNet * 100).toFixed(4)}%)`);
  const verdict = !nOk ? "INCONCLUSIVE (population floor)" : c1 && c2 ? "PASS" : "FAIL";
  console.log(`\n  VERDICT: ${verdict}`);
  if (verdict === "PASS") console.log("  Authorises the #33 paper/live-shadow stage for this construction ONLY. Not portfolio wiring.");
  if (verdict === "FAIL") console.log("  Recorded as a FAIL. No partial credit, no amendment, no re-run.");
}

main().catch((e) => { console.error("Fatal:", e); process.exit(1); });
