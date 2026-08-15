#!/usr/bin/env node
// Live companion to structure-confluence-significance.js / cross-confluence-significance.js
// (2026-08-05). Those answer "does this pattern hold up across history" (Binance BTC/USDT,
// offline, calc.js-derived) -- this answers "is a new instance forming right now, and how is a
// tracked one resolving" on the actual live chart via CDP, same pattern as scripts/signal-grid.js
// (chart.js/data.js, sweep timeframes, restore original chart state when done).
//
// Detects three confluence types, same definitions/tolerance as the significance tests:
//   OB        -- a Divergence-for-Many badge falls within an SMC order block's [low, high] range.
//   structure -- a Divergence-for-Many badge is within PRICE_TOLERANCE_PCT of a BOS/CHoCH label price.
//   liquidity -- a Divergence-for-Many badge is within PRICE_TOLERANCE_PCT of an EQH/EQL label price.
// In every case, side must MATCH (bearish div badge with a bearish SMC zone, bullish with bullish) --
// fixed 2026-08-06 after iapaulo pointed out the badge/line colors are directional (purple badge +
// red glow-line = bearish, gold badge + green glow-line = bullish, confirmed against this session's
// live reads) and that the first version of this script was doing price-proximity matching only,
// with no side check at all -- meaning it was counting opposite-side (e.g. bearish badge sitting
// near a bullish order block) as "confluence," which isn't what any of the significance tests mean
// by the term and would have silently inflated the live zone count with meaningless pairs.
//
// Side handling: order-block side is inferred from price position (signal-grid.js's own
// inferOrderBlockSide, unchanged rationale -- an unmitigated box's side is reliably read from which
// way price has moved away from it, not guessed from color). Structure/EQH-EQL side uses the label
// textColor ABGR decode (green #089981 = bullish, red #F23645 = bearish) -- independently re-derived
// and cross-checked against real OHLCV timestamps this session. Divergence-for-Many badge side uses
// its fill color (`color` field, distinct from `textColor`): purple #9C27B0 = bearish, gold #FFEB3B =
// bullish -- confirmed directly by iapaulo, not inferred.
//
// Persists to data/signal-bus/cross-confluence-live.json (JSON, not smc.db -- this is a live/
// informal tracking log, not a backtested dataset; same live-vs-backtest separation signal-grid.js
// already uses for signal-grid-live.json vs the offline smc.db).
//
// Usage:
//   node scripts/signal-bus/cross-confluence/live-monitor.js
//   node scripts/signal-bus/cross-confluence/live-monitor.js --symbol=COINBASE:BTCUSD
//   node scripts/signal-bus/cross-confluence/live-monitor.js --timeframes=15,60,240,D

import { readFileSync, writeFileSync, existsSync } from "fs";
import * as chart from "../../../src/core/chart.js";
import * as data from "../../../src/core/data.js";

const STORE_PATH = new URL("../../../data/signal-bus/cross-confluence-live.json", import.meta.url);
const PRICE_TOLERANCE_PCT = 0.002; // matches confluence.js / both significance tests' flat tolerance

const args = Object.fromEntries(process.argv.slice(2).map((a) => a.replace(/^--/, "").split("=")));
const SYMBOL = args.symbol || null; // null = whatever's already loaded on the chart

// chartTf: TradingView Desktop's resolution string. label: this project's 8-tf ladder naming.
const ALL_TIMEFRAMES = [
  { chartTf: "5", label: "5m" },
  { chartTf: "15", label: "15m" },
  { chartTf: "60", label: "1h" },
  { chartTf: "120", label: "2h" },
  { chartTf: "180", label: "3h" },
  { chartTf: "240", label: "4h" },
  { chartTf: "D", label: "1d" },
  { chartTf: "1W", label: "1w" },
];
const TIMEFRAMES = args.timeframes
  ? ALL_TIMEFRAMES.filter((tf) => args.timeframes.split(",").includes(tf.chartTf))
  : ALL_TIMEFRAMES;

function loadStore() {
  if (!existsSync(STORE_PATH)) return { zones: {} };
  try {
    return JSON.parse(readFileSync(STORE_PATH, "utf8"));
  } catch {
    return { zones: {} };
  }
}
function saveStore(store) {
  writeFileSync(STORE_PATH, JSON.stringify(store, null, 2));
}

