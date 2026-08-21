---
name: mtf-market-structure
description: >-
  Multi-timeframe market-structure analysis as this project has actually established it — the
  available_at rule, the 4h/1h rung boundary, rung staleness, grid-phase sensitivity, cross-rung
  double-counting, and the difference between a descriptive contact effect and a tradeable edge.
  Use whenever reading structure across the W/D/4H/3H/2H/1H/15m/5m ladder, building or reviewing an
  MTF confluence / co-occurrence / nesting / cascade construction, quoting a multi-rung statistic,
  or assembling top-down context for a bottom-up trigger. NOT a source of trading signals and NOT a
  substitute for `ict-smc-trader` (house grammar and the significance register) or
  `institutional-quant` (evidence hierarchy and proof gates).
---

# MTF Market Structure

## What this skill is

The hard-won operating knowledge for reading structure across timeframes **in this codebase**.
Every rule below is here because violating it produced a wrong answer that was published and later
corrected. The register row is cited each time so the correction can be read in full.

This is not generic ICT/SMC MTF lore. Most of what follows contradicts the intuitive version.

## The substrate

`scripts/signal-bus/lib/mtf-state.js` is the single MTF state layer (#213, #214).

```js
import { openMtf } from "./scripts/signal-bus/lib/mtf-state.js";
const mtf = await openMtf("BTC");                       // full house ladder by default
const snap = mtf.at(Date.parse("2026-08-19T14:00:00Z") / 1000);
const levels = mtf.context(t, price, { within: 0.05 }); // top-down levels near price
for (const s of mtf.timeline("4h")) { /* every 4h close */ }
```

CLI: `node scripts/signal-bus/lib/mtf-state.js --instrument=BTC --at=<ISO> --context=<price>`

**Never re-implement `available_at`.** Two shared libs already derive from this one; a third
definition is how they drift apart silently.

---

## Rule 1 — `available_at` is the whole game

A rung contributes only its **last bar whose CLOSE is at or before the query instant**. A 1d bar
stamped 00:00 is *not knowable* at 04:00 — it closes at 24:00.

Get this wrong and every higher rung sees its own future. The resulting confluence looks
spectacular and is entirely fake. `asOf()` is the only path to rung data in the layer, deliberately.

## Rule 2 — Higher rungs are STALE, and the staleness is large

At any 1h instant, the weekly rung is contributing a bar up to **~62 hours old**, the daily up to
~14 hours old (#213, measured at 2026-08-19 14:00).

This is not a defect to fix — it is what "the weekly says X" *means*. But it was invisible in every
MTF claim made before #213, so `ageSec` is now a printed field on every snapshot. **Quote it when
you quote a higher-rung state.**

## Rule 3 — 4h carries this stack's structure; 1h does not

Derived independently **four times** (#188 q6, #204 audit, #206 MSS, #211 order blocks):

| construction | 4h | 1h |
|---|---|---|
| q6 ceiling + Strong Low | cluster t = 2.31 | cluster t = 1.42, dead |
| MSS entry, exit sweep | all arms t ≥ 2 | null in every arm |
| bullish OB inside Strong Low | 97.3rd–99.7th pct vs null | 36th pct, nothing |

Four independent derivations is not a coincidence. **Start on 4h. Treat a 1h-only result as
probably noise until it survives on 4h.**

## Rule 4 — NEVER pool rungs of the same instrument

**38.2% of 4h q6 events have a 1h event within ±4 hours** (#204). Same market episode, counted twice.

Worse, pooling *dilutes* as well as inflates: the flagship's per-trade effect was **+1.2862% on 4h
alone** but pooling with the weak 1h arm reported **+0.4955%** — a weaker effect with a *stronger*
t-statistic. Both numbers were wrong in opposite directions at once.

**Report per-rung. Always.** If you must combine, de-duplicate episodes first.

## Rule 5 — Overlapping holds break every t-statistic

With 200-bar holds and events arriving faster than exits, consecutive trades ride the same price
path. Naive t assumes independence and inflates badly: **t = 3.82 → cluster t = 2.31** (#204).

Chain trades whose holding windows overlap into clusters, take cluster means, test on those. **Quote
cluster t alongside naive t or the number is not defensible.**

## Rule 6 — The grid phase is arbitrary; average over it

Rebuild 4h from 1h at offsets 0/1/2/3h and the *sign* survives every alignment — but the *magnitude*
swings **4.5×** (+0.14% to +0.63%), and the standard grid landed on the highest of four (#212).

**A single-grid magnitude is one draw from a wide distribution.** Quote the phase-averaged value or
label it single-phase. Bar boundaries are a human convention; the market does not respect them.

## Rule 7 — Long-vs-short and conditioned-vs-complement are BOTH inadequate

In a corpus where buy-and-hold returns ×13 to ×96, a long arm beats a short arm automatically. Every
q6 row for 15+ rows compared only against its own mirror image and could not distinguish signal
from drift (#210).

**Always add a random-entry null drawn from the same eligible population, on the same side.**

The counter-intuitive part that makes this worth doing: **a random long LOSES −0.15% to −0.29% in a
market that rose 96×**, because a 2×ATR stop with a 2R target repeatedly stops you out of the trend.
Drift does not hand longs a profit under a stopped construction — so "shorts lost because of drift"
is *not* a sufficient explanation either. Measure it; do not reason about it.

## Rule 8 — A contact effect is not an edge

The single most repeated failure here.

| object | descriptive result | tradeable? |
|---|---|---|
| liquidity pool S/R (#192) | z = 3.27 rejection vs placebo | **no** — 5 of 6 cells negative |
| breaker / mitigated OB (#216, #218) | Welch t = 2.93–12.03, z = 7.23–10.27 | **no** — 16 of 16 negative |

Why: those effects are **placebo-relative**, and a trade cares about **absolute** direction. A broken
bullish block genuinely suppresses the advance versus a random level — and price still rises, so
shorting it loses badly.

**Treat "descriptive-significant" as the default expectation, not a promising lead.** Two unrelated
objects, same outcome.

## Rule 9 — Structure state is a REGIME, not a trigger

The MSS **is** the transition into Strong Low — `swingBias` is BULLISH on 137/137 and 131/131 signal
bars, mechanically, because `calc.js` sets it on the bullish swing CHoCH itself (#209).

So entering *at* the declaration and firing *inside* the regime are different constructions:

- entry at the instant the regime is declared → **failed** its pre-registration (#208A)
- a q6 ceiling firing inside an established regime → **passed** (#208B)

Also: Strong Low has **no main effect** — random longs inside it are *worse* than random longs
generally on fresh instruments (#210). Its value is entirely **interactional** with the signal it
gates.

## Rule 10 — Mitigated levels are not dead

Broken order blocks beat matched placebos on reaction and rejection, on two independent instrument
groups, and react with **flipped polarity** — broken bearish acts as support, broken bullish as
resistance (#216).

`htfContext` therefore includes them by default, tagged `OB-*-BREAKER` with a `flipped` field. The
opposite default hid real structure for exactly one day. **See Rule 8 before trading any of it.**

---

## Top-down context for a bottom-up trigger

A trigger says *when*. It says nothing about *where in the larger structure* it fires. `mtf.context()`
returns the where.

Worked example (#215): at the 19 Aug 23:00 Boom short flag, the nearest **live** resistance was
+4.58% and +6.53% overhead — the short fired into open air, and price ran to 74,922, stopping just
under that 73,858 block. A gate of the form *"no bottom-up short without live resistance overhead"*
would have vetoed it.

## Cross-rung confluence is not automatically confirming

Tested directly and it **inverted**: requiring a Boom `break_short` on another rung made results
worse in 5 of 6 cells, badly (−0.35% → −1.71%) (#217).

Coherent reading: multiple rungs printing short flags marks a strong *uptrend* generating repeated
countertrend signals — so stacking them selects the worst moment to be short. **Confluence must be
measured, never assumed. Agreement across rungs can be a warning rather than a confirmation.**

---

## Checklist before quoting any MTF number

```
- [ ] available_at enforced (via mtf-state, not a local re-implementation)
- [ ] per-rung, not pooled across rungs of one instrument
- [ ] cluster t reported alongside naive t
- [ ] random-entry null from the same population, same side
- [ ] magnitude phase-averaged, or explicitly labelled single-phase
- [ ] higher-rung staleness (ageSec) stated if a higher-rung state is part of the claim
- [ ] descriptive vs tradeable distinguished — never let the first imply the second
- [ ] multiplicity acknowledged if the cell was chosen after looking at several
```

## Hard refusals

| Situation | Action |
|---|---|
| Asked to pool 1h and 4h of one instrument for a headline number | Refuse — 38.2% episode overlap (#204). Report per-rung. |
| A t-statistic quoted with overlapping 200-bar holds and no cluster t | Refuse the number until cluster t is computed. |
| A long arm beating a short arm presented as evidence of edge | Refuse — that is drift, not signal, until a random-entry null is run (#210). |
| A descriptive contact result presented as tradeable | Refuse — #192 and #218 are two independent counter-examples. |
| A single-grid magnitude quoted as *the* effect size | Correct to the phase-averaged value or label it single-phase (#212). |
| Cross-rung agreement assumed to strengthen a signal | Refuse — measured and inverted in #217. |
