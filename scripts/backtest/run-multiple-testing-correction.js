#!/usr/bin/env node
// Applies multiple-testing corrections (lib/multiple-testing.js) across the family of Monte
// Carlo significance tests actually run this session -- critique issue #6 from the 2026-07-25
// institutional-quant-lens review of the backtest program, made concrete rather than just
// flagged. A single p<0.05 found after trying 5 strategy variants needs a stricter bar than
// p<0.05 in isolation.
//
// The trial family is hand-curated below, not auto-discovered from results/, because re-running
// the SAME variant (e.g. re-running 4H long-short after a cost-model fix) isn't a new trial in
// the multiple-comparisons sense -- it's reproducing the same test. Each entry names the DISTINCT
// hypothesis tested and the results/ file its gross (uncosted) Monte Carlo p-value came from --
// gross, not costed, so all 5 are compared on the same basis (only supertrend-flip has been
// re-tested with costs so far; using costed figures for one and gross for the rest would bias
// the comparison).
//
// Usage: node scripts/backtest/run-multiple-testing-correction.js

import { readFileSync, writeFileSync, mkdirSync } from "fs";
import { bonferroniCorrection, holmBonferroniCorrection, benjaminiHochbergCorrection } from "./lib/multiple-testing.js";

const RESULTS_DIR = new URL("results/", import.meta.url);

const TRIAL_FAMILY = [
  { name: "supertrend-flip long-short (4H)", file: "harness_4h_long-short_2026-07-24T18-13-56-918Z.json" },
  { name: "supertrend-flip long-only (4H)", file: "harness_4h_long-only_2026-07-24T18-13-27-593Z.json" },
  { name: "supertrend-bb long-short (4H)", file: "harness_supertrend-bb_4h_long-short_2026-07-24T18-30-41-221Z.json" },
  { name: "supertrend-bb long-only (4H)", file: "harness_supertrend-bb_4h_long-only_2026-07-24T18-31-05-417Z.json" },
  { name: "mean-reversion long-short (4H)", file: "harness_mean-reversion_4h_long-short_2026-07-24T18-39-16-822Z.json" },
];

function main() {
  const entries = TRIAL_FAMILY.map(({ name, file }) => {
    const j = JSON.parse(readFileSync(new URL(file, RESULTS_DIR), "utf8"));
    return { name, file, p: j.monte_carlo.p_value_random_beats_real, net_return: j.full_period.net_return_pct };
  });
  const pValues = entries.map((e) => e.p);

  const bonferroni = bonferroniCorrection(pValues);
  const holm = holmBonferroniCorrection(pValues);
  const bh = benjaminiHochbergCorrection(pValues);

  console.log(`Multiple-testing correction across ${entries.length} distinct strategy variants tested this session (alpha=0.05):\n`);
  console.log("Variant".padEnd(38) + "raw p".padEnd(10) + "Bonferroni".padEnd(14) + "Holm".padEnd(14) + "Benjamini-Hochberg");
  const rows = entries.map((e, i) => ({
    ...e,
    bonferroni: bonferroni[i],
    holm: holm[i],
    bh: bh[i],
  }));
  for (const r of rows) {
    console.log(
      r.name.padEnd(38) +
        r.p.toFixed(4).padEnd(10) +
        (r.bonferroni.significant ? "SIG" : "not sig").padEnd(14) +
        (r.holm.significant ? "SIG" : "not sig").padEnd(14) +
        (r.bh.significant ? "SIG" : "not sig"),
    );
  }

  const anySignificant = rows.some((r) => r.bonferroni.significant || r.holm.significant || r.bh.significant);
  console.log(
    `\n${anySignificant ? "At least one variant survives correction." : "NONE of the " + rows.length + " variants remain significant under any correction."} Raw (uncorrected) alpha=0.05 threshold was passed by: ${entries.filter((e) => e.p < 0.05).map((e) => e.name).join(", ") || "none"}.`,
  );

  const result = {
    alpha: 0.05,
    trial_family_size: entries.length,
    generated_at: new Date().toISOString(),
    note:
      "p-values are GROSS (uncosted) Monte Carlo results, for apples-to-apples comparison across all 5 variants -- only supertrend-flip has costed re-tests so far (see ARCHITECTURE.md §6). Trial family is hand-curated (see TRIAL_FAMILY in this script), not auto-discovered -- re-runs of the same variant are not counted as separate trials.",
    entries: rows,
  };
  mkdirSync(RESULTS_DIR, { recursive: true });
  const fname = `multiple_testing_correction_${result.generated_at.replace(/[:.]/g, "-")}.json`;
  writeFileSync(new URL(fname, RESULTS_DIR), JSON.stringify(result, null, 2));
  console.log(`\nSaved: ${new URL(fname, RESULTS_DIR).pathname.replace(/^\/([A-Z]:)/, "$1")}`);
}

main();
