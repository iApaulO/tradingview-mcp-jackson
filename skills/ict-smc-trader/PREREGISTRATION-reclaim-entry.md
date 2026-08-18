# PRE-REGISTRATION — the "reclaim" confirmation entry, single run on XRP

**Frozen 2026-08-17, before any XRP data existed in this repository.**
Hypothesis from #176/#177, replicated in #179. This document is the specification.
Nothing below may be changed after results are seen. **The run happens once.**

---

## 1. The claim being tested

#179 found that changing the ENTRY rule for strategies A and A2 improves risk-adjusted return on
every instrument and both strategies — 6 of 6 cells — and separately collapses the degenerate-stop
defect recorded in #174.

The rule is iapaulo's, from reading a chart: **touch, react, open on the next candle after correct
direction** — concretely, price touches the order block, then the first candle that *closes back
outside the block* confirms it, and entry is the following bar's open.

Measured improvement in R/trade, blind first-touch → reclaim:

| | A | A2 |
|---|---|---|
| BTC | +0.102 → +0.406 | −0.099 → +0.278 |
| ETH | +0.254 → +0.475 | +0.075 → +0.429 |
| SOL | +0.295 → +0.512 | +0.337 → +0.429 |

### Why this needs pre-registering

All three instruments were used to *develop* the rule. Under #165's finding that an instrument is
spent **per hypothesis**, none of them is a clean gate for it. Three correlated crypto assets
agreeing in-sample is suggestive and is not a passed test.

### The guarantee, and why it is stronger than #165's

#165 could only claim "Boom Hunter had never been computed on SOL" — the SOL price data already
existed, so peeking was possible in principle. **This document is committed before XRP data exists
at all**: at the freeze commit, `ls data/historical/ | grep -i xrp` returns nothing, `XRP` is absent
from `KNOWN_INSTRUMENTS`, and no XRP string appears anywhere under `scripts/`. That is #143's
standard, restored.

XRP is also chosen deliberately for being *unlike* the existing three: a longer-ranging, lower-beta
asset with different market structure. A confirming result there is worth more than a fourth L1.

---

## 2. Frozen configuration

Every constant is hard-coded in the runner, not exposed as a flag — #143's reasoning that a
sweepable parameter is one that will get swept.

| Item | Value |
|---|---|
| Instrument | **XRP** (XRPUSDT, Binance) |
| Rungs | 5m, 15m, 1h, 4h |
| Strategies | A (`recurrence_count >= 3`), A2 (`recurrence_count >= 3` AND engulfment) |
| Entry population | **FIRST TOUCH ONLY** per order block |
| Entry — treatment | **react_reclaim**: first candle after the touch closing back outside the block (`close > bar_high` long, `close < bar_low` short); entry is the NEXT bar's open |
| Confirmation window | **12 bars**; unconfirmed setups are SKIPPED, never entered late |
| Entry — control | **blind**: entry at touch bar + 1, no confirmation |
| Stop | the order block's own edge (`bar_low` long, `bar_high` short) |
| Target | 2R |
| Hold limit | 200 bars, mark-to-market on unresolved |
| Ambiguous bars | stop-first |
| Slippage | 0.05 ATR entry, 0.15 ATR stop, 0 target |
| Costs | `bitunix_futures_vip1` taker both sides, plus representative funding |
| Degenerate threshold | `riskPct < 0.05%` of price |

The stop is the OB edge and **not** the swing level: #175 and #179 both found the OB stop superior
risk-adjusted in every cell tested. Using the swing stop here would test a construction that lost.

---

## 3. Pass / fail criteria — declared before any XRP result exists

The run **PASSES** only if all four hold:

1. **Reclaim beats blind on R/trade, for BOTH A and A2.** This is the actual claim; anything else is
   secondary.
2. **Reclaim R/trade > 0 for BOTH A and A2.** An improvement that remains unprofitable is not a
   result worth promoting.
3. **Population floor:** n ≥ 60 in each reclaim cell. Below this the run is **INCONCLUSIVE**, not a
   pass and not a fail.
4. **The degeneracy claim holds:** degenerate share under reclaim is less than **half** the blind
   share, for both A and A2. #179 measured roughly a ten-fold reduction on all three instruments;
   half is deliberately conservative.

Anything short of all four is a **FAIL** and will be recorded as one. A partial result — one
strategy working, or an improvement that does not clear zero — is a fail, not a "qualified pass".

### What a pass authorises

Only the #33 paper/live-shadow stage, and only for the reclaim entry as specified. It does **not**
authorise portfolio wiring, and it does not lift #145's constraints: allocation policy still
dominates strategy selection, and the pool is still budget-bound.

### Limitations a pass will NOT remove

- XRP is correlated with BTC/ETH/SOL, less so than they are with each other but not independent.
- The 12-bar confirmation window has never been varied; its sensitivity is unknown on any instrument.
- Nothing has run through the portfolio harness, so the interaction with #145's budget constraint
  remains unmeasured.
- Target-as-resting-limit ignores queue position and partial fills; no L2 depth exists.

---

## 4. Procedure

1. Commit this document. No XRP data may exist at that commit.
2. Add XRP to the instrument plumbing and fetch its history from Binance.
3. Build the SMC corpus **including `build-confluence.js`** — #179 found SOL silently returned zero
   qualifying blocks because that step had never run, and the same omission here would produce a
   false INCONCLUSIVE.
4. Run the pre-registered runner **once**.
5. Record the verdict against §3 in the register, pass or fail, without amendment.