// ABGR-packed color -> RGB hex, same decode used throughout this session, cross-checked against
// real OHLCV timestamps (see header comment). #089981 = bullish/green, #F23645 = bearish/red.
function colorToSide(argbAsAbgr) {
  const n = argbAsAbgr >>> 0;
  const b = (n >> 16) & 0xff, g = (n >> 8) & 0xff, r = n & 0xff;
  const hex = `#${[r, g, b].map((x) => x.toString(16).padStart(2, "0")).join("")}`;
  if (hex === "#089981") return "bullish";
  if (hex === "#f23645") return "bearish";
  return "unknown";
}

// Divergence-for-Many badge fill color -> side. Distinct palette from SMC's own (purple/gold, not
// green/red) -- confirmed by iapaulo 2026-08-06: purple badge (+ red glow-line) = bearish, gold
// badge (+ green glow-line) = bullish.
function divBadgeColorToSide(argbAsAbgr) {
  const n = argbAsAbgr >>> 0;
  const b = (n >> 16) & 0xff, g = (n >> 8) & 0xff, r = n & 0xff;
  const hex = `#${[r, g, b].map((x) => x.toString(16).padStart(2, "0")).join("")}`;
  if (hex === "#9c27b0") return "bearish";
  if (hex === "#ffeb3b") return "bullish";
  return "unknown";
}

function inferOrderBlockSide(box, currentPrice) {
  if (currentPrice == null) return "unknown";
  if (currentPrice > box.high) return "bullish";
  if (currentPrice < box.low) return "bearish";
  return "unknown";
}

function zoneKey(type, timeframe, side, price) {
  return `${type}:${timeframe}:${side}:${Math.round(price)}`;
}

function detectConfluenceZones({ boxes, labels, divLabels, currentPrice, timeframe }) {
  const zones = [];

  const smcBoxes = boxes.find((s) => s.name.includes("Smart Money"))?.all_boxes || [];
  const smcLabels = labels.find((s) => s.name.includes("Smart Money"))?.labels || [];
  const badges = (divLabels.find((s) => s.name.includes("Divergence for Many"))?.labels || [])
    .map((b) => ({ price: b.price, side: divBadgeColorToSide(b.color) }))
    .filter((b) => b.price != null && b.side !== "unknown");

  for (const badge of badges) {
    for (const box of smcBoxes) {
      if (badge.price >= box.low && badge.price <= box.high) {
        const side = inferOrderBlockSide(box, currentPrice);
        if (side === "unknown" || side !== badge.side) continue;
        zones.push({ type: "OB", timeframe, side, price: badge.price, low: box.low, high: box.high, divLine: badge.price });
      }
    }
    for (const lbl of smcLabels) {
      if (lbl.price == null) continue;
      const isStructure = lbl.text === "BOS" || lbl.text === "CHoCH";
      const isLiquidity = lbl.text === "EQH" || lbl.text === "EQL";
      if (!isStructure && !isLiquidity) continue;
      if (Math.abs(lbl.price - badge.price) / badge.price > PRICE_TOLERANCE_PCT) continue;
      const side = colorToSide(lbl.textColor);
      if (side === "unknown" || side !== badge.side) continue;
      zones.push({
        type: isStructure ? "structure" : "liquidity",
        timeframe, side, price: lbl.price, divLine: badge.price,
        sourceLabel: lbl.text,
      });
    }
  }
  return zones;
}

function classifyPosition(zone, currentPrice) {
  const low = zone.low ?? zone.price * (1 - PRICE_TOLERANCE_PCT);
  const high = zone.high ?? zone.price * (1 + PRICE_TOLERANCE_PCT);
  if (currentPrice >= low && currentPrice <= high) return "inside";
  return currentPrice > high ? "above" : "below";
}

