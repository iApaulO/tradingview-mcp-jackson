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
| **"the yellow line"** | **q5** — Quotient5 | VERIFIED | #66. Pine's own input group is literally named `EOT 3 (Yellow Line)`; `Plot55` plots q5 in yellow (orange under the Light theme). Consistent with his statement that yellow carries long data. |
| **"the red wave"** | q3 / q4 — EOT2 pair | VERIFIED | Pine input group `EOT 2 (Red Wave)`; `Plot33`/`Plot44` both red, filled between. q4 ported #156. |
| **"green MSS line"** | bullish CHoCH (SMC `structure_events`) | VERIFIED | #185. ICT Concepts labels a bullish CHoCH as "MSS". Matched at 63,390.0 on 17 Aug 02:00 UTC against his 63,376 read. |
| "the green line" (SMC) | bullish structure line | VERIFIED | #90. SMC structure colour, price pane — a different domain from the oscillator panel, unambiguous. |
| "Blue Wave" | `computeBlueWave` | VERIFIED | #41/#42. A named component in the source, not a colour description. |
| **"yellow zone marker"** (price pane) | **UNBOUND** | **UNRESOLVED** | #185. Candidates in the verified colour map (#152): `#f9ff57` bearish-OB-break, `#808000` bullish-FVG-break. No ICT FVG in our data sits under the 17 Aug MSS. **Requires a live-chart read. Do not test anything that depends on it until bound.** |

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
- **"yellow zone marker"** — unbound, needs a live-chart read.
