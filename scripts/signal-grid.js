#!/usr/bin/env node
// Cross-timeframe signal grid: sweeps the watchlist across 15m/1H/4H/1D/1W, reading every
// on-chart indicator (ribbon, momentum, structure, divergence badges) via CDP, plus the
// independent Adaptive SuperTrend calc — and assembles one consolidated table.
//
// Read-only. Temporarily switches the live TradingView Desktop chart through each timeframe,
// then restores your original symbol/timeframe when done (same pattern as `tv brief`).
//
// Usage:
//   node scripts/signal-grid.js            # one sweep, print table, write signal-grid.json
//   node scripts/signal-grid.js --json      # print raw JSON instead of the table

import { readFileSync, writeFileSync } from "fs";
import * as chart from "../src/core/chart.js";
import * as data from "../src/core/data.js";
import { scanAdaptiveSuperTrend } from "./lib/adaptive-supertrend.js";

const JSON_ONLY = process.argv.includes("--json");

const RULES_PATH = new URL("../rules.json", import.meta.url);
const GRID_PATH = new URL("../signal-grid.json", import.meta.url);
const LIVE_PATH = new URL("../signal-grid-live.json", import.meta.url);

function writeLive(partial) {
  writeFileSync(LIVE_PATH, JSON.stringify(partial, null, 2));
}

// chartTf: what TradingView Desktop expects. stKey: what adaptive-supertrend.js's TF_TO_STEP expects.
const TIMEFRAMES = [
  { chartTf: "15", stKey: "15", label: "15m" },
  { chartTf: "60", stKey: "60", label: "1H" },
  { chartTf: "240", stKey: "240", label: "4H" },
  { chartTf: "D", stKey: "D", label: "1D" },
  { chartTf: "1W", stKey: "W", label: "1W" },
];

function loadWatchlist() {
  const rules = JSON.parse(readFileSync(RULES_PATH, "utf8"));
  return { watchlist: rules.watchlist || [], proxyMap: rules.supertrend_proxy || {} };
}

// Cipher A's own native definition (confirmed from source, pine/vmc-cipher-a-ribbon.pine):
// ribbonDir = ema8 < ema2. Only the slowest EMA vs. EMA2 -- not EMA1, and not a full-stack
// check. Correcting our earlier guess (a strict monotonic 8-EMA stack requirement), which was
// stricter than the real indicator and over-reported "mixed/flat" as a result.
function ribbonDirection(emas) {
  if (emas.some((v) => v == null || Number.isNaN(v))) return "unknown";
  return emas[7] < emas[1] ? "bullish" : "bearish"; // index 1 = EMA2, index 7 = EMA8
}

// Supplementary, not the indicator's own signal: is the full 8-EMA stack cleanly ordered
// (stronger-looking trend) or tangled even though direction (above) still resolves either way?
function ribbonStackShape(emas) {
  if (emas.some((v) => v == null || Number.isNaN(v))) return "unknown";
  let asc = true, desc = true;
  for (let i = 1; i < emas.length; i++) {
    if (emas[i] >= emas[i - 1]) desc = false;
    if (emas[i] <= emas[i - 1]) asc = false;
  }
  if (desc) return "clean_bullish_stack";
  if (asc) return "clean_bearish_stack";
  return "tangled";
}

function num(raw) {
  return raw != null ? parseFloat(String(raw).replace(/,/g, "").replace(/−/g, "-")) : NaN;
}

function extractRibbon(indicatorStudies) {
  const cipherA = indicatorStudies.find((s) => s.name.includes("Cipher A") || s.name.includes("Cipher_A"));
  if (!cipherA) return { found: false };
  const emas = [1, 2, 3, 4, 5, 6, 7, 8].map((i) => num(cipherA.values[`EMA ${i}`]));
  const firedSignals = Object.entries(cipherA.values)
    .filter(([k, v]) => !k.startsWith("EMA") && parseFloat(v) !== 0)
    .map(([k]) => k);
  return { found: true, ema_fast: emas[0], ema_slow: emas[7], direction: ribbonDirection(emas), stack_shape: ribbonStackShape(emas), signals_fired: firedSignals };
}

function findVal(values, substrLower) {
  const key = Object.keys(values).find((k) => k.toLowerCase().includes(substrLower));
  return key ? values[key] : undefined;
}

// "∅" is TradingView's na marker for this bar — most of Cipher B's plots (divergences, circles,
// Sommi flags/diamonds) only carry a real number on the bar they fire; na means "not firing now".
function isFiring(raw) {
  return raw != null && raw !== "∅" && !Number.isNaN(num(raw));
}

