#!/usr/bin/env node
// Generates the cross-confluence analytics page: full-stack significance results
// (full-stack-confluence-significance.js) + live-tracked zones (live-monitor.js's
// cross-confluence-live.json), same template pattern as smc/build-analytics-page.js and
// divergence-for-many/build-analytics-page.js.
//
// Usage: node scripts/signal-bus/cross-confluence/build-analytics-page.js [--iterations=20000]

import { readFileSync, writeFileSync, existsSync } from "fs";
import { execSync } from "child_process";
import { runFullStackTest } from "./full-stack-confluence-significance.js";
import { runObStructureTest } from "./ob-structure-confluence-significance.js";
import { runLongObContinuationTest } from "./long-ob-continuation-significance.js";

const TEMPLATE_PATH = new URL("analytics-page-template.html", import.meta.url);
const OUTPUT_PATH = new URL("analytics-page.html", import.meta.url);
const LIVE_STORE_PATH = new URL("../../../data/signal-bus/cross-confluence-live.json", import.meta.url);

const args = Object.fromEntries(process.argv.slice(2).map((a) => a.replace(/^--/, "").split("=")));
const ITERATIONS = parseInt(args.iterations || "20000", 10);

function gitCommit() {
  try {
    return execSync("git rev-parse HEAD", { cwd: new URL("../../../", import.meta.url), encoding: "utf8" }).trim();
  } catch { return "unknown"; }
}

async function main() {
  console.log(`Running full-stack cross-confluence significance test (${ITERATIONS} iterations x 8 categories)...`);
  const result = runFullStackTest({ iterations: ITERATIONS });

  const categories = result.results.map((r) => ({
    name: r.name, n: r.n, touches: r.touches,
    holdRateIn: r.holdRate1 * 100, holdRateOut: r.holdRate0 * 100,
    gap: r.gap * 100,
    verdict: r.pR < 0.05 && r.pGap < 0.05 ? "SIGNIFICANT" : r.pR < 0.05 || r.pGap < 0.05 ? "mixed" : "null",
    pR: r.pR, pGap: r.pGap,
  }));

  console.log("Running OB + structure (CHoCH-or-BOS) confluence test across the ladder (internal scope)...");
  const obByTf = await runObStructureTest({ allTimeframes: true, scope: "internal" });
  const obRows = [];
  for (const run of Object.values(obByTf)) {
    for (const r of run.results) {
      const paired = r.paired, isolated = r.isolated;
      if (!paired || paired.n < 2 || paired.vsBaselineP == null) continue;
      const verdict = paired.vsBaselineP < 0.05 && (paired.vsIsolatedP == null || paired.vsIsolatedP < 0.05)
        ? "SIGNIFICANT" : paired.vsBaselineP < 0.05 || (paired.vsIsolatedP != null && paired.vsIsolatedP < 0.05)
        ? "mixed" : "null";
      obRows.push({
        timeframe: r.timeframe, side: r.side,
        nPaired: paired.n, pairedMfe: paired.meanMfe * 100, pairedVsBaselineP: paired.vsBaselineP, pairedVsIsolatedP: paired.vsIsolatedP ?? null,
        nIsolated: isolated?.n ?? 0, isolatedMfe: isolated?.meanMfe != null ? isolated.meanMfe * 100 : null,
        baselineMfe: r.baselineMfeMean * 100,
        verdict,
      });
    }
  }

  console.log("Running Boom Hunter Long -> OB -> Continuation sequence test...");
  const boomOut = await runLongObContinuationTest({});
  const boomCells = Object.entries(boomOut.results).map(([label, r]) => ({
    rMultiple: label,
    full: { n: r.fullStats.n, winRate: r.fullStats.winRate * 100 },
    partial: { n: r.partialStats.n, winRate: r.partialStats.winRate * 100 },
    neither: { n: r.neitherStats.n, winRate: r.neitherStats.winRate * 100 },
    vsNeitherP: r.vsNeither?.p ?? null,
    vsPartialP: r.vsPartial?.p ?? null,
    pairwise: Object.fromEntries(Object.entries(r.pairwise).map(([k, v]) => [k, { gap: v.realGap * 100, p: v.p, realA: v.realA * 100, realB: v.realB * 100 }])),
  }));

  let liveZones = [];
  const liveSymbol = args.symbol || "COINBASE:BTCUSD";
  if (existsSync(LIVE_STORE_PATH)) {
    const store = JSON.parse(readFileSync(LIVE_STORE_PATH, "utf8"));
    liveZones = Object.values(store.zones || {}).sort((a, b) => new Date(b.first_seen) - new Date(a.first_seen));
  }

  const sigCat = categories.find((c) => c.verdict === "SIGNIFICANT");
  const caveat = sigCat
    ? `${sigCat.name} (n=${sigCat.n}) clears p&lt;0.05 in isolation, but this is 1 of ${categories.length} simultaneous comparisons — at a 5% threshold you'd expect roughly ${(categories.length * 0.05).toFixed(1)} false positives by chance across this many tests. It's also unstable: a near-identical grouping tested separately (same signal pair, different inclusion boundary for a handful of triple-confluence zones) came back null. Treat as noise, not a finding, until it replicates on fresh data.`
    : null;

  const DATA = {
    meta: {
      zoneCount: result.zoneCount,
      touchCount: result.touchCount,
      iterations: result.iterations,
      gitCommit: gitCommit(),
      generatedAt: new Date().toISOString(),
      liveSymbol,
    },
    categories,
    caveat,
    liveZones,
    obStructure: {
      rows: obRows,
      window: 160,
      scope: "internal",
    },
    boomHunter: {
      cells: boomCells,
      preWindow: boomOut.preWindow,
      postWindow: boomOut.postWindow,
      priceTolerance: boomOut.priceTolerance,
    },
    methodNotes: [
      { mark: "+", text: "Every category tested in isolation against its own complement (not lumped into one \"any confluence\" binary), so a real per-category effect can't be diluted or hidden by weaker neighboring categories." },
      { mark: "－", text: "Backtest data is Binance BTC/USDT (2017–present); live-tracked zones above are on whatever symbol the monitor was last run against — check it's a real market, not a demo/paper instrument, before treating the two as comparable." },
      { mark: "－", text: "Confluence is dense: with EQH/EQL and BOS/CHoCH printing constantly, something is almost always within tolerance of a divergence badge. A single live instance matching a category is expected, not remarkable, unless that category itself tested significant in aggregate." },
      { mark: "－", text: "0.2% price tolerance throughout, matching every other proximity test in this project. A wider 0.6% re-test of the structure-only category diluted straight to the population baseline (53.9% vs 53.9%) rather than revealing a hidden effect." },
    ],
  };

  const template = readFileSync(TEMPLATE_PATH, "utf8");
  const output = template.replace("/*__DATA_JSON__*/", JSON.stringify(DATA));
  writeFileSync(OUTPUT_PATH, output);
  console.log(`Saved: ${OUTPUT_PATH.pathname.replace(/^\/([A-Z]:)/, "$1")}`);
}

main().catch((err) => {
  console.error("Fatal:", err.message);
  process.exit(1);
});
