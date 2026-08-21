// MTF STATE ASSEMBLER — the whole stack, every rung, at any instant, with no lookahead.
//
// WHY THIS EXISTS. Until 2026-08-21 this project had NO shared cross-timeframe state layer. Eleven
// separate analysis scripts each re-implemented `available_at` independently, so every result was
// single-rung or an ad-hoc pair, and none of the logics actually wanted -- multi-timeframe
// confluence, co-occurrence, nesting, cascade -- had a foundation to stand on. iapaulo, 2026-08-21:
// "you need to be able to see all timeframes at once on the fly for all indicators so you can see
// the signals as they appear if we ever want multi time frame analysis or confluence or
// co occurance or nesting or any of the logics we have discussed." He is right; this is that layer.
//
// **THE ONE RULE THAT MAKES IT HONEST: `available_at`.** A rung contributes only its last bar whose
// CLOSE is at or before the query instant. A 1d bar stamped 00:00 is NOT knowable at 04:00 -- it
// closes at 24:00. Getting this wrong is not a small error: it hands every higher rung a look into
// its own future, and the resulting confluence would be spectacular and entirely fake. Every lookup
// here goes through `asOf()` and there is no other path to a rung's data.
//
// WHAT A STATE SNAPSHOT CONTAINS, per rung:
//   bar        the contributing bar {t, o, h, l, c} and its age in seconds at the query instant
//   smc        swingBias / internalBias, last structure event, count of unmitigated bullish/bearish OBs
//   boom       q1, trigger, q3, q4, q5, q6 and the most recent Boom event
//   ict        active (unbroken) buyside/sellside liquidity pools and whether price sits above/below
//
// USAGE
//   import { openMtf } from "./mtf-state.js";
//   const mtf = await openMtf("BTC", { rungs: ["1d","4h","1h"] });
//   const snap = mtf.at(Date.parse("2026-08-19T14:00:00Z") / 1000);
//   mtf.close();
//
// Or from the CLI, to read the whole stack at one moment:
//   node scripts/signal-bus/lib/mtf-state.js --instrument=BTC --at=2026-08-19T14:00:00Z

import { DatabaseSync } from "node:sqlite";
import { loadCandles } from "../../backtest/lib/load-candles.js";
import { computeSMC } from "../smc/calc.js";
import { computeBoomHunter } from "../boom-hunter/calc.js";
import { computeLiquidityPools } from "../ict/liquidity.js";
import { dbSuffix } from "./instrument.js";

export const RUNG_SECONDS = {
  "1w": 604800, "1d": 86400, "4h": 14400, "3h": 10800,
  "2h": 7200, "1h": 3600, "15m": 900, "5m": 300,
};
// THE HOUSE LADDER (house-stack.md): W/D/4H/3H/2H/1H/15m/5m, never a subset. The first version of
// this module defaulted to 1d/4h/1h, silently dropping 3h/2h/15m/5m -- all of which ARE built in the
// signal bus for BTC/ETH/SOL/XRP. Corrected 2026-08-21 at iapaulo's instruction. Instruments fetched
// 1h/1d-native only have no 15m/5m; openMtf skips rungs with no data and reports which.
export const HOUSE_LADDER = ["1w", "1d", "4h", "3h", "2h", "1h", "15m", "5m"];
export const DEFAULT_RUNGS = HOUSE_LADDER;

const BULL = 1, BEAR = -1;
const biasName = (b) => (b === BULL ? "bullish" : b === BEAR ? "bearish" : "none");

/**
 * Index of the last bar of `candles` whose CLOSE is at or before `t`.
 * A bar stamped `s` on a rung of `dur` seconds closes at `s + dur`, so the test is `s + dur <= t`.
 * Returns -1 when nothing on this rung has closed yet.
 */
export function asOf(candles, dur, t) {
  let lo = 0, hi = candles.length - 1, ans = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (candles[mid].t + dur <= t) { ans = mid; lo = mid + 1; } else hi = mid - 1;
  }
  return ans;
}

