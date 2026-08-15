# Decision Policy — Weighted Confluence Scoring

This is a **discretionary scoring framework**, built on top of the house stack. Be precise about
what is and isn't tested: the *inputs* below are drawn from real findings (see
`significance-register.md` for which), but **the scoring weights themselves are a judgment
system, not independently significance-tested** — they're the standard institutional layering
(HTF bias dominates, structure times it, triggers confirm it), applied to this specific stack.
Say this explicitly when delivering a grade, don't imply the point system itself has been backtested.

This is also the **target policy `rules.json` should grow into** — the file currently holds a
generic, untested `bias_criteria` block unrelated to this stack (see `house-stack.md`,
`PRIOR_ART.md` §1). Until `rules.json` is updated, treat this file as the real policy and say so.

## Confluence policy: weighted, not strict unanimity

A setup does not need every timeframe and every indicator to agree. It needs the **HTF bias layer
to not be opposed**, a **majority of the structure layer** pointing the same way, and **trigger
layer confirmation** for timing. Disagreement at the trigger layer just means "wait," not "no
trade" — disagreement at the HTF layer is a hard veto (see below).

## Layers and weights

**Scoring unit: one synthesized directional score per TIMEFRAME, not one score per source summed
across sources.** Each timeframe gets a single -1 / 0 / +1 read (opposed / neutral / aligned with
the candidate direction), informed *qualitatively* by whichever sources apply at that timeframe —
not an independent point per source, which would silently let a timeframe with more available
sources outweigh one with fewer just by having more inputs to sum. That per-timeframe score is
then multiplied by its layer's weight.

| Layer | Timeframes | Per-TF score | Layer weight | Layer max |
|---|---|---|---|---|
| HTF bias | W, D | -1 / 0 / +1 | ×3 | 6 |
| Structure | 4H, 3H, 2H | -1 / 0 / +1 | ×2 | 6 |
| Trigger (base) | 1H, 15m, 5m | -1 / 0 / +1 | ×1 | 3 |
| Trigger (quality bonus) | 1H, 15m, 5m | 0 to +1 per TF, additive | — | 3 |

**Total max: 18** (6 + 6 + 3 + 3).

### HTF bias layer (W, D)

Inform each timeframe's single -1/0/+1 read from: SMC swing structure trend bias (from the
reimplementation's tracked bias, **not** from reading a live label's tag text alone —
house-stack.md, direction gate in SKILL.md), Cipher A ribbon regime (`ema8 < ema2`), Adaptive
SuperTrend regime (`[via BTCUSD proxy]`). If these three disagree with each other at a given
timeframe, that timeframe scores 0 (neutral), not an average — disagreement among HTF sources is
itself information (don't paper over it with a forced tiebreak).

If **both** W and D score -1 (opposed) on the candidate direction → **hard veto**, skip to
"No-trade" regardless of everything below. This is the one rule from the commission's skeleton
that overrides scoring entirely, matching how HTF bias should behave on a real desk.

### Structure layer (4H, 3H, 2H)

Inform each timeframe's single -1/0/+1 read from: SMC order block presence + BOS/CHoCH direction
(pivot-logic direction, confirmed, not inferred from tag text), Divergence-for-Many promoted zone
in the candidate's favor — **weighted by confluence degree** using the tested finding (an isolated
zone, confluence=1, counts for less than a 3+-timeframe-confluent zone, since that gradient,
53.4%→60.6%, p<0.001, is the one Divergence-for-Many result actually earning extra weight), and
Cipher B context (WT direction, divergence families) as supporting color only — Cipher B alone
should never be sufficient to flip a timeframe's score on its own.

### Trigger layer (1H, 15m, 5m)

Base score (-1/0/+1 per timeframe) from: lower-TF SMC/Divergence touches aligned with HTF bias,
and SuperTrend flip direction — **confirmation/veto candidate, not the whole system**: an
*opposing* flip on 1H specifically is also a **soft veto** (drop one full band, see below),
reflecting that the backtest lab's own flip signal did not clear significance alone and shouldn't
be trusted as the deciding vote either way, but a very recent opposing flip is still worth
downgrading confidence for.

