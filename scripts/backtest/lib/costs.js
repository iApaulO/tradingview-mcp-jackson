// Applies transaction-cost + funding drag to a trade list as a post-processing step, without
// touching simulate-trades.js's zero-cost mechanics run. Kept separate so every existing
// strategy/harness script gets costed metrics by adding one call, and so cost assumptions can be
// swept as a sensitivity BAND instead of being baked in as one "true" number nobody has verified
// (see ARCHITECTURE.md §6 critique, 2026-07-25 -- costs were the #1 fatal issue).
//
// Cost components:
//   - Round-trip taker fee: feePctPerSide charged on BOTH entry and exit (worst case: both fills
//     cross the spread/take liquidity; a maker-heavy execution would cost less -- not modeled,
//     conservative by design).
//   - Funding: Coinbase perpetual-style futures settle funding HOURLY (confirmed structurally via
//     Coinbase's own "Understanding Funding Rates" page content surfaced 2026-07-25 -- distinct
//     from the more common 8-hour funding cadence on many offshore perps). The funding RATE's
//     magnitude/sign is NOT modeled per-bar (no historical funding-rate series imported) --
//     applied here as a constant-magnitude drag against every position for every hour held,
//     deliberately pessimistic (real funding oscillates sign; this assumes it's always a cost,
//     never a tailwind) until real historical funding data is sourced.
//
// NEITHER the fee tier NOR the funding magnitude below is a confirmed, account-specific number --
// Coinbase's own fee-schedule and funding-rate pages both returned HTTP 403 to automated fetch
// (scraping blocked). The 0.60%/0.40% figure came from a third-party aggregator during research,
// is explicitly Coinbase's lowest-volume (<$10k/mo) tier, and may not match iapaulo's real tier.
// Use costSensitivitySweep() to see how sensitive a result is across a plausible range rather than
// trusting one point estimate -- and confirm the real tier from the Coinbase account dashboard
// when this needs to become a "net edge" claim rather than a sensitivity check.

export const FEE_TIERS = {
  // Coinbase's lowest tier (<$10k/mo trailing volume), per third-party aggregator, NOT
  // independently confirmed against Coinbase's own fee page. Worst-case anchor, not a confirmed number.
  retail_worst_case: { takerFeePct: 0.006, makerFeePct: 0.004 },
  // Illustrative mid-volume tier -- NOT sourced from Coinbase docs, a placeholder for sensitivity-band width only.
  mid_tier_illustrative: { takerFeePct: 0.0015, makerFeePct: 0.001 },
  // Illustrative high-volume/institutional tier -- same caveat.
  high_volume_illustrative: { takerFeePct: 0.0002, makerFeePct: 0 },
};

// Widely-cited cross-exchange BTC perp funding baseline (~0.01% per 8h == 0.00125%/hr), used ONLY
// as a sensitivity anchor -- not sourced from Coinbase's own historical funding data (not imported).
export const REPRESENTATIVE_FUNDING_PCT_PER_HOUR = 0.0000125;

export function applyCosts(trades, { takerFeePct = 0, fundingPctPerHour = 0 } = {}) {
  return trades.map((t) => {
    const hoursHeld = Math.max(0, (t.exitTime - t.entryTime) / 3600);
    const roundTripFee = 2 * takerFeePct; // entry + exit, worst case both taker
    const fundingDrag = fundingPctPerHour * hoursHeld; // pessimistic: always a cost, never a tailwind
    const costPct = roundTripFee + fundingDrag;
    return { ...t, pnlPct: t.pnlPct - costPct, gross_pnlPct: t.pnlPct, cost_pct_applied: costPct };
  });
}

export function costSensitivitySweep(trades) {
  const scenarios = {
    gross_zero_cost: { takerFeePct: 0, fundingPctPerHour: 0 },
    retail_worst_case: { takerFeePct: FEE_TIERS.retail_worst_case.takerFeePct, fundingPctPerHour: REPRESENTATIVE_FUNDING_PCT_PER_HOUR },
    retail_worst_case_3x_funding_stress: {
      takerFeePct: FEE_TIERS.retail_worst_case.takerFeePct,
      fundingPctPerHour: REPRESENTATIVE_FUNDING_PCT_PER_HOUR * 3,
    },
    mid_tier_illustrative: { takerFeePct: FEE_TIERS.mid_tier_illustrative.takerFeePct, fundingPctPerHour: REPRESENTATIVE_FUNDING_PCT_PER_HOUR },
    high_volume_illustrative: { takerFeePct: FEE_TIERS.high_volume_illustrative.takerFeePct, fundingPctPerHour: REPRESENTATIVE_FUNDING_PCT_PER_HOUR },
  };
  const out = {};
  for (const [name, params] of Object.entries(scenarios)) {
    out[name] = { params, trades: applyCosts(trades, params) };
  }
  return out;
}