async function loadRung(instrument, tf) {
  // loadCandles THROWS on a missing file rather than returning empty, so instruments fetched
  // 1h/1d-native only (no 15m/5m) would abort the whole ladder. A missing rung is a normal,
  // reportable condition here -- it is surfaced via `skipped`, never swallowed into a silent gap.
  let candles;
  try { candles = await loadCandles(tf, instrument); }
  catch { return null; }
  if (!candles || !candles.length) return null;
  const smc = computeSMC(candles);
  const boom = computeBoomHunter(candles);
  let pools = [];
  try { pools = computeLiquidityPools(candles).pools; } catch { pools = []; }

  // structure events and boom events indexed by bar for O(1) "most recent at or before" walks
  const structAt = new Map();
  for (const e of smc.structureEvents) {
    if (!structAt.has(e.barIdx)) structAt.set(e.barIdx, []);
    structAt.get(e.barIdx).push(e);
  }
  const boomAt = new Map();
  for (const e of boom.events) {
    if (!boomAt.has(e.barIdx)) boomAt.set(e.barIdx, []);
    boomAt.get(e.barIdx).push(e);
  }
  // prefix scan: most recent structure event index at or before each bar
  const lastStruct = new Array(candles.length).fill(-1);
  const lastBoom = new Array(candles.length).fill(-1);
  for (let i = 0, s = -1, b = -1; i < candles.length; i++) {
    if (structAt.has(i)) s = i;
    if (boomAt.has(i)) b = i;
    lastStruct[i] = s; lastBoom[i] = b;
  }
  return { tf, dur: RUNG_SECONDS[tf], candles, smc, boom, pools, structAt, boomAt, lastStruct, lastBoom };
}

function snapshotRung(R, t) {
  const i = asOf(R.candles, R.dur, t);
  if (i < 0) return { available: false };
  const bar = R.candles[i];
  const px = bar.c;

  // --- SMC ---
  const si = R.lastStruct[i];
  const lastEvents = si >= 0 ? R.structAt.get(si) : null;
  const lastEvent = lastEvents ? lastEvents[lastEvents.length - 1] : null;
  let obBull = 0, obBear = 0;
  for (const ob of R.smc.orderBlocks) {
    if (ob.createdBarIdx > i) continue;                                  // not yet formed
    if (ob.mitigatedBarIdx !== null && ob.mitigatedBarIdx <= i) continue; // already dead
    if (ob.side === "bullish") obBull++; else obBear++;
  }

  // --- Boom Hunter ---
  const bi = R.lastBoom[i];
  const bEvents = bi >= 0 ? R.boomAt.get(bi) : null;
  const s = R.boom.series;

  // --- ICT liquidity: pools formed, not yet broken, and where price sits relative to them ---
  let buysideAbove = 0, sellsideBelow = 0, aboveSweptBuyside = false;
  for (const p of R.pools) {
    if (p.createdBarIdx > i) continue;
    const broken = p.brokenBarIdx !== null && p.brokenBarIdx <= i;
    if (p.side === "buyside") {
      if (!broken && p.bottom > px) buysideAbove++;
      if (broken && px > p.top) aboveSweptBuyside = true;
    } else if (!broken && p.top < px) sellsideBelow++;
  }

  return {
    available: true,
    bar: { t: bar.t, o: bar.o, h: bar.h, l: bar.l, c: bar.c },
    ageSec: t - (bar.t + R.dur),
    smc: {
      swingBias: biasName(R.smc.swingBias[i]),
      internalBias: biasName(R.smc.internalBias[i]),
      lastEvent: lastEvent ? { type: lastEvent.type, side: lastEvent.side, scope: lastEvent.scope, price: lastEvent.price, barsAgo: i - si } : null,
      activeBullishOBs: obBull,
      activeBearishOBs: obBear,
    },
    boom: {
      q1: s.q1[i], trigger: s.trigger[i], q3: s.q3[i], q4: s.q4[i], q5: s.q5[i], q6: s.q6[i],
      q5AtCeiling: s.q5[i] >= 105, q6AtCeiling: s.q6[i] >= 105, q5AtFloor: s.q5[i] <= -4,
      lastEvent: bEvents ? { types: bEvents.map((e) => e.type), barsAgo: i - bi } : null,
    },
    ict: { buysideAbove, sellsideBelow, aboveSweptBuyside },
  };
}

