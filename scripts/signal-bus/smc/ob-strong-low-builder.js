// OB-IN-STRONG-LOW BUILDER — the single source of the population for the forward pre-registration
// (skills/ict-smc-trader/PREREGISTRATION-ob-strong-low-forward.md, committed 2026-08-21).
//
// Construction frozen from #211/#212: a BULLISH order block created on 4h while swingBias == BULLISH
// (Strong Low), entry next 4h bar open LONG, maker entry, 2.0x ATR(14) stop (taker + 0.15 ATR slip),
// 2R target (maker), 200-bar timeout, funding 0.00125%/hr.
//
// Reference is the PHASE-AVERAGED +0.3899% (#212), not the single-grid +0.6282% -- that was the
// luckiest of four grid alignments and using it as the benchmark would inflate the bar this must clear.
//
// Edge discipline: a trade whose 200-bar window runs off the data edge is returned OPEN with no exit,
// never marked to market and never recorded as resolved.

import { loadCandles } from "../../backtest/lib/load-candles.js";
import { computeSMC } from "./calc.js";
import { FEE_TIERS, REPRESENTATIVE_FUNDING_PCT_PER_HOUR } from "../../backtest/lib/costs.js";

const ATR_LEN = 14, ATR_MULT = 2.0, R_MULT = 2, HOLD_BARS = 200, SLIP_STOP_ATR = 0.15;
const TAKER = FEE_TIERS.bitunix_futures_vip1.takerFeePct;
const MAKER = FEE_TIERS.bitunix_futures_vip1.makerFeePct;
const BULL = 1;

export const OB_SL_REF = { win: 0.36, net: 0.003899, rows: "#211 #212", tier: "pre-registered-forward" };
export const OB_SL_INSTRUMENTS = ["BTC", "ETH", "SOL", "XRP", "BNB", "ADA", "LTC", "LINK"];

function atrSeries(c, L) {
  const tr = c.map((x, i) => (i === 0 ? x.h - x.l : Math.max(x.h - x.l, Math.abs(x.h - c[i - 1].c), Math.abs(x.l - c[i - 1].c))));
  const o = new Array(c.length).fill(NaN);
  let s = 0; for (let i = 0; i < L; i++) s += tr[i];
  o[L - 1] = s / L;
  for (let i = L; i < c.length; i++) o[i] = (o[i - 1] * (L - 1) + tr[i]) / L;
  return o;
}

export async function buildObStrongLow(instrument) {
  let c;
  try { c = await loadCandles("4h", instrument); } catch { return { trades: [] }; }
  if (!c || c.length < 500) return { trades: [] };
  const atr = atrSeries(c, ATR_LEN);
  const { orderBlocks, swingBias } = computeSMC(c);
  const trades = [];

  for (const ob of orderBlocks) {
    if (ob.side !== "bullish") continue;
    const sig = ob.createdBarIdx;
    if (swingBias[sig] !== BULL) continue;              // must be inside Strong Low
    const idx = sig + 1;
    if (idx >= c.length) continue;
    const a = atr[idx];
    if (!Number.isFinite(a) || a <= 0) continue;

    const entry = c[idx].o, stop = entry - ATR_MULT * a, target = entry + R_MULT * ATR_MULT * a;
    const windowEnd = idx + HOLD_BARS, end = Math.min(c.length - 1, windowEnd);
    const base = {
      instrument, timeframe: "4h", side: "long",
      signalTime: c[sig].t, entryTime: c[idx].t, entryPrice: entry,
      stopPrice: stop, targetPrice: target, riskPct: (ATR_MULT * a) / entry,
    };

    let done = null;
    for (let j = idx; j <= end; j++) {
      const b = c[j];
      if (b.l <= stop) { done = { outcome: "stop", t: b.t, px: stop - SLIP_STOP_ATR * a, fees: MAKER + TAKER }; break; }
      if (b.h >= target) { done = { outcome: "target", t: b.t, px: target, fees: 2 * MAKER }; break; }
    }
    if (!done && windowEnd <= c.length - 1) done = { outcome: "timeout", t: c[windowEnd].t, px: c[windowEnd].c, fees: MAKER + TAKER };

    if (done) {
      const gross = (done.px - entry) / entry;
      const hours = Math.max(0, (done.t - c[idx].t) / 3600);
      trades.push({ ...base, status: "resolved", outcome: done.outcome, exitTime: done.t, exitPrice: done.px,
        grossPct: gross, netPct: gross - done.fees - REPRESENTATIVE_FUNDING_PCT_PER_HOUR * hours });
    } else {
      trades.push({ ...base, status: "open", outcome: null, exitTime: null, exitPrice: null, grossPct: null, netPct: null });
    }
  }
  return { trades };
}
