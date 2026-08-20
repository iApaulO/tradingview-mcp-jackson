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

**4h RESOLVED 2026-08-19 (#195): refuted there too.** Pooled BTC/ETH/SOL/XRP, n=150: LONG +0.7495%
vs SHORT −1.9678%. The condition moves the long UP (+0.4631% complement → +0.7495%) and the short
DOWN. **Two independent rungs now agree — the setup carries information and points opposite to the
call.** All thresholds inherited; only the instrument set changed.

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
widening the window — both are now known-outcome adjustments. Pooling all four (#195) still only
reached n=47 loose / n=18 strict, so this stays untestable without instruments not yet fetched.

---

## Q5. NEW — #188 is weaker than recorded, and the reserve gate is gone (#195)

**XRP does not replicate #188's magnitude.** XRP 4h q6-ceiling LONG is **+0.0910%** (n=188, t=0.14)
against BTC +0.4988%, ETH +0.7252%, SOL +0.7420%. Pooled over four instruments the ungated long is
+0.5172% with **t=1.69 on n=794 — does not clear t=2**.

Direction replicates (long beats short; short loses at −1.1470%, t=−1.95). Magnitude does not.
Three-of-four — the shape #186 warned about.

**#188 should now read: direction robust across four instruments, magnitude carried by three,
pooled significance marginal.** It is still the best thing in the Boom Hunter programme; it is no
longer "the strongest unvalidated candidate".

**The reserve gate is spent.** Every instrument in the corpus has seen q6. The only remaining clean
tests are **forward in time** (paper trade) or **instruments not yet fetched**. No in-sample
rearrangement substitutes.

---

## Q4. Unbound referent

The price-pane **"yellow zone marker"** (#185). Candidates are ICT Concepts' bearish-OB break
`#f9ff57` and bullish-FVG break `#808000`. Needs a live-chart read. See `REFERENTS.md`.

---

## Q6. NEW — his multi-stage trade construction from the 4h chart (2026-08-19)

**Recorded verbatim in structure because it is the most specific setup he has given, and NOT yet
tested.** His words: sharp boom signal returning within 1 bar, "especially when accompanied by bos
swing line on as on 26 jul... however, this would not be entry, because the ob hasnt fired yet, this
is configure the trade next, before the ob appears come two choch, the second wouldnt have fire yet
in the sequence i am showing you, bu the first choch that failed, that is our entry on trigger order.
when bullish ob fires the trigger gets it correct."

**The sequence, as I read it — HE MUST CONFIRM before anything is built:**

1. Sharp EOT3 signal (returns within 1 bar) + swing BOS present → **configure**, not enter.
2. Two CHoCHs form before the order block appears.
3. The **first CHoCH fails**. Its level becomes a **resting trigger order** — this is the entry.
4. The bullish OB fires and the resting trigger fills correctly.

**What our 4h data shows in that window (BTCUSDT, note the instrument caveat):**
BOS bullish internal 20 Jul 08:00 @64,967 → CHoCH bearish internal 27 Jul 20:00 @63,810 (with an
ACTIVE bearish OB 65,217–65,745) → CHoCH bullish internal 30 Jul 08:00 @64,745 **with a bullish OB
63,267–64,131**. That maps onto his sequence: the bearish CHoCH fails, a resting long trigger at
~63,810 fills when the bullish OB fires.

**Blockers before this is testable:**
- **"Failed CHoCH" is a new object we do not have.** `structure_events` has no failure flag. It needs
  a definition — e.g. a CHoCH followed by an opposite-direction CHoCH within N bars without reaching
  a continuation threshold — and that definition is a modelling choice he should sanity-check, not
  one I should pick alone.
- **"Sharp, returns within 1 bar" is not yet operationalised.** #197 shows two readings of that phrase
  (q6 excursion duration vs q5 bars-at-floor) give OPPOSITE answers. Ask which he means.
- **Instrument mismatch.** His chart is BTCUSD INDEX; our corpus is Binance BTCUSDT and ends
  2026-08-19 08:00 at 64,403 while his screen reads 69,402. Structure events will not align
  bar-for-bar.

**Confirmed independently from his image:** the drawn zone matches our EQH cluster (4h EQH at 64,200 /
64,425 / 64,692.83 / 65,744.60), and the 27 Jul EQH at 65,744.60 is EXACTLY the top of a still-active
bearish OB. His "the zone is formed by price before the EQH even form" is consistent with the box
starting late May while EQHs confirm from 9 Jun onward.