/** Open an MTF view for one instrument. Loads and computes every rung once, then serves snapshots. */
export async function openMtf(instrument, { rungs = DEFAULT_RUNGS } = {}) {
  const loaded = {};
  for (const tf of rungs) {
    if (!RUNG_SECONDS[tf]) throw new Error(`unknown rung '${tf}'; known: ${Object.keys(RUNG_SECONDS).join(", ")}`);
    const R = await loadRung(instrument, tf);
    if (R) loaded[tf] = R;
  }
  const skipped = rungs.filter((tf) => !loaded[tf]);
  if (!Object.keys(loaded).length) throw new Error(`no rung data for ${instrument}`);
  return {
    instrument,
    rungs: Object.keys(loaded),
    skipped,
    _loaded: loaded,
    /** Top-down levels standing near `price` at instant `t`. See htfContext(). */
    context(t, price, opts) { return htfContext(loaded, t, price, opts); },
    /** Full stack state at instant `t` (unix seconds). No rung can see past its own close. */
    at(t) {
      const out = { instrument, t, rungs: {} };
      for (const tf of Object.keys(loaded)) out.rungs[tf] = snapshotRung(loaded[tf], t);
      return out;
    },
    /** Iterate snapshots at every close of `baseTf` — the timeline every MTF study should walk. */
    *timeline(baseTf, { from = 0, to = Infinity } = {}) {
      const B = loaded[baseTf];
      if (!B) throw new Error(`base rung '${baseTf}' not loaded`);
      for (const bar of B.candles) {
        const t = bar.t + B.dur;                 // the instant this base bar closes
        if (t < from || t > to) continue;
        yield this.at(t);
      }
    },
    close() {},
  };
}

/**
 * TOP-DOWN CONTEXT — every higher-timeframe level standing near `price` at instant `t`.
 *
 * iapaulo, 2026-08-21: "thats the part that is missing is a top down analysis for the context and
 * probability of bottom up predictive signal forward." A bottom-up trigger (a Boom flag, a q6
 * excursion, an OB touch) says WHEN. It says nothing about WHERE that trigger sits in the larger
 * structure -- whether it is firing into weekly resistance or into open air. This returns the WHERE.
 *
 * Levels are drawn ONLY from rungs at or above `minRung`, and every one of them is filtered through
 * `asOf` so nothing that had not yet formed at `t` can appear. Distance is signed: positive = the
 * level sits ABOVE price (resistance for a long), negative = BELOW (support).
 */
// activeOnly DEFAULT REVERSED 2026-08-21 (#216). The first version hid mitigated blocks on the
// assumption they were dead levels. They are not: mitigated OBs beat matched placebos on reaction
// (Welch t = 2.93 to 12.03) and on same-bar rejection rate (z = 7.23 to 10.27) across two
// independent instrument groups, and they react with FLIPPED polarity -- the breaker behaviour.
// Hiding them was discarding real structure, so `activeOnly` now defaults to FALSE and mitigated
// levels carry a `flipped` flag naming the polarity they now act with.
export function htfContext(loadedRungs, t, price, { within = 0.05, rungs = null, activeOnly = false } = {}) {
  const out = [];
  const push = (rung, kind, level, extra = {}) => {
    if (!Number.isFinite(level) || level <= 0) return;
    const dist = (level - price) / price;
    if (Math.abs(dist) > within) return;
    out.push({ rung, kind, level, distPct: dist * 100, side: dist >= 0 ? "above" : "below", ...extra });
  };
  for (const tf of (rungs || Object.keys(loadedRungs))) {
    const R = loadedRungs[tf];
    if (!R) continue;
    const i = asOf(R.candles, R.dur, t);
    if (i < 0) continue;

    for (const e of R.smc.eqhEqlEvents || []) {
      if ((e.confirmBarIdx ?? e.barIdx ?? Infinity) > i) continue;   // not yet confirmed at t
      push(tf, e.side === "EQH" || e.type === "EQH" ? "EQH" : "EQL", e.level ?? e.price, { status: e.sweepStatus ?? null });
    }
    for (const ob of R.smc.orderBlocks) {
      if (ob.createdBarIdx > i) continue;
      const mitigated = ob.mitigatedBarIdx !== null && ob.mitigatedBarIdx <= i;
      // A MITIGATED order block is a dead level, not resistance. Including them by default buries
      // the live structure under decades of spent zones -- the first run of this function returned
      // 22 rows of which 20 were mitigated. `activeOnly` is the default for that reason.
      if (activeOnly && mitigated) continue;
      // A mitigated block is met from the OTHER side, so the edge price reaches first swaps too.
      const edge = mitigated
        ? (ob.side === "bearish" ? ob.barHigh : ob.barLow)
        : (ob.side === "bullish" ? ob.barHigh : ob.barLow);
      push(tf, `OB-${ob.side}${mitigated ? "-BREAKER" : ""}`, edge, {
        top: ob.barHigh, bottom: ob.barLow, scope: ob.scope,
        // #216: a broken block acts with flipped polarity -- broken bearish -> support, broken bullish -> resistance.
        flipped: mitigated ? (ob.side === "bearish" ? "support" : "resistance") : null,
      });
    }
    for (const p of R.pools) {
      if (p.createdBarIdx > i) continue;
      const broken = p.brokenBarIdx !== null && p.brokenBarIdx <= i;
      if (activeOnly && broken) continue;   // swept pools kept by default too (#216 applies to OBs; pools untested)
      push(tf, `liq-${p.side}${broken ? "-swept" : ""}`, p.side === "buyside" ? p.bottom : p.top, { top: p.top, bottom: p.bottom });
    }
    const si = R.lastStruct[i];
    if (si >= 0) for (const e of R.structAt.get(si)) push(tf, `${e.side}-${e.type}`, e.price, { scope: e.scope, barsAgo: i - si });
  }
  return out.sort((a, b) => Math.abs(a.distPct) - Math.abs(b.distPct));
}

