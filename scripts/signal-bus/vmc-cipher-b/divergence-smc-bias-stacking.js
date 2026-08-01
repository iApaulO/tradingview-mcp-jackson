#!/usr/bin/env node
// Direct follow-up to §31 (the daily-timeframe Cipher B regular divergence finding that cleared
// real costs -- the second finding in this project to do so, after #27b): does aligning that entry
// with SMC's own prevailing structural bias (BOS/CHoCH, same convention already established in
// cross-confluence/breakout-bias-backtest.js) compound or hurt the edge?
//
// Two readings tested, since divergence is a REVERSAL signal and it isn't obvious in advance which
// direction "helps" -- decided empirically, not assumed:
//   - "with-bias": SMC's current same-timeframe bias already agrees with the divergence's own
//     direction (e.g. a bearish divergence firing while SMC bias is already bearish -- confirms an
//     already-recognized downtrend rather than calling a fresh top).
//   - "against-bias": SMC's current bias is the OPPOSITE of the divergence's direction (e.g. a
//     bearish divergence firing during a bullish SMC bias -- the classic "catching exhaustion at
//     the top of an uptrend" reading most divergence trading theory describes).
//
// Bias source: same-timeframe (1d) SMC structure_events, swing scope (the primary scope
// breakout-bias-backtest.js already established as cleaner-performing) -- but 1d swing only has 19
// regime changes over the whole 8.95-year history, extremely coarse relative to divergence's own
// ~4.4 events/year. Internal scope (159 events on 1d) is reported alongside as a more responsive
// alternative, not a replacement -- both computed, neither assumed better without checking.
//
// KNOWN GOING IN: the base population here is already thin (44 total 1d divergence events, 37
// bearish/7 bullish per §31) -- splitting further by bias alignment will likely leave sub-30
// buckets. Reported honestly with that caveat rather than forced into a false-confidence verdict,
// same discipline as §31's own bullish-leg (n=7) treatment.
//
// Usage: node scripts/signal-bus/vmc-cipher-b/divergence-smc-bias-stacking.js [--r=1,1.5,2,3]

import { DatabaseSync } from "node:sqlite";
import { loadCandles } from "../../backtest/lib/load-candles.js";
import { computeMetrics } from "../../backtest/lib/metrics.js";
import { applyCosts, FEE_TIERS, REPRESENTATIVE_FUNDING_PCT_PER_HOUR } from "../../backtest/lib/costs.js";
import { computeVmcCipherB } from "./calc.js";

const SMC_DB_PATH = new URL("../../../data/signal-bus/smc.db", import.meta.url);
const TF = "1d";
const ATR_LEN = 14;
const ATR_MULT = 0.6;
const MAX_HOLD_BARS = 200;
const args = Object.fromEntries(process.argv.slice(2).map((a) => a.replace(/^--/, "").split("=")));
const R_MULTIPLES = (args.r || "1,1.5,2,3").split(",").map(Number);
const FORWARD_BARS = [5, 10, 20, 40];

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

function biasAt(events, t) {
  if (!events || events.length === 0) return null;
  let lo = 0, hi = events.length - 1, ans = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (events[mid].time <= t) { ans = mid; lo = mid + 1; } else { hi = mid - 1; }
  }
  return ans === -1 ? null : events[ans].side;
}

function simulateFixedR(candles, entryIdx, side, stopPrice, targetPrice) {
  const endCheck = Math.min(candles.length - 1, entryIdx + MAX_HOLD_BARS);
  for (let j = entryIdx; j <= endCheck; j++) {
    const bar = candles[j];
    const hitStop = side === "long" ? bar.l <= stopPrice : bar.h >= stopPrice;
    const hitTarget = side === "long" ? bar.h >= targetPrice : bar.l <= targetPrice;
    if (hitStop) return { exitPrice: stopPrice, exitTime: bar.t, outcome: "stop" };
    if (hitTarget) return { exitPrice: targetPrice, exitTime: bar.t, outcome: "target" };
  }
  return null;
}
function mean(arr) { return arr.length ? arr.reduce((s, x) => s + x, 0) / arr.length : null; }
function pctCorrect(arr) { return arr.filter((x) => x > 0).length / arr.length; }
function expectancy(trades) { return trades.length ? trades.reduce((s, t) => s + t.pnlPct, 0) / trades.length : null; }

