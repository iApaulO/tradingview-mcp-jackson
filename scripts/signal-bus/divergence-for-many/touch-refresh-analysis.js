#!/usr/bin/env node
// Tests a proposed alternative to Divergence-for-Many's fixed 200-bar glow expiry (iapaulo,
// 2026-07-30): "sustained interaction with a line should produce a sustained line" -- instead of
// expiring exactly 200 bars after PROMOTION regardless of what happens next (the real source's
// actual rule, confirmed against pine/divergence-for-many-relevance-gated.pine's
// expire_old_glows/draw_promoted_glow), a zone that keeps getting touched should stay "relevant"
// longer, decaying only after 200 bars pass with NO touch at all.
//
// touches.js's existing detectTouches() stops scanning at the zone's ORIGINAL expiresBarIdx
// (confirmedBarIdx + 200), so touches that would occur under a touch-refresh rule -- past that
// original window, but still within reach of sustained interaction -- were never even detected,
// let alone stored. This is a from-scratch re-scan, not a re-query of existing data.
//
// Rule tested: scan forward from confirmedBarIdx. After each touch ends, the "alive until" bar
// resets to (touch end + REFRESH_BARS). The zone is considered expired once REFRESH_BARS pass
// with no touch at all since the last one (or since confirmation, if never touched).
//
// Two things reported, directly answering both stated concerns:
//   1. Do "extended" touches (only reachable because sustained interaction pushed the window
//      past the ORIGINAL fixed expiry) behave differently from "core" touches (within the
//      original window) -- does staying relevant longer via refresh actually track something
//      real, or does it let stale/degraded zones back in?
//   2. Capacity/clutter: how many zones would still read "active" under touch-refresh RIGHT NOW
//      that are already "expired" under the current fixed rule -- the concrete version of "don't
//      want to pollute my screen with ancient irrelevant lines."
//
// Usage: node scripts/signal-bus/divergence-for-many/touch-refresh-analysis.js

import { DatabaseSync } from "node:sqlite";
import { writeFileSync, mkdirSync } from "fs";
import { execSync } from "child_process";
import { loadCandles } from "../../backtest/lib/load-candles.js";

const DB_PATH = new URL("../../../data/signal-bus/divergence-for-many.db", import.meta.url);
const REFRESH_BARS = 200; // same magnitude as the real badgeglow_expire_bars, applied as a rolling window instead of a fixed one

function gitCommit() {
  try {
    return execSync("git rev-parse HEAD", { cwd: new URL("../../../", import.meta.url), encoding: "utf8" }).trim();
  } catch {
    return "unknown";
  }
}

function isTouching(bar, zone) {
  return bar.l <= zone.price && bar.h >= zone.price;
}
function resolveOutcome(lastClose, zone) {
  return zone.side === "bullish" ? (lastClose > zone.price ? "held" : "broken") : lastClose < zone.price ? "held" : "broken";
}

// Re-scans a zone from its confirmation bar with a ROLLING window instead of the fixed one.
function detectTouchesWithRefresh(candles, zone, refreshBars) {
  const startBar = zone.confirmedBarIdx;
  const lastCandleIdx = candles.length - 1;
  const interactions = [];
  let current = null;
  let aliveUntil = Math.min(startBar + refreshBars, lastCandleIdx);

  for (let i = startBar; i <= aliveUntil; i++) {
    const bar = candles[i];
    if (isTouching(bar, zone)) {
      if (!current) current = { startBarIdx: i, startTime: bar.t, barsCount: 0 };
      current.barsCount++;
      current.endBarIdx = i;
      current.endTime = bar.t;
      current.lastClose = bar.c;
    } else if (current) {
      current.outcome = resolveOutcome(current.lastClose, zone);
      interactions.push(current);
      current = null;
      aliveUntil = Math.min(i + refreshBars, lastCandleIdx); // refresh the window from this touch's end
    }
    if (i === aliveUntil && !current) break; // no touch pending and window exhausted
  }
  if (current) {
    current.outcome = resolveOutcome(current.lastClose, zone);
    current.ongoing = aliveUntil === lastCandleIdx;
    interactions.push(current);
  }
  return { touches: interactions, finalAliveUntilBarIdx: aliveUntil };
}

