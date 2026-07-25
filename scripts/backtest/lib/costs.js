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
// UPDATE 2026-07-25: iapaulo confirmed the real account fee schedule directly from the Coinbase
// Advanced dashboard (screenshot): Advanced 1 tier, $73,923.25 trailing-30-day DERIVATIVES volume.
// This validated the suspicion below -- the earlier "retail_worst_case" figure (0.60%/0.40%) was
// indeed Coinbase's SPOT tier, not derivatives, and overstated real costs by roughly 8x. Kept here
// (renamed) only as a labeled contrast, not as a plausible real scenario anymore. Funding rate
// magnitude is still NOT Coinbase-specific (dashboard doesn't surface historical funding data) --
// the representative cross-exchange figure below remains a placeholder for that one component.

export const FEE_TIERS = {
  // CONFIRMED 2026-07-25 from iapaulo's own Coinbase Advanced dashboard, Advanced 1 tier,
  // derivatives volume $73,923.25/30d. This is the real number -- use this as the default going
  // forward, not a sensitivity extreme.
  confirmed_derivatives: { takerFeePct: 0.0007, makerFeePct: 0.00065 },
  // Same tier, IF enrolled in Coinbase One (25% fee rebate per the dashboard) -- unconfirmed
  // whether iapaulo is actually enrolled, kept separate rather than assumed.
  confirmed_derivatives_with_one_rebate: { takerFeePct: 0.0007 * 0.75, makerFeePct: 0.00065 * 0.75 },
  // WRONG PRODUCT, kept only to show how much the fee schedule mattered: this is Coinbase's SPOT
  // tier (<$10k/mo), surfaced via a third-party aggregator before the real derivatives tier was
  // confirmed. Derivatives trading never actually paid this -- do not use as a real scenario.
  coinbase_spot_tier_wrong_product_for_contrast_only: { takerFeePct: 0.006, makerFeePct: 0.004 },
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
    confirmed_derivatives: {
      takerFeePct: FEE_TIERS.confirmed_derivatives.takerFeePct,
      fundingPctPerHour: REPRESENTATIVE_FUNDING_PCT_PER_HOUR,
    },
    confirmed_derivatives_3x_funding_stress: {
      takerFeePct: FEE_TIERS.confirmed_derivatives.takerFeePct,
      fundingPctPerHour: REPRESENTATIVE_FUNDING_PCT_PER_HOUR * 3,
    },
    confirmed_derivatives_with_one_rebate: {
      takerFeePct: FEE_TIERS.confirmed_derivatives_with_one_rebate.takerFeePct,
      fundingPctPerHour: REPRESENTATIVE_FUNDING_PCT_PER_HOUR,
    },
    coinbase_spot_tier_wrong_product_for_contrast_only: {
      takerFeePct: FEE_TIERS.coinbase_spot_tier_wrong_product_for_contrast_only.takerFeePct,
      fundingPctPerHour: REPRESENTATIVE_FUNDING_PCT_PER_HOUR,
    },
  };
  const out = {};
  for (const [name, params] of Object.entries(scenarios)) {
    out[name] = { params, trades: applyCosts(trades, params) };
  }
  return out;
}
