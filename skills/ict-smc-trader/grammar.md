# Grammar — Terms As Implemented, Not As Taught Elsewhere

Every definition below traces to a specific line of behavior in `pine/smart-money-concepts-luxalgo.pine`
or its reimplementation in `scripts/signal-bus/smc/calc.js`. Where generic ICT/SMC usage differs
from what this house's code actually does, the difference is called out explicitly — don't import
outside conventions silently.

## Structure

**Leg.** A directional state (bullish/bearish) tracked by comparing the high/low `N` bars back
against the highest/lowest of the following `N` bars. Two independent leg trackers run at once in
this stack: **internal** (`N=5`, fast) and **swing** (`N=50`, slow). A pivot only becomes knowable
`N` bars after it happens (confirmation delay) — this is a real detection lag, not a bug.

**BOS (Break of Structure).** Price closes through the currently-tracked pivot level **in the same
direction as the existing trend bias**. Continuation, not reversal.

**CHoCH (Change of Character).** Price closes through the currently-tracked pivot level **against**
the existing trend bias — the trend bias flips as a result. A CHoCH is the first break of the new
direction, not a confirmed new trend on its own.

> **House correction to generic ICT usage:** the tag text "BOS" vs. "CHoCH" says nothing about
> bullish/bearish by itself — that's a separate fact from which pivot (a high, for a bullish read,
> or a low, for a bearish one) was crossed. Reading tag text alone is insufficient. Confirmed
> directly from source: bullish and bearish breaks are two entirely separate code branches.

**Internal vs. swing structure.** Not "noise vs. signal" — both are real, simultaneously-tracked
structures at different sensitivities. Internal structure suppresses a duplicate signal when its
own pivot happens to coincide exactly with the swing pivot's level (avoids double-counting the
same break at both scopes).

## Order blocks

**Order block.** The most extreme "parsed" candle (high or low, with a high-volatility-bar swap
filter to avoid anchoring on an outlier wick) between a structure pivot and the break that
confirmed it. A **bullish (demand)** block anchors at the lowest point of the pullback right
before an upward break; a **bearish (supply)** block anchors at the highest point right before a
downward break. Both **internal** and **swing** order blocks exist, matching their structure scope.

**Colors — genuinely not green/red.** Bullish order blocks are blue-family, bearish are red/
pink-family:

| | Internal | Swing |
|---|---|---|
| Bullish | `#3179f5` | `#1848cc` |
| Bearish | `#f77c80` | `#b22833` |

(Packed ABGR in the raw Pine color value — confirmed by decoding, not assumed ARGB.)

**Mitigation.** An order block is invalidated the instant price's high (bearish block) or low
(bullish block) — not close — fully clears the block's far boundary. Exact and terminal under this
house's default mitigation source (HIGHLOW), not a judgment call about "how much" of the block got
tested.

**Touch (this house's addition, not in the source).** A bar's range overlapping the block's
[low, high] range at all — richer than mitigation, tracks every test before the eventual
resolution (held/broken), including penetration depth and approach direction.

**Confluence (this house's addition, not in the source).** An order block is "confluent" with
another SMC element (another order block on any timeframe, an EQH/EQL, a structure break) if their
prices are within a small tolerance (0.2% of price) and their active windows overlap in time.
Confluence *degree* (how many distinct timeframes agree) is the tested, load-bearing metric — see
`significance-register.md`. Confluence *presence* alone is not discriminating (~97% of blocks show
some confluence, given how dense the signal pool is).

## Liquidity (EQH/EQL)

**Equal Highs (EQH) / Equal Lows (EQL).** Two pivots (of the same leg-tracker) whose levels fall
within an ATR-scaled threshold of each other. This IS this house's liquidity concept — resting
stop orders are assumed to cluster above equal highs (sell-side/buy-stop liquidity) and below
equal lows (buy-side/sell-stop liquidity) — even though the literal word "liquidity" never appears
in the source (confirmed by direct search before this was written).

**Colors — counterintuitive on first read.** EQL (equal **lows**) uses the **green**/bullish
color; EQH (equal **highs**) uses the **red**/bearish color. This is because the color encodes
the *implication* (a held low = bullish support; a held high = bearish resistance), not the
literal "up/down" direction of the word "high" or "low." Confirm this before assuming otherwise.

**Sweep.** The first bar after an EQH/EQL is confirmed where price actually trades through the
level (crosses it, not just approaches it).

> **The classic narrative — "a liquidity sweep is a stop-hunt that precedes a reversal" — is
> FALSIFIED for this house's data.** A sweep looked like it reversed within 10 bars ~81% of the
> time, consistent across all 8 timeframes. Tested against a proper random-level baseline
> (a random bar's own high/low run through the identical two-stage sweep-then-reversal check): the
> real rate sits *below* the entire null range. Arbitrary price levels reverse *more* reliably than
> genuine liquidity sweeps, not less. **Do not teach or weight this pattern as edge in this house's
> grammar** — see `significance-register.md` and the hard refusal in `SKILL.md`.

## Divergence for Many (not native SMC/ICT vocabulary, but part of this house's stack)

**Badge.** An event: at least 3 of the 4 enabled sub-indicators (MACD, MACD Histogram, RSI,
Stochastic) show a regular divergence on the same side at the same bar.

**Promoted glow level / zone.** A *persistent* price level, created only when a badge additionally
clears a regular-divergence-count threshold, deduped against nearby existing zones by ATR
distance, capacity-capped at 3 per side, and aged out after ~200 bars if never re-tested. This is
the object with a real hold/broken rate and a real, tested confluence effect — a badge alone is
just an event, not a durable level.

## Cipher A ribbon

**Ribbon direction.** `ema8 < ema2`, exactly — comparing only the slowest and second-fastest of
the 8 EMAs, not requiring the full 8-EMA stack to be monotonically ordered. A "tangled" stack can
still resolve to a clean bullish or bearish direction under this formula.

## SuperTrend regime

**Volatility regime (HIGH/MEDIUM/LOW).** A K-means cluster label over a rolling ATR window,
feeding the width of the adaptive SuperTrend band. Context for how tight/loose the current band
is, not itself a directional signal — direction comes from the SuperTrend flip.
