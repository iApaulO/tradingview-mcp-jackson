# QUEUE — iapaulo's open items, not mine

Things he has raised that are **not yet tested and must not be lost**. Each entry records his claim
in his framing, what I actually said, and what would settle it. **Nothing here is a finding.**

---

## Q1. Buyside/sellside liquidity zones DO have support/resistance value — **RUN 2026-08-19, #192: HE WAS RIGHT (partly)**

**His claim (2026-08-19):** *"you said that buyside/sellside liquidity zone have no support
resistance value and im saying that there is and it is integral."*

**He is right that I overreached, and the register shows it.** Two things were tested; neither is the
S/R claim:

| What was actually tested | Verdict | Row |
|---|---|---|
| EQH/EQL **sweep → reversal** (does a sweep predict a turn?) | falsified — and the row itself says read it as "falsified *as operationalized via EQH/EQL*", not as a blanket claim | early register |
| Liquidity pools as **standing targets** ("price runs to liquidity") | the durable-pool-ahead configuration is rare; pools are mostly a record of historical sweeps | #150s |

**Neither tests support/resistance.** S/R is a claim about price APPROACHING a pool and REACTING at
it — rejection, bounce, or a slowdown in the approach — not about what happens AFTER a sweep, and
not about whether pools function as objectives. **These are three different questions and I collapsed
them into one negative.** That is the same error shape as
[[feedback-dont-generalize-saturation-across-domains]]: a null in one relation treated as a null on
a different relation over the same object.

**What would settle it, and it is directly testable:** condition on price approaching an UNBROKEN
pool boundary from the untouched side (`ict/liquidity.js` already stores pool geometry, break state
and `broken_bar_idx`), then measure the reaction at first touch against a matched baseline of
random price levels drawn from the same bar distribution — the same null-model discipline #143 used.
Two separable sub-questions: (a) does the first touch produce a reaction at all (range compression,
rejection wick, direction change) versus a random level, and (b) does the reaction have tradeable
size under #143's frozen construction. **(a) can be real while (b) is blocked, and that distinction
must be preserved in the verdict rather than collapsed again.**

**Do NOT quote the sweep-reversal falsification as bearing on this.** It does not.

### RESULT (#192)

**(a) real, on 4h.** The touch bar closes back on the approach side **61.3%** of the time at a real
pool vs **48.2%** at matched placebo levels (n=269, z=3.27), all three instruments same direction.
1h is weak and inconsistent (53.6% vs 50.3%, z=1.66; SOL negative).

**(b) blocked.** The 12-bar reaction is null (pooled t=-1.31 on 1h, +1.48 on 4h, signs disagree) and
fading the touch loses on five of six cells.

**Reading:** pools are structure, not an entry — a candidate CONDITION on other signals, which is
exactly the role his core hypothesis (Q3) assigns them. The 1h/4h split is POST-HOC and unexplained,
the same weakness that sank #184's pre-registration.

---

## Q2. Why does the sweep flip q6 from exhaustion to continuation?

**His flagged line (2026-08-19), kept verbatim at his request:** *"I did not write down a mechanism
for why the sweep flips it."*

#188 found q6 ceiling excursions strongly bullish on all six instrument-rung cells. His claim is that
the SAME q6 ceiling excursion, when price sits above swept buyside liquidity, is BEARISH. Under his
framework (blue carries short information) q6 at its ceiling is peak short pressure and the usual
outcome is exhaustion and a bounce. **The sweep is the condition he says inverts that.**

Candidate framings exist — liquidity already taken means no fuel left above, so the short pressure
resolves DOWN instead of squeezing up — **but that is my inference and it is exactly the kind of
inference that produced the referent failure.** Recorded as a hypothesis awaiting HIS statement,
never as his position. Ask him; do not fill it in.

Answering this is **not required to run the test** — the test is fully specified without it. It IS
required before the result gets a causal reading either way.

---

## Q3. The core hypothesis — **RUN 2026-08-19, #193: REFUTED on 1h, INCONCLUSIVE on 4h**

**q6 at its ceiling + price above swept buyside liquidity → short.** Standing since #146. Tested on
the correct referent for the first time. #157 (q1) and #169 (q5) remain SUPERSEDED and never bore
on it.

**Refuted on the three testable cells, same direction each time.** Sweep within 50 bars: BTC 1h LONG
+0.0172% vs SHORT −0.7069% (n=147); ETH 1h +0.1559% vs −0.9036% (n=176); SOL 1h +0.7964% vs −1.5080%
(n=122).

**But the setup is real and carries information — it just points the other way.** The condition
SHARPENS the long: BTC 1h −0.1318% → +0.0172%, SOL 1h −0.0697% → +0.7964%.

**4h is NOT refuted — it is untested.** The recency-capped cells hold n=33–42, below the floor, on
exactly the rung where #188 found q6's edge. More data or a looser window is the honest next step,
**not** a re-run at a different threshold now that this result is known.

**His framework predicted this and his directional call contradicted it.** Blue carries short
information → q6 at ceiling is peak short pressure → exhaustion → up. Second time his semantics have
beaten a directional call (after #191).

**Still conditional on MY choices:** the 50-bar window, which is what separates a testable 18–22%
subset from a 99% tautology.

### The wick-through-and-reject reading (#194) — INCONCLUSIVE, too rare to test

Run at his request. Near-opposite configuration to #193: liquidity taken by a wick and REJECTED back
below, rather than closed above and held.

**The event barely exists.** Strict wick-reject sweeps occur on 5–55 bars in nine years per
instrument-rung; conditioned q6 populations land at n=3–30, **below the floor on all six cells**. The
loose variant clears the floor on only two of six (BTC 1h n=64, ETH 1h n=70). Ten of twelve cells are
untestable. Structural, not a coding artifact — most buyside pools resolve by a CLOSE above the top,
which is why #193's condition covered 86–99% of events.

**One cell leans his way, and only one.** ETH 1h loose: the short arm's win rate exceeds the long's
for the first time anywhere (35.7% vs 31.4%) and the condition destroys the long edge relative to its
complement (+0.2177% → −0.4467%). Net short is still negative (−0.5028%). **n=70, 1 of 12, looser
threshold — a hint, not evidence.**

**Practical note:** even if real, this fires once or twice a year per instrument-rung. Pursue as
understanding, not as a strategy candidate.

**What would settle it:** more instruments to lift n. **NOT** loosening the sweep definition or
widening the window — both are now known-outcome adjustments.

---

## Q4. Unbound referent

The price-pane **"yellow zone marker"** (#185). Candidates are ICT Concepts' bearish-OB break
`#f9ff57` and bullish-FVG break `#808000`. Needs a live-chart read. See `REFERENTS.md`.