Separately, a **quality bonus** (0 to +1 per timeframe, additive on top of the base score) comes
from Boom Hunter's full-sequence + nested-cascade pattern (significance-register.md #60/#61,
2026-08-09) — **not** raw tier identity. The old `Long Lime`=+1/`blue`,`yellow`=+0.5/`gray`=+0.25
discretionary split is retired: tested directly, lime/blue/yellow are statistically
indistinguishable from each other (all p>0.15) and only gray trails meaningfully (#60). This
applies #59's validated "nested multi-timeframe confirmation beats a single-timeframe read"
pattern (originally found on Cipher B divergence with a foreign {15m, 6H, 1d} reference set) to
this house's own ladder — **4H, not 6H**, since 6H has never been part of this project's 8-rung
ladder (1w/1d/4h/3h/2h/1h/15m/5m):

- **Gate (+0.5 flat):** any Long tier (lime/blue/yellow/gray/`enter4` — graduated from dead code
  2026-08-09, #60a) fired at the order block's own price level before it formed, AND a
  Continuation confirmed after (`order_blocks.boom_full_sequence=1`, written by
  `scripts/signal-bus/smc/build-boom-confluence.js`).
- **Dose-response bonus (0 to +0.5, additive):** how many SLOWER timeframes had their own Long
  signal fire first, in sequence, near the same price (`order_blocks.boom_nested_depth`) — but
  score this bonus **only** when `recurrence_count >= 2` (`order_blocks.boom_nested_boost=1`).
  Nesting alone on an isolated (`recurrence_count=1`) order block tested null (#61: gap=-0.4pts,
  p=0.60-0.61) and must not be scored as if it were real — the effect only exists inside the
  high-recurrence stratum (#61: gap=+2.5 to +2.8pts, p=0.018-0.021). **Cost/capacity-validated
  2026-08-09 (#69, refined #75 once the real trading venue's fees were confirmed)** — unlike the
  flat gate above (which is trade-construction-blocked, never clears real costs at any R),
  `boom_nested_boost=1` specifically clears real costs at ALL FOUR R multiples on Bitunix's
  confirmed VIP1 fee tier (0.05% taker, the actual venue this project charts —
  BITUNIX:BTCUSDT.P — not the Coinbase tier most of this project's earlier cost tests used),
  improving monotonically with R (+0.026%/+0.067%/+0.089%/+0.104% per trade costed at 1R/1.5R/2R/3R)
  — the strongest-margin finding in this project to survive both significance and cost/capacity
  testing (alongside #27b/#49/#68). Weight this bonus with real confidence, not just as descriptive
  color — but same standing caveat as #27b/#49: single-asset BTC, backtest-only, idealized fills,
  not yet a deliberate live-ready decision.

**Never use `break_ambiguous` as a short trigger** (house-stack.md: unverified, source-order
analysis suggests it more likely means the opposite) — the short side (`break_short`/`senter3`)
was tested this session too (#60a) and only cleared significance on 1 of 4 comparisons, too weak
to wire in.

**EOT3 (q5, Quotient5 — Boom Hunter's own "Yellow Line," genuinely distinct from the `Long yellow`
flag despite the shared name) — small informational input, not a gate or a major score driver
(#66/#67, 2026-08-09):** when q5 crosses down through 50 and later recovers back above it without
ANY Long-tier flag (lime/blue/yellow/gray/enter4) firing anywhere during that whole down episode,
treat the episode as mildly *constructive*, not a warning — real, largely timeframe-invariant
(confirmed independently on 5m and 15m, both bias regimes), the opposite of the intuitive read that
an "unconfirmed" bottom should be treated with more suspicion. Do **not** read this as trend-context
-dependent — explicitly tested and rejected: the effect is not concentrated in counter-trend
(bearish-bias) episodes, holding similarly in both bearish- and bullish-bias contexts (#67). Effect
size is modest (mean-return gaps of 0.1–0.6pt across the tested horizons) and not yet cost/capacity
tested — informational color only, do not weight this as heavily as the gate/dose-response bonus
above.

Independent of any TF missing data entirely (e.g. a source not readable this sweep): score that
timeframe's contribution as **0 (neutral) and flag it explicitly** in the output — never silently
skip it, and never treat "unavailable" as either agreement or disagreement.

Independent of the point total, the trigger layer's job is **timing**: even a "strong" HTF+structure
score should wait for at least one trigger-layer confirmation before calling an entry ready, not
just a bias.

## Scoring bands

Max possible: 6 (HTF) + 6 (structure) + 3 (trigger base) + 3 (trigger quality bonus) = **18**.

| Band | Score | Meaning |
|---|---|---|
| **Strong** | ≥12 | HTF aligned, majority of structure layer aligned, at least one trigger confirmation present |
| **Medium** | 6–11 | HTF aligned or neutral, structure mixed-to-aligned, trigger present or pending |
| **Weak** | 2–5 | HTF neutral, structure thin or mixed, no clean trigger yet — informational only, not a call to act |
| **No-trade** | <2, or any hard veto tripped | Do not present as a setup |

## Tested Setup Alert: SMC order-block recurrence (separate from the discretionary score)

**This is categorically different from every input above.** Everything in the Layers/weights
system is a discretionary bias input — real findings, judgment weighting. This one is not: it's
the only fully tested, costed, entry/stop/target construction in this house's inventory
(significance-register.md #27b, ARCHITECTURE.md §13) — the first thing here to survive both a
formal significance test and the full cost/capacity gauntlet. Folding it into the -1/0/+1 scoring
system would launder a specific, tested recipe into a vague point contribution and throw away the
one thing that makes it different. It gets its own lane instead.

**The exact tested recipe — do not improvise on it:**
- **Gate:** an SMC order block (any timeframe) with `recurrence_count ≥ 3` (three or more
  same-timeframe order blocks price- and time-overlapping it —§13/§10) begins a touch.
- **Side:** long on a bullish (demand) order block, short on a bearish (supply) one.
- **Entry:** next-bar-open after the touch starts.
- **Stop:** the order block's own far boundary (`bar_low` for bullish, `bar_high` for bearish) —
  unchanged from the tested construction.
- **Target: 1× risk (1R), default.** All four R-multiples (1, 1.5, 2, 3) now have a formal
  permutation significance test behind them (significance-register.md #27c) — but the result is
  split, not a clean confirmation across the board. The correlation (uses the full recurrence
  gradient, the larger sample) is significant at p=0.0000 for every R multiple tested, rising from
  r=0.286 at 1R to r=0.337 at 3R. The top-vs-bottom win-rate gap, however, loses significance at
  2R (p=0.1173) and 3R (p=0.2545) — traced to the same single thin order block (n=12 trades,
  recurrence=6) already flagged as unreliable alone in the original hold-rate test, not evidence
  the effect reverses at higher R. **1R and 1.5R clear both statistics cleanly; 2R/3R carry this
  specific, disclosed caveat.** Default to 1R (cleanest, narrowest-scope support); 1.5R is a
  reasonable alternative with equivalent statistical standing. If asked for 2R/3R, say plainly
  that the aggregate correlation supports it but the extreme-bucket comparison does not, rather
  than presenting it as equally well-supported as 1R/1.5R.
- **Timeout:** if neither stop nor target resolves within 200 bars (the tested cap), the original
  backtest excluded it as inconclusive — mirror that live: close and log as inconclusive, don't
  let it ride indefinitely on the assumption the tested edge still applies past that horizon.

**Existing hard vetoes still apply, full stop — this alert does not bypass them.** HTF opposition,
`rules.json` risk rules, and the liquidity-sweep exclusion are risk-management/methodological
principles, not specific to which structural pattern is firing. The recurrence finding was never
tested *conditional on* HTF bias one way or the other — there's no evidence it still holds when
HTF opposes, so the conservative default is to keep every existing veto in force on top of it, not
carve out an exception.

**Three real gaps that must be disclosed every time this fires, not just once in a doc:**
1. **Live computation exists and is verified working (2026-07-30), but still differs from the
   tested metric in two disclosed ways.** `signal-grid.js`'s `extractOrderBlockRecurrence()` reads
   `data_get_pine_boxes` and computes recurrence live; run against the real chart
   (COINBASE:BIPZ2030, 4H) and every returned `recurrence_count` was hand-recomputed and matched
   exactly (significance-register.md #27d). Two differences remain, not eliminated by that
   verification: (a) side is inferred from the box's position relative to current price, not
   decoded from its color (the ABGR decode was confirmed once but never saved as reusable code) —
   confirmed *directionally sane* on the live read (bearish above price, bullish below), which
   verifies internal consistency, not that price-position always matches the box's true
   color/nature in every chart state; (b) it only sees the ~5 most recently *displayed* boxes per
   scope, not the full ~100-tracked history the offline backtest used — a live "recurrence=3" is a
   **lower bound**, not a guaranteed match to the tested metric. `printTable()` surfaces
   qualifying boxes as a `⚑ Tested Setup Alert candidate` note —
   explicitly a **manual-review watchlist flag, not a live trigger**. Say this plainly rather
   than imply live automation or verified accuracy exists.
2. **Instrument proxy, same as everywhere else in this house.** Backtested on Coinbase Exchange
   spot BTC-USD, not the actual traded contract (`COINBASE:BIPZ2030`, Coinbase Advanced
   derivatives) — the same style of mismatch as the Bitstamp SuperTrend proxy, disclose it the
   same way.
3. **Backtest-only — going live starts a forward test, it doesn't end one.** This clears every
   bar the backtest lab has set, on historical data, for one asset. It has not traded forward.
   Treat the first live/paper instances as the beginning of real evidence, not confirmation.

**Logging is not optional for this one.** The "Standing risk" section below already warns that
grading many setups without tracking hits and misses recreates a multiple-testing problem by
another name. That applies here with more force, not less, precisely because this is the
flagship, most consequential input in the whole stack — log every instance this alert fires,
whether taken or not, and whether it wins or loses. A string of remembered wins on this specific
alert is not evidence it works; a logged, honest hit/miss record going forward is.

## Hard vetoes (override scoring entirely — including the Tested Setup Alert above)

1. **`rules.json`'s `risk_rules`** — R:R below 1:2, first 15 minutes of NY session, 3rd position
   with 2 already open, 2 losses already taken today. These are the user's own standing rules;
   respect them exactly as written, don't reinterpret.
2. **HTF opposition** (both W and D scoring -3 against the candidate direction) — see above.
3. **Liquidity-sweep-as-signal** — a "swept EQH/EQL then reversed" read is **never** a scoring
   input, bullish or bearish, under any circumstance. This is not a soft downgrade, it's a
   structural exclusion: the narrative is falsified (significance-register.md), full stop.
4. **Naive confluence-only entry** — "high confluence order block, therefore trade it edge-to-edge"
   is explicitly blocked. A high confluence score can inform *bias and confidence*, but must never
   be presented as a complete, ready-to-execute entry/exit rule on its own — the one time this
   house built and tested that exact construction, it lost money in every bucket, including the
   best one (trade-construction-blocked, significance-register.md). If the user wants an actual
   entry/exit off a high-confluence order block, say plainly that no tested, profitable exit rule
   exists yet, and that a naive zone-edge exit is known to lose.

## Soft downgrades (drop one band, not a veto)

- An ambiguous field (`exit_warning_ambiguous`, `break_ambiguous`) firing in the setup's favor —
  don't ignore it, don't trust it either; drop confidence one band and say why.
- Live SMC structure read where direction had to be inferred from price context because the tool
  only exposed tag text (rather than pulled from the trend-bias-aware reimplementation) — flag the
  inference, drop one band if the inference is anything but obvious.
- Opposing 1H SuperTrend flip against an otherwise-Strong HTF+structure read.

## Standing risk: grading many setups is its own multiple-testing problem

Scanning 8 timeframes × 5 indicators on every session, day after day, and only remembering or
reporting the sessions that graded Strong and then worked is the exact same data-dredging failure
mode already caught once in this house's own work (Divergence-for-Many's untested indicator-sweep,
significance-register.md #9) — just moved from indicator selection to setup selection. Grade
every setup asked about, log both hits and misses if a journal exists, and don't let a string of
remembered wins substitute for an actual out-of-sample track record. If a pattern of "this scoring
system seems to work" starts being asserted, treat that as a hypothesis needing the same
permutation-test discipline the signal-bus findings got, not as evidence on its own.

## What this policy explicitly does not claim

- That the point weights themselves have been backtested or significance-tested — they haven't;
  they encode a standard discretionary layering applied to tested *inputs*, and should be revised
  the moment a real backtest of the scoring system itself exists.
- That a Strong-banded setup is a proven edge. Nothing in this house's inventory currently
  constitutes a proven, costed, statistically-corrected trading edge (PRIOR_ART.md §7). A Strong
  grade means "the discretionary layering lines up cleanly," not "this will win."
- That `rules.json` currently encodes any of this. It doesn't yet — flag that every time the file
  is read live, until it's updated to match.
- That the Tested Setup Alert (recurrence_count≥3, fixed 1R) is a proven live edge. It's the first
  finding in this house's inventory to clear a real backtest gauntlet — that's real evidence, not
  a forward track record. Live computation now exists and its recurrence arithmetic is verified
  correct against a real chart (`signal-grid.js`, 2026-07-30), but it still differs from the
  tested offline metric in two disclosed ways (price-inferred side, display-capped recurrence) —
  treat any instance surfaced live as a manual-review watchlist flag, not a validated live trigger,
  and not the same thing as a forward track record on the actual Tested Setup Alert recipe.
