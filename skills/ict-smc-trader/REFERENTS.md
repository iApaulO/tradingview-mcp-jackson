# REFERENT REGISTRY

**Every object iapaulo names by a visual property — a colour, a shape, a position — bound ONCE to a
concrete identifier, with the evidence that binding rests on.**

## Why this exists

The "blue line" cost six register rows and two false verdicts. He named it in #146. I resolved it
from Pine defaults as **q1** and tested his claim against it (#157: *"REFUTED, 29 of 30 cells
wrong-signed"*). He corrected me; I re-resolved as **q5** and tested again (#169: *"every testable
cell loses money"*). Both rows entered the register as settled negatives on **his** hypothesis. They
were settled negatives on **two series he had never mentioned**.

Reading the register afterwards, the play looked dead — twice, in bold. That is why nobody returned
to it for a week. **The identification error did not merely waste a test; it wrote a false closure
into the institutional memory, which is self-reinforcing.**

Only in #187, from a chart image, was the blue line identified as **q6**. His actual claim — *price
above buyside liquidity + the blue line to the top → bearish* — **has still never been tested.**

## The root cause, found 2026-08-19 during the full signal inventory (#190)

**Boom Hunter's plot titles are wrong and they collide.** Enumerating every `plot` in
`boom-hunter-pro.pine`:

| Pine var | actually plots | title TradingView reports | colour |
|---|---|---|---|
| `Plot33` | q3 | `Quotient 1` | red |
| `Plot44` | q4 | `Quotient 2` | red |
| `Plot54` | **q6** | `Quotient 1` | **blue** (hardcoded) |
| `Plot55` | **q5** | `Quotient 1` | **yellow** |
| `Plot` | q1 | `Quotient 2` | state-dependent |
| `Plot4` | q1 (again) | `Quotient 2` | `osccol` input, **default blue** |
| `Plot3` | trigger | `Quotient 1` | `trigcol`, default white |

**Four different series report as `Quotient 1`. Not one title is correct.** q1 is also plotted twice,
with `Plot4` redrawing it in flat blue on top of the informative state-colour plot — which is why q1
looks plainly blue on the chart.

So there were **two blue objects** (`Plot54`=q6, `Plot4`=q1) whose Data Window titles were identical
to two other series', and the visual distinction between them was destroyed by overdraw. Resolving
"the blue line" from titles or from Pine defaults was never going to work. **This is not an excuse —
enumerating the plots is a ten-minute job I should have done in #146 — but it does mean the fix is
structural: never resolve a Boom Hunter series by its TradingView title.**

## The three rules this registry enforces

1. **Bind before testing.** No test proceeds on an object named by a visual property until it is
   bound here. Binding is verified against the LIVE CHART or against unambiguous source (an input
   group literally named for the colour). Pine defaults alone are NOT sufficient when the source
   contains more than one object of that colour — which is exactly what went wrong.
2. **The referent travels with the verdict.** Any row testing a user claim must name its bound
   referent *in the verdict itself*, not only in the setup. #157 did say "the blue line is q1" in its
   preamble, and the conclusion still got quoted downstream as a plain refutation.
3. **Correcting a binding retroactively marks every row that used the old one.** Those rows are
   marked **SUPERSEDED — WRONG REFERENT**, not left standing as results.

## Bindings

| iapaulo's term | bound to | status | evidence |
|---|---|---|---|
| **"the blue line"** | **q6** — Downward Boom Line | **VERIFIED** | #187. Chart image showed two sharp vertical spikes; q6 ran floor→ceiling at 17 Aug 04:00–07:00 and 16:00–20:00, matching exactly. q5 was pinned at 110 throughout and q1 wandered 65–110 — neither produces two distinct spikes. Pine `Plot54 = plot(showdboom ? q6 : na, color=color.new(color.blue, 0))`. |
| **"the yellow line"** | **q5** — Quotient5 | **VERIFIED** | #66/#190. Pine's own input group is literally named `EOT 3 (Yellow Line)`; `Plot55` (L264) plots q5. **Always yellow** — the Light-theme orange branch is unreachable because `theme` is hardcoded to `'Dark'` at L10 with its input commented out. (An earlier version of this row hedged with "orange under the Light theme"; that branch is dead code.) Consistent with his statement that yellow carries long data. |
| **"the red wave"** | q3 / q4 — EOT2 pair | VERIFIED | Pine input group `EOT 2 (Red Wave)`; `Plot33`/`Plot44` both red, filled between. q4 ported #156. |
| **"green MSS line"** | bullish CHoCH (SMC `structure_events`) | VERIFIED | #185. ICT Concepts labels a bullish CHoCH as "MSS". Matched at 63,390.0 on 17 Aug 02:00 UTC against his 63,376 read. |
| "the green line" (SMC) | bullish structure line | VERIFIED | #90. SMC structure colour, price pane — a different domain from the oscillator panel, unambiguous. |
| "Blue Wave" | `computeBlueWave` | VERIFIED | #41/#42. A named component in the source, not a colour description. |
| **"yellow zone marker"** (price pane) | **UNBOUND** | **UNRESOLVED** | #185. Candidates in the verified colour map (#152): `#f9ff57` bearish-OB-break, `#808000` bullish-FVG-break. No ICT FVG in our data sits under the 17 Aug MSS. **Requires a live-chart read. Do not test anything that depends on it until bound.** |

## BEHAVIOUR, not just identity (added 2026-08-19, #196)

**Binding a referent is not enough — characterise how it MOVES before building a test on it.** Eight
rows of q5/q6 work preceded the first measurement of q5's actual behaviour, and iapaulo had to point
that out.

| series | native state | departure | time at extreme | round trip |
|---|---|---|---|---|
| **q5** (yellow, `Plot55`, K13=+0.9999) | **CEILING, 96.2-96.9% of bars** | SNAPS down — down leg median **0 bars** | median **3 bars** at the floor | median **3 bars** total |
| **q6** (blue, `Plot54`, K33=-0.9999) | **FLOOR, ~96% of bars** | snaps up | ~4% of bars above 50 | mirror of q5 |

The Mobius transform at |K| -> 1 is why both snap rather than oscillate: they render as vertical
spikes, not waves. **Consequence that matters for every test: a q5 round trip completes in a median
of 3 bars, so "entry at the floor" and "entry on the return to ceiling" are ~3 bars apart and are
very nearly the same trade.**

**His signal model, which the register ignored for eight rows:** the line leaving its native state is
HALF a signal; the RETURN is the other half; the signal is the completed round trip. And **sharp tips
perform differently from flat** — confirmed in #196 (sharp long -0.1968% vs flat -0.9714%).

## His stated semantics — recorded because it reframes results, not just names

**Blue carries SHORT information. Yellow carries LONG information.** (2026-08-19.)

This is why the source naming coheres: `showdboom` gates q6, the "**Downward** Boom Line" — the
downward/short line, blue. q5 is the yellow one.

It also reframes #188 rather than contradicting it. #188 tested q6 ceiling excursions **alone** and
found them strongly bullish on all six instrument-rung cells, with shorting them catastrophic. If
blue carries short data, q6 pinned at its ceiling is **peak short pressure**, and a bullish move
afterwards reads as *exhaustion*, not as the line being mislabelled.

His claim then says that the same condition **plus price above swept buyside liquidity** is bearish.
Those are not in conflict: the liquidity state is what would separate exhaustion from continuation,
and it is the part that has never been attached to the correct series. **Why the sweep flips it is
his model and is NOT recorded here, because he has not stated it and I will not infer it.**

## Open

- **q6 + price above swept buyside liquidity → short.** His standing hypothesis since #146. Still
  untested. #157 and #169 are marked SUPERSEDED and do not bear on it.
- **"yellow zone marker"** -- unbound, needs a live-chart read.

### QUEUED — iapaulo's, not mine, do not lose (2026-08-19)

**"I did not write down a mechanism for why the sweep flips it."** He flagged this line specifically
and asked for it to be kept. It is the open question, stated as a question and NOT answered here:

> #188 found q6 ceiling excursions strongly bullish on all six instrument-rung cells. His claim is
> that the SAME q6 ceiling excursion, when price sits above swept buyside liquidity, is BEARISH.
> **What does the sweep change?** Under his framework (blue = short information), q6 at its ceiling
> is peak short pressure; the usual outcome is exhaustion and a bounce. The sweep is the condition
> he says inverts that.

Candidate framings exist — liquidity already taken means no fuel left above, so the short pressure
resolves DOWN instead of squeezing up — **but that is my inference and it is exactly the kind of
inference that caused the referent failure.** It is recorded here as a hypothesis awaiting HIS
statement, never as his position. Ask him; do not fill it in.

Answering this is not required to run the test — the test is fully specified without it. It IS
required before the result gets a causal reading either way.
