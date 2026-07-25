// Multiple-testing corrections for a family of Monte-Carlo significance p-values (see
// monte-carlo.js). A single p<0.05 result found after trying N strategy variants in the same
// research session is weaker evidence than a single pre-registered p<0.05 -- this is critique
// issue #6 from the 2026-07-25 institutional-quant-lens review, made concrete rather than just
// flagged. Three standard corrections, most to least conservative:
//   - Bonferroni: reject test i if p_i < alpha/n. Controls family-wise error rate, simplest,
//     most conservative (assumes worst case: all tests independent AND all nulls true).
//   - Holm-Bonferroni: step-down version of Bonferroni -- less conservative, still controls FWER
//     exactly, no independence assumption needed. Should always reject a superset of what plain
//     Bonferroni rejects (or the same set).
//   - Benjamini-Hochberg: controls the FALSE DISCOVERY RATE instead of FWER -- the standard
//     choice in large-scale multiple-testing (genomics, and increasingly factor/backtest
//     research per the Gu-Kelly-Xiu-adjacent literature) when some real effects are expected
//     among many tests. Most permissive of the three.

export function bonferroniCorrection(pValues, alpha = 0.05) {
  const n = pValues.length;
  const threshold = alpha / n;
  return pValues.map((p) => ({ p, threshold, significant: p < threshold }));
}

export function holmBonferroniCorrection(pValues, alpha = 0.05) {
  const n = pValues.length;
  const indexed = pValues.map((p, i) => ({ p, i })).sort((a, b) => a.p - b.p);
  const results = new Array(n);
  let stopped = false;
  for (let rank = 0; rank < n; rank++) {
    const threshold = alpha / (n - rank);
    const significant = !stopped && indexed[rank].p < threshold;
    if (!significant) stopped = true; // step-down: once one fails, all subsequent (larger p) fail too
    results[indexed[rank].i] = { p: indexed[rank].p, threshold, significant };
  }
  return results;
}

export function benjaminiHochbergCorrection(pValues, alpha = 0.05) {
  const n = pValues.length;
  const indexed = pValues.map((p, i) => ({ p, i })).sort((a, b) => a.p - b.p);
  // Find the largest rank k where p_(k) <= (k/n)*alpha; every test at or below that rank is significant.
  let largestSignificantRank = -1;
  for (let rank = 0; rank < n; rank++) {
    const threshold = (alpha * (rank + 1)) / n;
    if (indexed[rank].p <= threshold) largestSignificantRank = rank;
  }
  const results = new Array(n);
  for (let rank = 0; rank < n; rank++) {
    const threshold = (alpha * (rank + 1)) / n;
    results[indexed[rank].i] = { p: indexed[rank].p, threshold, significant: rank <= largestSignificantRank };
  }
  return results;
}