async function main() {
  const db = new DatabaseSync(DB_PATH, { readOnly: true });
  const zones = db.prepare(`SELECT id, timeframe, side, price, confirmed_bar_idx, expires_bar_idx, status FROM zones`).all();
  db.close();

  const byTf = new Map();
  for (const z of zones) { if (!byTf.has(z.timeframe)) byTf.set(z.timeframe, []); byTf.get(z.timeframe).push(z); }

  let coreTouches = [], extendedTouches = [];
  let stillActiveUnderRefreshButExpiredUnderFixed = 0;
  let totalZones = 0;
  const nowByTf = {};

  for (const [tf, zonesInTf] of byTf) {
    const candles = await loadCandles(tf);
    nowByTf[tf] = candles.length - 1;
    for (const z of zonesInTf) {
      totalZones++;
      const zoneObj = { side: z.side, price: z.price, confirmedBarIdx: z.confirmed_bar_idx };
      const { touches, finalAliveUntilBarIdx } = detectTouchesWithRefresh(candles, zoneObj, REFRESH_BARS);
      for (const t of touches) {
        const record = { timeframe: tf, side: z.side, outcome: t.outcome, barsCount: t.barsCount };
        if (z.expires_bar_idx != null && t.startBarIdx > z.expires_bar_idx) extendedTouches.push(record);
        else coreTouches.push(record);
      }
      // detectTouchesWithRefresh clamps aliveUntil to the last available candle -- it lands
      // EXACTLY there only when the true (unclamped) window hadn't run out yet, i.e. the zone is
      // still genuinely alive under the refresh rule as of "now." Any earlier value means the
      // rolling window actually ran out (200 bars of silence) before data did.
      const stillAliveUnderRefresh = finalAliveUntilBarIdx === candles.length - 1;
      if (z.status === "expired" && stillAliveUnderRefresh) stillActiveUnderRefreshButExpiredUnderFixed++;
    }
  }

  function holdRate(arr) { return arr.length ? arr.filter((t) => t.outcome === "held").length / arr.length : null; }

  console.log(`Total zones re-scanned: ${totalZones}\n`);
  console.log("=== Core vs. extended-by-refresh touch behavior ===");
  console.log(`  Core touches (within original 200-bar window):     n=${coreTouches.length}  hold_rate=${(holdRate(coreTouches) * 100).toFixed(1)}%`);
  console.log(`  Extended touches (only reachable via refresh):     n=${extendedTouches.length}  hold_rate=${extendedTouches.length ? (holdRate(extendedTouches) * 100).toFixed(1) + "%" : "n/a"}`);
  console.log(`\n=== Capacity / clutter check ===`);
  console.log(`  Zones marked "expired" under the fixed rule but still touch-refresh-active right now: ${stillActiveUnderRefreshButExpiredUnderFixed} of ${totalZones}`);

  const out = {
    totalZones,
    coreTouchCount: coreTouches.length,
    coreHoldRate: holdRate(coreTouches),
    extendedTouchCount: extendedTouches.length,
    extendedHoldRate: holdRate(extendedTouches),
    stillActiveUnderRefreshButExpiredUnderFixed,
    refreshBars: REFRESH_BARS,
    git_commit: gitCommit(),
    generated_at: new Date().toISOString(),
  };
  const RESULTS_DIR = new URL("results/", import.meta.url);
  mkdirSync(RESULTS_DIR, { recursive: true });
  const fname = `touch_refresh_analysis_${out.generated_at.replace(/[:.]/g, "-")}.json`;
  writeFileSync(new URL(fname, RESULTS_DIR), JSON.stringify(out, null, 2));
  console.log(`\nSaved: ${new URL(fname, RESULTS_DIR).pathname.replace(/^\/([A-Z]:)/, "$1")}`);
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