// Cipher B (VuManChu B Divergences, pine/vmc-cipher-b-divergences.pine) exposes a whole battery
// beyond WT/RSI: Money Flow, Stochastic RSI, Schaff Trend Cycle, four divergence families (WT
// regular + WT 2nd-range, RSI, Stoch), WT buy/sell circles, the "gold" warning circle, and Sommi
// higher-timeframe flags/diamonds. Pull all of it, not just WT direction.
function extractCipherB(indicatorStudies) {
  const cb = indicatorStudies.find((s) => s.name.includes("VuManChu B") || s.name.includes("Cipher_B") || s.name.includes("Cipher B"));
  if (!cb) return { found: false };
  const v = cb.values;

  const wt1 = num(findVal(v, "wt wave 1"));
  const wt2 = num(findVal(v, "wt wave 2"));
  const mfi = num(findVal(v, "rsimfi"));

  const signalMap = {
    wt_bull_div: "wt bullish divergence",
    wt_bear_div: "wt bearish divergence",
    wt_bull_div_2nd: "wt 2nd bullish divergence",
    wt_bear_div_2nd: "wt 2nd bearish divergence",
    rsi_bull_div: "rsi bullish divergence",
    rsi_bear_div: "rsi bearish divergence",
    stoch_bull_div: "stoch bullish divergence",
    stoch_bear_div: "stoch bearish divergence",
    wt_buy_circle: "buy circle",
    wt_sell_circle: "sell circle",
    div_buy_circle: "divergence buy circle",
    div_sell_circle: "divergence sell circle",
    gold_buy_DO_NOT_BUY: "gold",
    sommi_bull_flag: "sommi bullish flag",
    sommi_bear_flag: "sommi bearish flag",
    sommi_bull_diamond: "sommi bullish diamond",
    sommi_bear_diamond: "sommi bearish diamond",
  };
  const signals_firing = Object.entries(signalMap)
    .filter(([, substr]) => isFiring(findVal(v, substr)))
    .map(([name]) => name);

  return {
    found: true,
    wt1,
    wt2,
    wt_direction: wt1 > wt2 ? "bullish" : wt1 < wt2 ? "bearish" : "flat",
    wt_vwap: num(findVal(v, "vwap")), // fast-vs-slow WT spread (wt1 - wt2), Cipher B's own plot
    rsi: num(v["RSI"]),
    mfi,
    mfi_bias: Number.isNaN(mfi) ? "unknown" : mfi > 0 ? "bullish" : "bearish",
    stoch_k: num(findVal(v, "stoch k")),
    stoch_d: num(findVal(v, "stoch d")),
    schaff_tc: num(findVal(v, "schaff trend cycle 1")),
    signals_firing,
  };
}

function extractBoomHunter(indicatorStudies) {
  const boom = indicatorStudies.find((s) => s.name.includes("Boom"));
  if (!boom) return { found: false };
  return { found: true, quotient_1: num(boom.values["Quotient 1"]), quotient_2: num(boom.values["Quotient 2"]) };
}

function extractDivergence(lineStudies) {
  const divLines = lineStudies.find((s) => s.name.includes("Divergence for Many"));
  return { found: !!divLines, active_badge_levels: divLines?.horizontal_levels || [] };
}

function extractStructure(labelStudies) {
  const smc = labelStudies.find((s) => s.name.includes("Smart Money"));
  if (!smc || !smc.labels?.length) return { found: false };
  const recent = smc.labels.slice(-3).reverse(); // most recent first
  return { found: true, total_events_in_window: smc.total_labels, recent };
}

async function scanChartTimeframe(symbol, tf) {
  await chart.setSymbol({ symbol });
  await new Promise((r) => setTimeout(r, 900));
  await chart.setTimeframe({ timeframe: tf.chartTf });
  await new Promise((r) => setTimeout(r, 900));

  const [values, labels, lines, quote] = await Promise.all([
    data.getStudyValuesEnsured(),
    data.getPineLabels({ study_filter: "Smart Money", max_labels: 10 }),
    data.getPineLines({ study_filter: "Divergence for Many" }),
    data.getQuote({}),
  ]);

  const studies = values.studies || [];
  return {
    price: quote?.last ?? quote?.close ?? null,
    ribbon: extractRibbon(studies),
    cipher_b: extractCipherB(studies),
    boom_hunter: extractBoomHunter(studies),
    structure: extractStructure(labels.studies || []),
    divergence: extractDivergence(lines.studies || []),
  };
}

