#!/usr/bin/env node
// Exploratory pass: what's the impact of enabling the 6 indicators the Commander default profile
// leaves disabled (CCI, Momentum, OBV, VW-MACD, CMF, MFI)? Read-only analysis -- does not touch
// the live Pine chart, rules.json, or the canonical signal-bus DB (data/signal-bus/
// divergence-for-many.db stays whatever build-historical.js last wrote under Commander defaults).
//
// IMPORTANT CAVEAT, stated once here rather than buried in a comment nobody reads: this tests
// ~8 configurations per timeframe. No significance/multiple-testing correction is applied (unlike
// the backtest program's strategy variants, which got the full Bonferroni/Holm/BH treatment after
// getting burned once). Treat any single "best-looking" configuration here as a HYPOTHESIS worth a
// real test, not a conclusion -- the same discipline that already caught two false leads this
// session (the 82-88% hold rate bug, the unconfirmed fee tier) applies here too.
//
// Usage: node scripts/signal-bus/divergence-for-many/indicator-sweep.js --tf=4h,1h

import { loadCandles } from "../../backtest/lib/load-candles.js";
import { computeDivergenceForMany, COMMANDER_DEFAULT_INDICATORS, ALL_IMPLEMENTED_INDICATORS } from "./calc.js";
import { computeAllTouches } from "./touches.js";

const args = Object.fromEntries(process.argv.slice(2).map((a) => a.replace(/^--/, "").split("=")));
const TFS = (args.tf || "4h,1h").split(",");

const EXTRA_INDICATORS = ALL_IMPLEMENTED_INDICATORS.filter((i) => !COMMANDER_DEFAULT_INDICATORS.includes(i));

function buildConfigs() {
  const configs = [{ label: "baseline (Commander 4)", indicators: COMMANDER_DEFAULT_INDICATORS, showlimit: 3, minRegDivs: 3 }];
  for (const extra of EXTRA_INDICATORS) {
    configs.push({ label: `+${extra} (5, showlimit=3)`, indicators: [...COMMANDER_DEFAULT_INDICATORS, extra], showlimit: 3, minRegDivs: 3 });
  }
  configs.push({ label: `all 10 (showlimit=3)`, indicators: ALL_IMPLEMENTED_INDICATORS, showlimit: 3, minRegDivs: 3 });
  // Bonus: the structural hypothesis from the discussion -- does proportionally scaling the
  // threshold with the pool size change the picture for the "all 10" case? 3/4 of 10 ~= 7-8.
  configs.push({ label: `all 10 (showlimit=7, proportional)`, indicators: ALL_IMPLEMENTED_INDICATORS, showlimit: 7, minRegDivs: 7 });
  return configs;
}

async function runOne(candles, config) {
  const { badges, zones } = computeDivergenceForMany(candles, {
    enabledIndicators: config.indicators,
    showlimit: config.showlimit,
    minRegDivs: config.minRegDivs,
  });
  computeAllTouches(candles, zones);
  const touches = zones.flatMap((z) => z.touches);
  const held = touches.filter((t) => t.outcome === "held").length;
  return {
    label: config.label,
    badges: badges.length,
    zones: zones.length,
    touches: touches.length,
    holdPct: touches.length ? (100 * held) / touches.length : null,
  };
}

async function main() {
  for (const tf of TFS) {
    const candles = await loadCandles(tf);
    console.log(`\n=== ${tf} (${candles.length.toLocaleString()} candles) ===`);
    console.log("config".padEnd(34) + "badges".padEnd(8) + "zones".padEnd(7) + "touches".padEnd(9) + "hold%");
    const baseline = await runOne(candles, buildConfigs()[0]);
    console.log(
      baseline.label.padEnd(34) + String(baseline.badges).padEnd(8) + String(baseline.zones).padEnd(7) + String(baseline.touches).padEnd(9) + baseline.holdPct?.toFixed(1),
    );
    for (const config of buildConfigs().slice(1)) {
      const r = await runOne(candles, config);
      const zoneDelta = r.zones - baseline.zones;
      const holdDelta = r.holdPct != null && baseline.holdPct != null ? r.holdPct - baseline.holdPct : null;
      console.log(
        r.label.padEnd(34) +
          String(r.badges).padEnd(8) +
          String(r.zones).padEnd(7) +
          String(r.touches).padEnd(9) +
          `${r.holdPct?.toFixed(1)}${holdDelta != null ? ` (${holdDelta >= 0 ? "+" : ""}${holdDelta.toFixed(1)})` : ""}` +
          `  [zones ${zoneDelta >= 0 ? "+" : ""}${zoneDelta}]`,
      );
    }
  }
  console.log(
    "\nReminder: ~8 configs x " + TFS.length + " timeframe(s) = " + 8 * TFS.length +
      " comparisons, no multiple-testing correction applied. Any single standout here is a hypothesis to re-test properly (Monte Carlo baseline + correction, same as the backtest program), not a settings change to make.",
  );
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
