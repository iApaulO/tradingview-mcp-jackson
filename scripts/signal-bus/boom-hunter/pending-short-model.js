#!/usr/bin/env node
// THE PENDING SHORT MODEL — iapaulo's construction, 2026-08-21.
//
// His words: "if that short were taken at the time of the flag it would have lost but taken in the
// context of a PENDING short and then the spike at 21aug 0400 becomes the EXECUTION of that short
// especially when there are multiple short flags on the 4h and prob on the other timeframes as well."
//
// **THIS IS A DIFFERENT CONSTRUCTION FROM EVERY SHORT TESTED IN THIS REGISTER.** #60a, #201, #202 and
// #215 all entered AT the flag bar and all lost. His model says the flag does not execute anything --
// it ARMS a short, and execution happens later when price SPIKES UP into it. Mechanically that is a
// resting SHORT LIMIT above the market, which is why maker pricing applies to the entry (it is the
// same "trigger order" he described in #206).
//
//   ARM      Boom `break_short` (senter3) fires on the rung
//   REST     a short limit at +k x ATR above the arming bar's close
//   EXECUTE  filled if price trades up to it within W bars; unfilled setups EXPIRE with no trade
//   MANAGE   stop 2.0x ATR above fill, target 2R below, 200-bar timeout
//
// **THE UNFILLED SETUPS ARE THE POINT AND MUST NOT BE COUNTED AS WINS.** A pending short that never
// fills is a trade that never happened -- not a saved loss. Fill rate is reported for exactly that
// reason: a model that only fires 10% of the time is a different animal from one that fires 80%.
//
// MTF CONFLUENCE, his second clause: at the arming bar, count how many OTHER rungs also have a
// `break_short` within the last CONFLUENCE_BARS of their own bars, using the shared MTF layer's
// `asOf` so no rung can contribute a flag that had not closed yet.
//
// CONTROLS, per the standing rules:
//   * immediate entry at the flag (the construction that failed) as the baseline it must beat
//   * a RANDOM SHORT null drawn from the same rung, matched by count (#210) -- because in a corpus
//     that rose 13x-96x, "shorts lose" is the default and any short arm must beat that, not zero.
//
// Existing data only, no fetching. 1h and 4h reported separately, never pooled (#204).

import { loadCandles } from "../../backtest/lib/load-candles.js";
import { computeBoomHunter } from "./calc.js";
import { asOf } from "../lib/mtf-state.js";
import { FEE_TIERS, REPRESENTATIVE_FUNDING_PCT_PER_HOUR } from "../../backtest/lib/costs.js";

const ATR_LEN = 14, ATR_MULT = 2.0, R_MULT = 2, HOLD_BARS = 200, SLIP_STOP_ATR = 0.15;
const WAIT_BARS = 24;                 // how long a pending short stays armed
const K_LEVELS = [1, 2];              // limit distance above the arm close, in ATR
const CONFLUENCE_BARS = 12;           // a flag on another rung counts if within this many of ITS bars
const MIN_N = 40, SEEDS = 300;
const TAKER = FEE_TIERS.bitunix_futures_vip1.takerFeePct;
const MAKER = FEE_TIERS.bitunix_futures_vip1.makerFeePct;
const INSTRUMENTS = ["BTC", "ETH", "SOL", "XRP", "BNB", "ADA", "LTC", "LINK"];
const OTHER_RUNGS = { "1h": ["4h", "1d"], "4h": ["1h", "1d"] };
const RUNG_SEC = { "1h": 3600, "4h": 14400, "1d": 86400 };

const mean = (xs) => (xs.length ? xs.reduce((s, x) => s + x, 0) / xs.length : NaN);
const sd = (xs) => { const m = mean(xs); return Math.sqrt(mean(xs.map((x) => (x - m) ** 2))); };
const tOf = (xs) => { if (xs.length < 2) return NaN; const s = sd(xs) * Math.sqrt(xs.length / (xs.length - 1)); return s > 0 ? mean(xs) / (s / Math.sqrt(xs.length)) : NaN; };