async function main() {
  const candles = await loadCandles(TF);
  const n = candles.length;
  const atr14 = atr(candles, ATR_LEN);
  const { zones } = computeVmcCipherB(candles);
  const regularZones = zones.filter((z) => z.kind === "regular");
  console.log(`${TF}: ${regularZones.length} Cipher B regular divergence events (${regularZones.filter((z) => z.side === "bearish").length} bearish, ${regularZones.filter((z) => z.side === "bullish").length} bullish)\n`);

  const db = new DatabaseSync(SMC_DB_PATH, { readOnly: true });
  const bySc = {};
  for (const scope of ["swing", "internal"]) {
    bySc[scope] = db.prepare(`SELECT side, time FROM structure_events WHERE scope = ? AND timeframe = ? ORDER BY time`).all(scope, TF);
  }
  db.close();
  console.log(`SMC 1d structure_events: swing=${bySc.swing.length}, internal=${bySc.internal.length}\n`);

  const confirmedParams = { takerFeePct: FEE_TIERS.confirmed_derivatives.takerFeePct, fundingPctPerHour: REPRESENTATIVE_FUNDING_PCT_PER_HOUR };

  for (const scope of ["swing", "internal"]) {
    console.log(`\n################ SMC bias scope: ${scope} ################`);
    const biasEvents = bySc[scope];

    const labeled = regularZones.map((z) => {
      const bias = biasAt(biasEvents, z.confirmedTime);
      return { ...z, bias, category: bias == null ? "no-bias-defined" : bias === z.side ? "with-bias" : "against-bias" };
    });

    console.log("Category counts (all sides):", Object.fromEntries(["with-bias", "against-bias", "no-bias-defined"].map((c) => [c, labeled.filter((z) => z.category === c).length])));
    console.log("Category counts (bearish only, the robustly-tested §31 subset):", Object.fromEntries(["with-bias", "against-bias", "no-bias-defined"].map((c) => [c, labeled.filter((z) => z.category === c && z.side === "bearish").length])));

    // ── Raw forward-return descriptive read (small n -- reported plainly, not claimed significant) ──
    console.log("\n-- Forward-return, correct-direction, by category (descriptive only given n) --");
    for (const category of ["with-bias", "against-bias"]) {
      const evs = labeled.filter((z) => z.category === category);
      for (const N of FORWARD_BARS) {
        const rets = [];
        for (const z of evs) {
          const i = z.confirmedBarIdx;
          if (i + N >= n) continue;
          const raw = (candles[i + N].c - candles[i].c) / candles[i].c;
          rets.push(z.side === "bearish" ? -raw : raw);
        }
        if (rets.length === 0) continue;
        console.log(`  ${category.padEnd(14)} N=${N}: n=${rets.length}  correct-dir=${(pctCorrect(rets) * 100).toFixed(1)}%  mean=${(mean(rets) * 100).toFixed(3)}%`);
      }
    }

    // ── Cost/capacity, same fixed R:R construction as §29/§30/§31 ──
    console.log("\n-- Cost/capacity (fixed R:R, 0.6x ATR(14), real costs) --");
    for (const rMult of R_MULTIPLES) {
      console.log(`  R=${rMult}:`);
      for (const category of ["with-bias", "against-bias"]) {
        const evs = labeled.filter((z) => z.category === category);
        const trades = [];
        for (const z of evs) {
          const i = z.confirmedBarIdx;
          const entryIdx = i + 1;
          if (entryIdx >= n || !Number.isFinite(atr14[i]) || atr14[i] <= 0) continue;
          const entryPrice = candles[entryIdx].o;
          const entryTime = candles[entryIdx].t;
          const side = z.side === "bullish" ? "long" : "short";
          const risk = ATR_MULT * atr14[i];
          const stopPrice = side === "long" ? entryPrice - risk : entryPrice + risk;
          const targetPrice = side === "long" ? entryPrice + rMult * risk : entryPrice - rMult * risk;
          const result = simulateFixedR(candles, entryIdx, side, stopPrice, targetPrice);
          if (!result) continue;
          const pnlPct = side === "long" ? (result.exitPrice - entryPrice) / entryPrice : (entryPrice - result.exitPrice) / entryPrice;
          trades.push({ side, entryTime, entryPrice, exitTime: result.exitTime, exitPrice: result.exitPrice, pnlPct });
        }
        if (trades.length === 0) { console.log(`    ${category.padEnd(14)} n=0`); continue; }
        const gross = computeMetrics(trades);
        const costed = applyCosts(trades, confirmedParams);
        const grossExp = expectancy(trades), costedExp = expectancy(costed);
        const thin = trades.length < 30 ? " (THIN, n<30 -- descriptive only)" : "";
        console.log(`    ${category.padEnd(14)} n=${String(trades.length).padEnd(4)} win=${(gross.win_rate * 100).toFixed(1)}%  PF=${gross.profit_factor?.toFixed(2)}  gross_exp=${(grossExp * 100).toFixed(4)}%/trade  costed_exp=${(costedExp * 100).toFixed(4)}%/trade${thin}`);
      }
    }
  }
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
