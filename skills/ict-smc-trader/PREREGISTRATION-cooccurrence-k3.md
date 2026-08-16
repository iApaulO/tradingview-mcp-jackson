# PRE-REGISTRATION — K≥3 co-occurrence construction

**Status: FROZEN. Committed before the test instrument's data was fetched, built, or examined.**

The commit that introduces this file contains no result. That is the point: every number in
`#138`–`#142` was produced by sweeping configurations and then reading the outcome, and roughly 25+
configurations were swept across four register rows with no multiple-testing correction.
Monotonicity and cross-instrument replication are a genuine defence, but they are an argument, not
a correction. This document fixes the choice in advance so the next result cannot be selected.

---

## 1. Hypothesis

> On an instrument whose data has never been used in this research line, multi-timeframe
> **co-occurrence breadth** in SMC structure events predicts forward outcomes: clusters where three
> or more rungs break structure in the same direction inside one window (K≥3) will have a
> materially better costed expectancy than lone structure breaks (K=1).

Rationale from prior work, all of which is already logged:

- `#137` — cluster size K is significant rung-stratified on BTC and ETH (p=0.0000 both), monotonic,
  while internal ORDER is null once size is controlled (p=0.1226 / p=0.4200).
- `#138` — the size effect survives conversion from a fixed horizon to an R-multiple construction.
- `#141` — it survives a hold-limit sweep and a survivorship correction; K=1 is *negative*.
- `#142` — it survives volatility-scaled asymmetric slippage to a severe scenario.

## 2. Frozen configuration

No parameter below may be changed after this file is committed. If any is changed, the run is not
pre-registered and must be reported as exploratory.

| Parameter | Value | Why this value, decided now |
|---|---|---|
| Population | SMC `structure_events`, `scope='swing'`, both BOS and CHoCH | The family `#136`/`#137` used |
| Clustering | Order-blind co-occurrence, window mult **1**, window scaled to the **coarser** rung | `#135`'s symmetric rule — the only one that does not bias a travel direction |
| Test group | **K ≥ 3** | `#137`/`#141`: K=1 is negative, K=2 marginal, K≥3 is the effect |
| Control group | **K = 1** | The lone-structure-break baseline |
| Outcome rung | The cluster's **finest** rung | Scale-matching, per `#131`'s correction of `#128` |
| Entry | Open of the first bar **strictly after** `knownAtTime` | available_at; a cluster is unobservable until its last member fires |
| Stop | **2.0 × ATR(14)** | `#140` showed monotone improvement with width. 2.0 is deliberately **mid-range of the clearing region, not the maximum (3.0)** — picking the best cell would be the exact error this exercise exists to avoid |
| Target | **2R** | `#138`: 1R failed outright on BTC; 2R cleared on both |
| Hold limit | **200 bars** | `#141`: results flat from 50 to 800, so this is not a tuned value |
| Unresolved trades | **Mark to market** at the limit bar's close | `#141`: the honest treatment; discarding is survivorship bias |
| Same-bar ambiguity | **Stop-first** (pessimistic) | House convention; biases downward |
| Costs | `bitunix_futures_vip1` taker both sides + funding | Confirmed venue |
| Slippage | **Moderate: 0.05 × ATR entry, 0.15 × ATR stop, 0 at target** | `#142`'s middle scenario, not its mildest |
| Null | Circular shift over time-ordered trades | `#128`/`#129`: an i.i.d. shuffle inflates significance on autocorrelated data |
| Iterations / seed | 20,000 / 42 | Unchanged from every prior row |

## 3. Test instrument

**`SOLUSDT` (Binance spot), traded as `SOL` in this repo.**

Chosen because it has never been fetched, built, or examined at any point in this research line —
only BTC and ETH exist in the repo as of this commit. Selected before any of its data was
downloaded, on the basis of liquidity and history depth alone.

**Disclosed limitation:** SOL is a crypto asset and is materially correlated with BTC and ETH, so
this is a genuine *out-of-sample* test but **not an independent** one. A confirming result is
weaker evidence than the same result on an uncorrelated asset class would be, and must not be
described as independent replication.

## 4. Pass / fail criteria — declared before the data exists

**PASS requires BOTH:**

1. K≥3 net costed expectancy on SOL is **> 0** after all costs and moderate slippage; and
2. the K≥3 − K=1 gap is **> 0** with **p < 0.05** under the circular-shift null.

**FAIL** is anything else. Specifically, all of the following count as failure and will be reported
as such without reinterpretation:

- K≥3 expectancy ≤ 0
- gap ≤ 0
- gap > 0 but p ≥ 0.05
- population too thin to test (fewer than 60 K≥3 trades) — this is an **inconclusive** outcome, not
  a pass, and will be labelled inconclusive rather than quietly dropped

**Committed in advance so it cannot be renegotiated afterwards:** a failure will be logged in the
register as a failure and will supersede the optimistic reading of `#138`–`#142` for anything
forward-looking, exactly as `#134` superseded `#133`. A pass does **not** authorise wiring the
construction into `portfolio-backtest.js`; it authorises the next stage (paper/live shadow, per the
`#33` promotion ladder), and nothing beyond that.

## 5. What this run does not settle

- One test instrument, correlated with the two that generated the hypothesis.
- ~30 trades/year per instrument (`#142`), so the SOL sample will be small regardless of outcome.
- Target-as-resting-limit ignores queue position and partial fills.
- No L2 depth, so true market impact remains unmodelled.

---

*Frozen 2026-08-16, before `binance-sol-*.csv` existed in this repository.*
