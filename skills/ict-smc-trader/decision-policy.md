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

Separately, a **quality bonus** (0 to +1 per timeframe, additive on top of the base score) from
Boom Hunter tiered long signals: `Long Lime` = full +1 (highest-quality tier, "QUALITY ENTRIES"
per source comment), `Long blue`/`Long yellow` = +0.5, `Long gray` = +0.25 (weakest, broadest
tier). **Never use `break_ambiguous` as a short trigger** (house-stack.md: unverified, source-order
analysis suggests it more likely means the opposite).

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

## Hard vetoes (override scoring entirely)

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