// ---------------------------------------------------------------- CLI
if (import.meta.url === `file://${process.argv[1]?.replace(/\\/g, "/")}` || process.argv[1]?.endsWith("mtf-state.js")) {
  const args = Object.fromEntries(process.argv.slice(2).filter((a) => a.includes("=")).map((a) => a.replace(/^--/, "").split("=")));
  const inst = args.instrument || "BTC";
  const rungs = (args.rungs || HOUSE_LADDER.join(",")).split(",");
  const t = args.at ? Math.floor(Date.parse(args.at) / 1000) : null;
  const mtf = await openMtf(inst, { rungs });
  const when = t ?? (() => { const s = mtf.at(Math.floor(Date.now() / 1000)); return s.t; })();
  const snap = mtf.at(when);
  console.log(`MTF STATE — ${inst} @ ${new Date(when * 1000).toISOString()}   (available_at enforced: no rung sees past its own close)\n`);
  if (mtf.skipped.length) console.log(`  [no data for: ${mtf.skipped.join(", ")}]`);
  for (const tf of mtf.rungs) {
    const r = snap.rungs[tf];
    if (!r.available) { console.log(`  ${tf.padEnd(4)} no closed bar yet`); continue; }
    const e = r.smc.lastEvent, b = r.boom.lastEvent;
    console.log(`  ${tf.padEnd(4)} close ${String(r.bar.c).padStart(10)}  bar ${new Date(r.bar.t * 1000).toISOString().slice(5, 16)}  (${(r.ageSec / 3600).toFixed(1)}h old)`);
    console.log(`       SMC   swing=${r.smc.swingBias.padEnd(8)} internal=${r.smc.internalBias.padEnd(8)} OBs +${r.smc.activeBullishOBs}/-${r.smc.activeBearishOBs}` +
                `  last: ${e ? `${e.side} ${e.type} (${e.scope}) @${e.price} ${e.barsAgo} bars ago` : "none"}`);
    console.log(`       BOOM  q1=${r.boom.q1?.toFixed(1).padStart(6)} q5=${r.boom.q5?.toFixed(1).padStart(6)} q6=${r.boom.q6?.toFixed(1).padStart(6)}` +
                `  ${r.boom.q6AtCeiling ? "[q6 CEILING]" : ""}${r.boom.q5AtFloor ? "[q5 FLOOR]" : ""}  last: ${b ? `${b.types.join("/")} ${b.barsAgo} bars ago` : "none"}`);
    console.log(`       ICT   buyside pools above=${r.ict.buysideAbove}  sellside below=${r.ict.sellsideBelow}  above-swept-buyside=${r.ict.aboveSweptBuyside}`);
  }
  if (args.context !== undefined) {
    const px = Number(args.context) || snap.rungs[mtf.rungs[mtf.rungs.length - 1]]?.bar?.c;
    const within = Number(args.within || 0.05);
    console.log(`
  TOP-DOWN CONTEXT around ${px} (within ${(within * 100).toFixed(1)}%)${args.activeOnly !== undefined ? ", LIVE only" : ", incl. BREAKERS (#216: mitigated blocks still react, flipped)"}:`);
    const rows = mtf.context(when, px, { within, rungs: (args.ctxRungs || "1w,1d,4h").split(","), activeOnly: args.activeOnly !== undefined });
    if (!rows.length) console.log("    (no levels in range -- open air)");
    for (const r of rows.slice(0, 25)) {
      console.log(`    ${r.rung.padEnd(4)} ${r.kind.padEnd(24)} ${String(r.level).padStart(11)}  ${r.distPct >= 0 ? "+" : ""}${r.distPct.toFixed(2)}% ${r.side.padEnd(5)}${r.flipped ? "  now:" + r.flipped : ""}${r.status ? "  " + r.status : ""}${r.scope ? "  " + r.scope : ""}`);
    }
  }
  mtf.close();
}