function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function atrSeries(c, L) {
  const tr = c.map((x, i) => (i === 0 ? x.h - x.l : Math.max(x.h - x.l, Math.abs(x.h - c[i - 1].c), Math.abs(x.l - c[i - 1].c))));
  const o = new Array(c.length).fill(NaN);
  let s = 0; for (let i = 0; i < L; i++) s += tr[i];
  o[L - 1] = s / L;
  for (let i = L; i < c.length; i++) o[i] = (o[i - 1] * (L - 1) + tr[i]) / L;
  return o;
}
const fund = (c, i, j) => REPRESENTATIVE_FUNDING_PCT_PER_HOUR * Math.max(0, (c[j].t - c[i].t) / 3600);

/** SHORT from `fillIdx` at `entry`. entryFee is maker for a resting limit, taker for a market fill. */
function shortFrom(c, atr, fillIdx, entry, entryFee) {
  const a = atr[fillIdx];
  if (!Number.isFinite(a) || a <= 0) return null;
  const st = entry + ATR_MULT * a, tg = entry - R_MULT * ATR_MULT * a;
  const end = Math.min(c.length - 1, fillIdx + HOLD_BARS);
  for (let j = fillIdx; j <= end; j++) {
    const b = c[j];
    if (b.h >= st) return { net: (entry - (st + SLIP_STOP_ATR * a)) / entry - entryFee - TAKER - fund(c, fillIdx, j), won: 0 };
    if (b.l <= tg) return { net: (entry - tg) / entry - entryFee - MAKER - fund(c, fillIdx, j), won: 1 };
  }
  if (end < fillIdx + HOLD_BARS) return null;
  const raw = (entry - c[end].c) / entry;
  return { net: raw - entryFee - TAKER - fund(c, fillIdx, end), won: raw > 0 ? 1 : 0 };
}

