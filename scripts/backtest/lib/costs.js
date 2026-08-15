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
  // ADDED 2026-08-09: iapaulo pointed out Bitunix (the exchange actually charted this entire
  // session, BITUNIX:BTCUSDT.P -- not Coinbase) is cheaper. Checked via web search before adding
  // (Bitunix's own help center + fee blog) -- the exact "0%/0%" figure iapaulo first gave turned
  // out to be Bitunix's P2P fee, a different product; FUTURES fees are real but still meaningfully
  // cheaper than Coinbase's confirmed tier at every level. VIP0/base kept only as a fallback below.
  bitunix_futures_base: { takerFeePct: 0.0006, makerFeePct: 0.0002 },
  // CONFIRMED 2026-08-09: iapaulo's actual Bitunix tier is VIP1. Fetched directly from Bitunix's
  // own official fee page (bitunix.com/service/handling-fee), not a third-party aggregator (two
  // different search-result snippets disagreed slightly on other tiers' numbers, so the primary
  // source was pulled directly rather than trusted from a snippet) -- VIP1 requires >=1,000,000
  // USDT/30d volume OR >=300 USDT balance. This is the real number -- use as the default for
  // Bitunix scenarios going forward, same status confirmed_derivatives has for Coinbase.
  bitunix_futures_vip1: { takerFeePct: 0.0005, makerFeePct: 0.0002 },
  // Bitunix's own top VIP7 tier (>=$200M/30d futures volume OR >=$2.4M balance) -- NOT iapaulo's
  // actual tier, kept only as the cheap-end sensitivity bound, same role coinbase_spot_tier plays
  // as the expensive-end bound.
  bitunix_futures_vip7_unconfirmed: { takerFeePct: 0.0003, makerFeePct: 0.00006 },
};

// Widely-cited cross-exchange BTC perp funding baseline (~0.01% per 8h == 0.00125%/hr), used ONLY
// as a sensitivity anchor -- not sourced from Coinbase's own historical funding data (not imported).
export const REPRESENTATIVE_FUNDING_PCT_PER_HOUR = 0.0000125;

// UPDATE 2026-07-25: iapaulo confirmed the funding MECHANISM directly (Coinbase's own
// description): calculated hourly from the futures-vs-spot basis over the past hour: contract
// above spot -> longs pay shorts; contract below spot -> shorts pay longs. Funding is a
// peer-to-peer TRANSFER, not an exchange fee -- it cannot be a net cost to both sides of the same
// position simultaneously, which the original "always subtract, regardless of side" model
// implied. Two modes now:
//   - "pessimistic_both_sides" (legacy default behavior, kept as an explicit worst-case stress
//     bound: treats magnitude as a pure drag no matter which side you're on -- can't literally be
//     true for both sides at once, but useful as a "what if I'm always on the wrong side of
//     funding" ceiling.)
//   - "signed_contango_bias": applies the magnitude as a cost to longs, a credit to shorts --
//     modeling a persistent-positive-funding (contango) regime, i.e. the commonly-cited tendency
//     for crypto perp funding to skew positive across full market cycles (Hypothesized /
//     Supported-by-recollection here, NOT verified against Coinbase's own historical funding
//     series this session -- a real sign/magnitude series is still the right long-term fix).
// Neither mode is a confirmed historical sign distribution. Report both, don't pick the
// flattering one and call it final.
export function applyCosts(trades, { takerFeePct = 0, fundingPctPerHour = 0, fundingMode = "pessimistic_both_sides" } = {}) {
  return trades.map((t) => {
    const hoursHeld = Math.max(0, (t.exitTime - t.entryTime) / 3600);
    const roundTripFee = 2 * takerFeePct; // entry + exit, worst case both taker
    const fundingMagnitude = fundingPctPerHour * hoursHeld;
    const fundingDrag =
      fundingMode === "signed_contango_bias" ? (t.side === "long" ? fundingMagnitude : -fundingMagnitude) : fundingMagnitude;
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
    confirmed_derivatives_signed_funding: {
      takerFeePct: FEE_TIERS.confirmed_derivatives.takerFeePct,
      fundingPctPerHour: REPRESENTATIVE_FUNDING_PCT_PER_HOUR,
      fundingMode: "signed_contango_bias",
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