// Shared by both the auto-detected path and the "re-check every stored zone" pass below -- a
// zone's status must update from real price movement whether or not this run's badge-matching
// happened to re-detect it fresh. Manually-added zones (e.g. multi-event narratives like a CHoCH
// break + EQH confirmation, which isn't a single badge-proximity match the auto-detector produces)
// only ever get tracked through this path.
function applyZoneUpdate(entry, currentPrice, now) {
  const lastPos = entry.history[entry.history.length - 1]?.position;
  const position = classifyPosition(entry, currentPrice);
  entry.history.push({ time: now, price: currentPrice, position });
  const everInside = entry.history.some((h) => h.position === "inside");
  if (everInside && position !== "inside") {
    const brokeThrough = (entry.side === "bullish" && position === "below") || (entry.side === "bearish" && position === "above");
    entry.status = brokeThrough ? "broken" : "held";
  } else if (position === "inside") {
    entry.status = "testing";
  }
  return lastPos !== position;
}

async function scanTimeframe(tf) {
  await chart.setTimeframe({ timeframe: tf.chartTf });
  await new Promise((r) => setTimeout(r, 700));

  const [boxes, labels, divLabels, quote] = await Promise.all([
    data.getPineBoxes({ study_filter: "Smart Money", verbose: true }),
    data.getPineLabels({ study_filter: "Smart Money", max_labels: 200, verbose: true }),
    data.getPineLabels({ study_filter: "Divergence for Many", max_labels: 100, verbose: true }),
    data.getQuote({}),
  ]);
  const currentPrice = quote?.last ?? quote?.close ?? null;
  const zones = detectConfluenceZones({
    boxes: boxes.studies || [], labels: labels.studies || [], divLabels: divLabels.studies || [],
    currentPrice, timeframe: tf.label,
  });
  return { currentPrice, zones };
}

async function main() {
  let originalSymbol, originalTimeframe;
  try {
    const s = await chart.getState();
    originalSymbol = s.symbol;
    originalTimeframe = s.resolution;
  } catch (_) {}

  if (SYMBOL) {
    await chart.setSymbol({ symbol: SYMBOL });
    await new Promise((r) => setTimeout(r, 900));
  }

  const store = loadStore();
  const now = new Date().toISOString();
  let newCount = 0, updatedCount = 0;

  for (const tf of TIMEFRAMES) {
    const { currentPrice, zones } = await scanTimeframe(tf).catch((err) => {
      console.log(`  [${tf.label}] error: ${err.message}`);
      return { currentPrice: null, zones: [] };
    });
    if (currentPrice == null) continue;

    const touchedThisRun = new Set();

    for (const z of zones) {
      const key = zoneKey(z.type, z.timeframe, z.side, z.price);
      touchedThisRun.add(key);

      if (!store.zones[key]) {
        const position = classifyPosition(z, currentPrice);
        store.zones[key] = {
          ...z, first_seen: now, status: "watching",
          history: [{ time: now, price: currentPrice, position }],
        };
        newCount++;
        console.log(`  [${tf.label}] NEW ${z.type} ${z.side} zone @ ${z.price} (div line ${z.divLine})`);
      } else if (applyZoneUpdate(store.zones[key], currentPrice, now)) {
        updatedCount++;
      }
    }

    // Re-check every OTHER stored zone on this timeframe too (manually-added zones, or ones the
    // badge-matching pass didn't happen to re-detect this run) -- a zone's price/side/bounds are
    // fixed once added, so tracking its status against current price never needs re-detection.
    for (const [key, entry] of Object.entries(store.zones)) {
      if (entry.timeframe !== tf.label || touchedThisRun.has(key)) continue;
      if (applyZoneUpdate(entry, currentPrice, now)) updatedCount++;
    }
  }

  if (originalSymbol) {
    try {
      await chart.setSymbol({ symbol: originalSymbol });
      if (originalTimeframe) await chart.setTimeframe({ timeframe: originalTimeframe });
    } catch (_) {}
  }

  saveStore(store);

  const all = Object.values(store.zones);
  console.log(`\n${newCount} new zone(s), ${updatedCount} position change(s) this run.`);
  console.log(`Total tracked: ${all.length} (watching=${all.filter((z) => z.status === "watching").length}, ` +
    `testing=${all.filter((z) => z.status === "testing").length}, held=${all.filter((z) => z.status === "held").length}, ` +
    `broken=${all.filter((z) => z.status === "broken").length})`);
  console.log(`Store: ${STORE_PATH.pathname.replace(/^\/([A-Z]:)/, "$1")}`);
}

main().catch((err) => {
  console.error("Fatal:", err.message);
  process.exit(1);
});