async function main() {
  console.log("PENDING SHORT MODEL — the flag ARMS a short; a resting limit above EXECUTES it.");
  console.log(`Arm on Boom break_short, rest a short limit at +k x ATR, ${WAIT_BARS}-bar expiry, 2R @ 2.0x ATR stop.`);
  console.log("Unfilled setups expire with NO trade and are never counted as wins -- fill rate reported.");
  console.log("Controls: immediate-entry baseline (the version that failed) and a random-short null.\n");

  for (const tf of ["1h", "4h"]) {
    const arms = { immediate: [], random: [] };
    for (const k of K_LEVELS) { arms[`pend_k${k}`] = []; arms[`pend_k${k}_conf`] = []; arms[`pend_k${k}_noconf`] = []; }
    let armed = 0, filled = 0, confArmed = 0;
    const nul = new Array(SEEDS).fill(0).map(() => []);

    for (const inst of INSTRUMENTS) {
      let c;
      try { c = await loadCandles(tf, inst); } catch { continue; }
      if (!c || c.length < 1000) continue;
      const atr = atrSeries(c, ATR_LEN);
      const { events } = computeBoomHunter(c);
      const flags = events.filter((e) => e.type === "break_short").map((e) => e.barIdx);

      // other-rung short flags, for the confluence clause
      const otherFlagTimes = {};
      for (const rtf of OTHER_RUNGS[tf]) {
        try {
          const rc = await loadCandles(rtf, inst);
          const re = computeBoomHunter(rc).events.filter((e) => e.type === "break_short");
          otherFlagTimes[rtf] = { candles: rc, bars: new Set(re.map((e) => e.barIdx)) };
        } catch { /* rung unavailable */ }
      }

      for (const i of flags) {
        armed++;
        const a = atr[i];
        if (!Number.isFinite(a) || a <= 0) continue;

        // confluence: does another rung ALSO show a recent short flag, available_at respected?
        let conf = 0;
        for (const rtf of Object.keys(otherFlagTimes)) {
          const { candles: rc, bars } = otherFlagTimes[rtf];
          const j = asOf(rc, RUNG_SEC[rtf], c[i].t);        // last bar of rtf CLOSED by this instant
          if (j < 0) continue;
          for (let m = 0; m <= CONFLUENCE_BARS; m++) if (bars.has(j - m)) { conf++; break; }
        }
        if (conf > 0) confArmed++;

        // baseline: immediate market short at the next bar's open
        const imm = shortFrom(c, atr, i + 1, c[i + 1]?.o ?? NaN, TAKER);
        if (imm) arms.immediate.push(imm);

        // pending: resting short limit above, filled only if price trades up to it
        for (const k of K_LEVELS) {
          const limit = c[i].c + k * a;
          let fill = -1;
          const end = Math.min(c.length - 1, i + WAIT_BARS);
          for (let j = i + 1; j <= end; j++) if (c[j].h >= limit) { fill = j; break; }
          if (fill < 0) continue;                            // expired unfilled -> no trade, correctly
          const t = shortFrom(c, atr, fill, limit, MAKER);   // resting limit => maker entry
          if (!t) continue;
          if (k === K_LEVELS[0]) filled++;
          arms[`pend_k${k}`].push(t);
          arms[`pend_k${k}${conf > 0 ? "_conf" : "_noconf"}`].push(t);
        }
      }

      // random-short null, matched to the immediate-arm count on this instrument
      const pool = [];
      for (let i = ATR_LEN + 1; i < c.length - HOLD_BARS - 1; i++) pool.push(i);
      const n = flags.length;
      for (let s = 0; s < SEEDS; s++) {
        const rnd = mulberry32(7000 + s * 7919 + inst.length + tf.length);
        for (let m = 0; m < n; m++) {
          const ix = pool[Math.floor(rnd() * pool.length)];
          const t = shortFrom(c, atr, ix + 1, c[ix + 1]?.o ?? NaN, TAKER);
          if (t) nul[s].push(t.net);
        }
      }
    }

    const mN = nul.map(mean).sort((a, b) => a - b);
    const pct = (v) => (mN.filter((x) => x < v).length / mN.length * 100);
    console.log(`===== ${tf}   armed ${armed}   filled at k=${K_LEVELS[0]} ATR: ${filled} (${((filled / Math.max(1, armed)) * 100).toFixed(1)}%)   with cross-rung confluence: ${confArmed} (${((confArmed / Math.max(1, armed)) * 100).toFixed(1)}%)`);
    console.log(`  RANDOM SHORT null            net ${(mean(mN) * 100).toFixed(4)}%   [5th-95th ${(mN[Math.floor(SEEDS * 0.05)] * 100).toFixed(4)}% .. ${(mN[Math.floor(SEEDS * 0.95)] * 100).toFixed(4)}%]`);
    const row = (name, g) => {
      if (g.length < MIN_N) return console.log(`  ${name.padEnd(28)} n=${g.length} -- below n>=${MIN_N}`);
      const m = mean(g.map((x) => x.net));
      console.log(`  ${name.padEnd(28)} n=${String(g.length).padStart(5)}  win ${((g.filter((x) => x.won).length / g.length) * 100).toFixed(1).padStart(5)}%  net ${(m * 100).toFixed(4).padStart(10)}%  t ${tOf(g.map((x) => x.net)).toFixed(2).padStart(6)}  vs null ${pct(m).toFixed(1)}%`);
    };
    row("IMMEDIATE at flag [baseline]", arms.immediate);
    for (const k of K_LEVELS) {
      row(`PENDING limit +${k} ATR`, arms[`pend_k${k}`]);
      row(`  + cross-rung confluence`, arms[`pend_k${k}_conf`]);
      row(`  - no confluence`, arms[`pend_k${k}_noconf`]);
    }
    console.log("");
  }
  console.log("His model works if a PENDING arm beats BOTH the immediate baseline AND the random-short null.");
  console.log("Beating only the baseline means the limit is selecting better prices, not better trades.");
}

main().catch((e) => { console.error("Fatal:", e); process.exit(1); });
