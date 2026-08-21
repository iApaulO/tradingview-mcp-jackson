// MSS R4 BUILDER -- the single source of the `MSS entry @ 4R` population for paper and any future
// backtest. Construction is EXACTLY #206's R4 arm, the trim-robust winner of the exit sweep:
//
//   signal   bullish SWING-scope CHoCH on 4h (the MSS -- REFERENTS.md, #185/#205), read from the
//            smc db, never recomputed here (one population definition, one place)
//   entry    next 4h bar OPEN, maker fee, no entry slippage (a trigger order fills at its price)
//   stop     2.0x ATR(14), taker fee + 0.15 ATR slippage (a stop is a market order; #200)
//   target   4R, maker fee (a resting limit)
//   timeout  200 bars, exit at close, taker fee
//   funding  0.00125%/hr against the position for every hour held
//
// Validated in-sample at +2.8241%/trade, t=2.64, n=131 pooled BTC/ETH/SOL/XRP -- t=2.43 with the
// best trade removed, t=2.00 with the best three removed (#206). NOT pre-registered, NOT
// out-of-sample. The paper ledger records that tier; do not upgrade it in prose.
//
// EDGE DISCIPLINE: a trade is returned as RESOLVED only when its outcome is decided by closed bars
// -- stop or target hit, or the full 200-bar window lies inside the data. A window that runs off
// the data edge yields an OPEN trade with no exit, never a mark-to-market disguised as one.

import { DatabaseSync } from "node:sqlite";
import { FEE_TIERS, REPRESENTATIVE_FUNDING_PCT_PER_HOUR } from "../../backtest/lib/costs.js";
import { dbSuffix } from "../lib/instrument.js";

const ATR_LEN = 14, ATR_MULT = 2.0, R_MULT = 4, HOLD_BARS = 200, SLIP_STOP_ATR = 0.15;
const TAKER = FEE_TIERS.bitunix_futures_vip1.takerFeePct;
const MAKER = FEE_TIERS.bitunix_futures_vip1.makerFeePct;

export const MSS_R4_REF = { win: 0.344, net: 0.028241, rows: "#206 #204", tier: "in-sample" };

function atrSeries(c, L) {
  const tr = c.map((x, i) => (i === 0 ? x.h - x.l : Math.max(x.h - x.l, Math.abs(x.h - c[i - 1].c), Math.abs(x.l - c[i - 1].c))));
  const o = new Array(c.length).fill(NaN);
  let s = 0; for (let i = 0; i < L; i++) s += tr[i];
  o[L - 1] = s / L;
  for (let i = L; i < c.length; i++) o[i] = (o[i - 1] * (L - 1) + tr[i]) / L;
  return o;
}

// candles: the instrument's 4h series. Returns { trades } sorted by entryTime.
export function buildMssR4(instrument, candles) {
  const atr = atrSeries(candles, ATR_LEN);
  const idxOf = new Map(candles.map((x, i) => [x.t, i]));
  const db = new DatabaseSync(new URL(`../../../data/signal-bus/smc${dbSuffix(instrument)}.db`, import.meta.url), { readOnly: true });
  const signals = db.prepare(
    "SELECT time FROM structure_events WHERE timeframe='4h' AND instrument=? AND type='CHOCH' AND side='bullish' AND scope='swing' ORDER BY time",
  ).all(instrument).map((r) => idxOf.get(r.time)).filter((v) => v !== undefined);
  db.close();

  const trades = [];
  for (const sig of signals) {
    const idx = sig + 1;
    if (idx >= candles.length) continue;
    const a = atr[idx];
    if (!Number.isFinite(a) || a <= 0) continue;
    const entry = candles[idx].o;
    const stop = entry - ATR_MULT * a;
    const target = entry + R_MULT * ATR_MULT * a;
    const windowEnd = idx + HOLD_BARS;
    const end = Math.min(candles.length - 1, windowEnd);

    const base = {
      instrument, timeframe: "4h", side: "long",
      signalTime: candles[sig].t, entryTime: candles[idx].t, entryPrice: entry,
      stopPrice: stop, targetPrice: target, riskPct: (ATR_MULT * a) / entry,
    };
    let done = null;
    for (let j = idx; j <= end; j++) {
      const b = candles[j];
      if (b.l <= stop) {
        const fill = stop - SLIP_STOP_ATR * a;
        done = { outcome: "stop", exitTime: b.t, exitPrice: fill, fees: MAKER + TAKER, j };
        break;
      }
      if (b.h >= target) {
        done = { outcome: "target", exitTime: b.t, exitPrice: target, fees: 2 * MAKER, j };
        break;
      }
    }
    if (!done && windowEnd <= candles.length - 1) {
      const b = candles[windowEnd];
      done = { outcome: "timeout", exitTime: b.t, exitPrice: b.c, fees: MAKER + TAKER, j: windowEnd };
    }
    if (done) {
      const gross = (done.exitPrice - entry) / entry;
      const hours = Math.max(0, (done.exitTime - candles[idx].t) / 3600);
      trades.push({
        ...base, status: "resolved", outcome: done.outcome,
        exitTime: done.exitTime, exitPrice: done.exitPrice,
        grossPct: gross, netPct: gross - done.fees - REPRESENTATIVE_FUNDING_PCT_PER_HOUR * hours,
      });
    } else {
      trades.push({ ...base, status: "open", outcome: null, exitTime: null, exitPrice: null, grossPct: null, netPct: null });
    }
  }
  return { trades };
}
