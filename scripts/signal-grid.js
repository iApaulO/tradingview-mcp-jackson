#!/usr/bin/env node
// Cross-timeframe signal grid: sweeps the watchlist across 15m/1H/4H/1D/1W, reading every
// on-chart indicator (ribbon, structure, divergence badges) via CDP, plus the independent
// Adaptive SuperTrend calc — and assembles one consolidated table.
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

// chartTf: what TradingView Desktop expects. stKey: what adaptive-supertrend.js's TF_TO_STEP expects.
const TIMEFRAMES = [
  { chartTf: "15", stKey: "15", label: "15m" },
  { chartTf: "60", stKey: "60", label: "1H" },
  { chartTf: "240", stKey: "240", label: "4H" },
  { chartTf: "D", stKey: "D", label: "1D" },
  { chartTf: "1W", stKey: "W", label: "1W" },
];

// Cipher B / Boom Hunter Pro confirmed (2026-07-20, via direct DOM inspection of the Data Window
// panel) to emit zero plot() values with display=data_window — their section headers show up but
// with no rows underneath. That's baked into the script, not a user-facing toggle. So they're
// visual-only for now and excluded here; screenshot the chart if you need their read.
const NO_DATA_WINDOW_OUTPUT = ["VuManChu Cipher B Divergences", "Boom Hunter Pro"];

function loadWatchlist() {
  const rules = JSON.parse(readFileSync(RULES_PATH, "utf8"));
  return rules.watchlist || [];
}

function ribbonDirection(emas) {
  if (emas.some((v) => v == null || Number.isNaN(v))) return "unknown";
  let asc = true, desc = true;
  for (let i = 1; i < emas.length; i++) {
    if (emas[i] >= emas[i - 1]) desc = false;
    if (emas[i] <= emas[i - 1]) asc = false;
  }
  if (desc) return "bullish"; // fast EMA above slow EMA, stacked descending
  if (asc) return "bearish";
  return "mixed/flat";
}

function extractRibbon(indicatorStudies) {
  const cipherA = indicatorStudies.find((s) => s.name.includes("Cipher A") || s.name.includes("Cipher_A"));
  if (!cipherA) return { found: false };
  const emas = [1, 2, 3, 4, 5, 6, 7, 8].map((i) => {
    const raw = cipherA.values[`EMA ${i}`];
    return raw != null ? parseFloat(String(raw).replace(/,/g, "")) : NaN;
  });
  const firedSignals = Object.entries(cipherA.values)
    .filter(([k, v]) => !k.startsWith("EMA") && parseFloat(v) !== 0)
    .map(([k]) => k);
  return { found: true, ema_fast: emas[0], ema_slow: emas[7], direction: ribbonDirection(emas), signals_fired: firedSignals };
}

function extractDivergence(indicatorStudies, lineStudies) {
  const divStudy = indicatorStudies.find((s) => s.name.includes("Divergence for Many"));
  const divLines = lineStudies.find((s) => s.name.includes("Divergence for Many"));
  return {
    found: !!divStudy,
    active_badge_levels: divLines?.horizontal_levels || [],
  };
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
    data.getStudyValues(),
    data.getPineLabels({ max_labels: 10 }),
    data.getPineLines(),
    data.getQuote({}),
  ]);

  return {
    price: quote?.last ?? quote?.close ?? null,
    ribbon: extractRibbon(values.studies || []),
    structure: extractStructure(labels.studies || []),
    divergence: extractDivergence(values.studies || [], lines.studies || []),
  };
}

async function buildGrid() {
  const watchlist = loadWatchlist();
  const grid = { generated_at: new Date().toISOString(), symbols: {} };

  let originalSymbol, originalTimeframe;
  try {
    const s = await chart.getState();
    originalSymbol = s.symbol;
    originalTimeframe = s.resolution;
  } catch (_) {}

  for (const symbol of watchlist) {
    grid.symbols[symbol] = { timeframes: {} };
    for (const tf of TIMEFRAMES) {
      const [chartData, supertrend] = await Promise.all([
        scanChartTimeframe(symbol, tf).catch((err) => ({ error: err.message })),
        scanAdaptiveSuperTrend(symbol, tf.stKey).catch((err) => ({ error: err.message })),
      ]);
      grid.symbols[symbol].timeframes[tf.label] = { ...chartData, supertrend };
    }
  }

  if (originalSymbol) {
    try {
      await chart.setSymbol({ symbol: originalSymbol });
      if (originalTimeframe) await chart.setTimeframe({ timeframe: originalTimeframe });
    } catch (_) {}
  }

  grid.note = `Cipher B / Boom Hunter Pro not included — no Data Window output (${NO_DATA_WINDOW_OUTPUT.join(", ")}). Screenshot the chart for those.`;
  return grid;
}

function printTable(grid) {
  for (const [symbol, { timeframes }] of Object.entries(grid.symbols)) {
    console.log(`\n${symbol}`);
    console.log(
      "TF".padEnd(5) + "Ribbon".padEnd(12) + "SMC latest".padEnd(22) + "Div badges".padEnd(11) + "SuperTrend",
    );
    for (const [label, tf] of Object.entries(timeframes)) {
      const ribbon = tf.ribbon?.direction ?? "n/a";
      const smcLatest = tf.structure?.recent?.[0] ? `${tf.structure.recent[0].text} @ ${tf.structure.recent[0].price}` : "n/a";
      const badges = tf.divergence?.active_badge_levels?.length ?? 0;
      const st = tf.supertrend?.error
        ? "n/a"
        : `${tf.supertrend.direction === "bullish" ? "▲" : "▼"} ${tf.supertrend.direction}`;
      console.log(label.padEnd(5) + ribbon.padEnd(12) + smcLatest.padEnd(22) + String(badges).padEnd(11) + st);
    }
  }
  console.log(`\n${grid.note}\n`);
}

async function main() {
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