async function buildGrid() {
  const { watchlist, proxyMap } = loadWatchlist();
  const totalSteps = watchlist.length * TIMEFRAMES.length;
  const grid = { generated_at: new Date().toISOString(), symbols: {} };
  let completedSteps = 0;

  let originalSymbol, originalTimeframe;
  try {
    const s = await chart.getState();
    originalSymbol = s.symbol;
    originalTimeframe = s.resolution;
  } catch (_) {}

  writeLive({ status: "running", started_at: grid.generated_at, completed_steps: 0, total_steps: totalSteps, symbols: grid.symbols });

  for (const symbol of watchlist) {
    grid.symbols[symbol] = { timeframes: {} };

    // SuperTrend doesn't touch the chart at all (independent Bitstamp fetch) — kick off all
    // timeframes for this symbol concurrently instead of serializing them with the chart sweep.
    // Bitstamp doesn't list every TradingView-facing instrument (e.g. Coinbase Derivatives
    // futures), so this may resolve through rules.json's supertrend_proxy mapping instead.
    const proxySymbol = proxyMap[symbol] || symbol;
    const supertrendPromises = Object.fromEntries(
      TIMEFRAMES.map((tf) => [tf.label, scanAdaptiveSuperTrend(proxySymbol, tf.stKey).catch((err) => ({ error: err.message }))]),
    );

    for (const tf of TIMEFRAMES) {
      const chartData = await scanChartTimeframe(symbol, tf).catch((err) => ({ error: err.message }));
      const supertrend = await supertrendPromises[tf.label];
      if (supertrend && proxySymbol !== symbol) supertrend.proxy_symbol = proxySymbol;
      grid.symbols[symbol].timeframes[tf.label] = { ...chartData, supertrend };
      completedSteps++;

      const r = chartData.ribbon?.direction ?? "n/a";
      const st = supertrend?.error ? "n/a" : supertrend.direction;
      console.log(`  [${symbol}] ${tf.label} done — ribbon: ${r}, supertrend: ${st}`);

      writeLive({
        status: "running",
        started_at: grid.generated_at,
        completed_steps: completedSteps,
        total_steps: totalSteps,
        current: { symbol, timeframe: tf.label },
        symbols: grid.symbols,
      });
    }
  }

  if (originalSymbol) {
    try {
      await chart.setSymbol({ symbol: originalSymbol });
      if (originalTimeframe) await chart.setTimeframe({ timeframe: originalTimeframe });
    } catch (_) {}
  }

  writeLive({ status: "done", started_at: grid.generated_at, finished_at: new Date().toISOString(), completed_steps: totalSteps, total_steps: totalSteps, symbols: grid.symbols });

  return grid;
}

function printTable(grid) {
  for (const [symbol, { timeframes }] of Object.entries(grid.symbols)) {
    console.log(`\n${symbol}`);
    console.log(
      "TF".padEnd(5) + "Ribbon".padEnd(12) + "RSI".padEnd(6) + "MFI".padEnd(6) + "Stoch K/D".padEnd(11) +
      "STC".padEnd(6) + "WT".padEnd(9) + "SMC latest".padEnd(22) + "Div".padEnd(5) + "SuperTrend",
    );
    for (const [label, tf] of Object.entries(timeframes)) {
      const cb = tf.cipher_b;
      const ribbon = tf.ribbon?.direction ?? "n/a";
      const rsi = cb?.found ? cb.rsi.toFixed(1) : "n/a";
      const mfi = cb?.found ? cb.mfi.toFixed(1) : "n/a";
      const stoch = cb?.found ? `${cb.stoch_k.toFixed(0)}/${cb.stoch_d.toFixed(0)}` : "n/a";
      const stc = cb?.found ? cb.schaff_tc.toFixed(0) : "n/a";
      const wt = cb?.found ? cb.wt_direction : "n/a";
      const smcLatest = tf.structure?.recent?.[0] ? `${tf.structure.recent[0].text} @ ${tf.structure.recent[0].price}` : "n/a";
      const badges = tf.divergence?.active_badge_levels?.length ?? 0;
      const st = tf.supertrend?.error
        ? "n/a"
        : `${tf.supertrend.direction === "bullish" ? "▲" : "▼"} ${tf.supertrend.direction}`;
      console.log(
        label.padEnd(5) + ribbon.padEnd(12) + rsi.padEnd(6) + mfi.padEnd(6) + stoch.padEnd(11) +
        stc.padEnd(6) + wt.padEnd(9) + smcLatest.padEnd(22) + String(badges).padEnd(5) + st,
      );
      if (cb?.found && cb.signals_firing.length) {
        console.log("     ↳ Cipher B firing: " + cb.signals_firing.join(", "));
      }
    }
  }
  console.log();
}

async function main() {
  console.log("Sweeping 5 timeframes x " + loadWatchlist().length + " symbol(s) — progress below as each one finishes...\n");
  const grid = await buildGrid();
  writeFileSync(GRID_PATH, JSON.stringify(grid, null, 2));
  if (JSON_ONLY) {
    console.log(JSON.stringify(grid, null, 2));
  } else {
    printTable(grid);
    console.log(`Full detail written to: ${GRID_PATH.pathname.replace(/^\/([A-Z]:)/, "$1")}`);
  }
}

main().catch((err) => {
  console.error("Fatal:", err.message);
  process.exit(1);
});
