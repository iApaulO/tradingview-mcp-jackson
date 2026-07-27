# Proof Audit — `ict-smc-trader`, via institutional-quant lens

Date: 2026-07-26. Reviewer stance: `institutional-quant` (evidence hierarchy, claim-labeling
discipline, adversarial-review habits from `research-protocol.md`'s own checklist — "how could
this result be leakage, what's the simplest null, would a skeptical PM trust this tomorrow").
This audit re-read every file in the skill pack against the 8 commissioned criteria, cross-checked
claims against `ARCHITECTURE.md` directly (not against the skill's own PRIOR_ART.md, to avoid
grading the skill against itself), and revised the pack where it found real problems rather than
listing them as residual risk to leave for later.

## Bottom line

**Green, after three real fixes applied during this audit, not before it.** The pack did not pass
clean on the first pass — an internal-consistency defect in the scoring arithmetic and a genuine
prior-art gap were both found and corrected in place. That's disclosed below in full, not smoothed
over, because a proof audit that only ever reports "looks good" isn't doing its job.

## What was found and fixed (not just noted)

### 1. Scoring arithmetic didn't match its own stated maximums (criteria #1, #8)

`decision-policy.md`'s original draft stated "HTF layer, weight ×3 each, max 6 points" then
defined **three separate sources** each independently scored -3/0/+3 per timeframe — which sums
to a real max of 18 for that layer (2 TFs × 3 sources × 3 points), not the stated 6. The same
error repeated at the structure and trigger layers (stated maxes of 12 and 6; actual maxes of 18
and 9). A scoring system whose documented ceiling doesn't match its own arithmetic is not usable
without ambiguity — direct failure of criterion 8, and an internal-consistency defect under
criterion 1.

**Fix applied:** rebuilt the scoring unit around one synthesized -1/0/+1 read per timeframe
(informed qualitatively by that timeframe's available sources, not summed across them), multiplied
by a per-layer weight (HTF ×3, structure ×2, trigger ×1 base + up to ×1 quality bonus). New,
verified max: 6+6+3+3=18. Band thresholds rescaled to match. Re-verified by hand: HTF max 2×1×3=6 ✓,
structure max 3×1×2=6 ✓, trigger max 3×1×1 + 3×1=6 ✓, total 18 ✓.

### 2. Missed ARCHITECTURE.md §7 in the first Phase 0 pass (criterion 4)

Phase 0's inventory covered §1–3 and §6–10 thoroughly but skipped §7 (Empirical Research Log) —
the section documenting that the *wider* ICT/SMC methodology (not this house's specific
reimplementation) has genuine, unresolved controversy in public literature: an unfalsifiability
critique, a 5-million-path Monte Carlo showing chance alone can produce "ICT success stories,"
and sparse peer-reviewed coverage either way. This is directly relevant to how confidently the
skill should ever speak about ICT/SMC as a discipline, independent of this house's own tested
findings — a real incorporation gap, not a stylistic one.

**Fix applied:** added §2a to `PRIOR_ART.md` (full findings + sources), register row #23 in
`significance-register.md`, and an explicit persona line in `SKILL.md` instructing the skill to
say this plainly if asked whether ICT/SMC "works" in general.

### 3. No standing caution against the scoring system repeating the exact failure it documents (criterion 5)

The pack correctly flagged Divergence-for-Many's untested 6-indicator sweep as a
multiple-testing/data-dredging risk (register #9) but had no equivalent warning about the skill's
*own* future use: grading many live setups over time and only remembering the sessions that graded
Strong and won is the identical failure mode, just moved from indicator-selection to
setup-selection.

**Fix applied:** added a "Standing risk" section to `decision-policy.md` naming this directly and
requiring both hits and misses to be tracked if a track record is ever claimed.

A fourth, smaller gap (no invalidation/kill-criteria field in the primary output template) was
also fixed in `output-contracts.md`'s Board Brief — added "What would invalidate this grade" as a
required, specific field, matching criterion 2's falsifiability requirement more literally than
the vetoes list alone did.

## Score, post-fix

| # | Criterion | Verdict | Basis |
|---|---|---|---|
| 1 | Internal consistency | **Pass** | Scoring arithmetic fixed and hand-verified above; every number in `PRIOR_ART.md`/`significance-register.md` cross-checked directly against `ARCHITECTURE.md` (grep-verified: 34.7%, 68.0%, 53.4%, 60.6%, 81.15%, 0.070%/0.065%, all match source exactly) |
| 2 | Falsifiability / invalidations | **Pass** | `SKILL.md` decision-gate table gives explicit fail conditions; `decision-policy.md` has hard vetoes, soft downgrades, and a hard HTF-opposition veto; output contract now requires a specific kill-criteria field per setup |
| 3 | Honest significance labels | **Pass** | Six-label taxonomy applied consistently across `PRIOR_ART.md` and `significance-register.md`; critically, the two SMC confluence findings are kept as *separate* rows with *different* labels (descriptive-significant vs. trade-construction-blocked) rather than collapsed into one verdict — this is the single easiest place a less careful writeup would have cheated |
| 4 | Incorporation of prior art | **Pass, after the §7 fix above** | §9/§10 were captured correctly on the first pass (spot-checked: confluence gradients, both significance tests, the trade-construction-blocked backtest, the falsified liquidity finding, the touch-detection and confluence-tolerance bugs found and fixed mid-session — all present with correct numbers). §7 was the miss, now closed |
| 5 | Multiple-testing / MTF leakage awareness | **Pass, after the standing-risk fix above** | Confluence weighting explicitly cites the *tested* gradient rather than inventing new cross-TF-agreement claims; the indicator-sweep is correctly kept as "unknown/untested, 16 comparisons, zero correction" rather than upgraded; the new standing-risk section closes the remaining gap (the skill's own future usage pattern) |
| 6 | Risk contract compatibility with `rules.json` | **Pass** | `risk_rules` treated as inviolable, quoted not reinterpreted, in both `decision-policy.md`'s veto #1 and `output-contracts.md`'s target-policy proposal format, which explicitly excludes `risk_rules` from any proposed change |
| 7 | Clear non-merge with quant epistemology | **Pass, after a correction — see Addendum** | Sibling-skill language is symmetric with institutional-quant's own existing "Sibling skill (planned, keep separate): ict-smc-trader" line — this pack completes that pairing rather than contradicting it; `~/.claude/skills/institutional-quant/` file timestamps confirmed unmodified by this work (verified via `ls -la --time-style=full-iso`, all predate this session's work on this skill). The original claim that this skill's six labels were "inherited" from `institutional-quant/epistemology.md` was **factually wrong** — see Addendum below |
| 8 | Drives a future rules/signal-bus without ambiguity | **Pass, contingent on the arithmetic fix above** | Missing-data handling now has an explicit rule (score 0, flag it, never skip silently); the target-policy output contract (§D) gives a concrete path from the current `rules.json` stub to something that encodes this policy |

## Accepted residual risks (not defects — disclosed, not fixed, because fixing them isn't this
pack's job)

- **The point-weight system itself (HTF×3, structure×2, trigger×1, tier bonuses) is a judgment
  call, not independently significance-tested.** This is by design per the commission ("weighted
  confluence... adjust only with justification") and the pack says so in three separate places
  (`decision-policy.md`'s closing section, the new standing-risk section, `SKILL.md`'s persona).
  A real test would require a track record of graded setups against outcomes, which doesn't exist
  as data yet — building that is future work, not something to fake now.
- **Boom Hunter has zero signal-bus coverage** (no reimplementation, no touches, no significance
  test — PRIOR_ART.md §2). Correctly reflected as `missing`/live-only throughout rather than
  quietly upgraded to match the other four indicators' depth. This is a real gap in the underlying
  project, not something this skill pack should paper over.
- **Confluence tolerance constants (0.2% price band, 200-bar-equivalent decay for point sources)**
  are inherited from the signal-bus work, where they're already flagged as "a starting assumption,
  not validated." This skill correctly carries that same uncertainty forward rather than
  overstating confidence just because the number is now one layer removed from where it was
  first introduced.

## What would change this verdict

A future signal-bus test that contradicts a `significance-register.md` row without the register
being updated to match — that would be the specific failure mode to watch for, since it's exactly
the kind of drift PRIOR_ART.md §7's closing note warns about ("update this file, don't let it
drift"). Recommend a lightweight habit: any time `ARCHITECTURE.md` gets a new §9/§10-style finding,
touch `significance-register.md` in the same sitting.

---

## Addendum — second audit pass, requested independently, 2026-07-26

The first pass above was written by the same author who wrote the skill, in the same sitting —
a real conflict-of-interest limitation, disclosed at the time but not fully corrected for. A
second, explicitly independent pass was requested afterward. It re-verified rather than re-stated:

- **Decision-policy.md's scoring arithmetic** (the fix from the first pass) was hand-recomputed
  from the file as committed, not from memory of writing the fix: HTF 2×1×3=6, structure 3×1×2=6,
  trigger base 3×1×1=3, trigger bonus 3×1=3, total 18 — matches the file's own stated total.
  Confirmed correct.
- **`significance-register.md` row numbering** re-checked programmatically (1–23, no gaps, no
  duplicates). Clean.
- **One real, factual error found and fixed:** both `SKILL.md` and this file's own criterion-7
  row claimed the six significance labels were "inherited from `institutional-quant/epistemology.md`,
  not reinvented." That's false — checked institutional-quant's actual label table (Established /
  Supported / Hypothesized / Descriptive / Contradicted / Unknown) directly against this pack's six
  (descriptive-significant / trade-construction-blocked / falsified / engineering-complete /
  stub-outdated / unknown-untested). They are a **different vocabulary**, not a renamed copy — two
  labels here (`trade-construction-blocked`, `engineering-complete`) have no equivalent in
  institutional-quant's scheme at all. The first-pass audit asserted a specific factual claim
  (inheritance) without checking it against the actual source text, in the same session it was
  writing that source text from memory. That's exactly the kind of unverified-but-plausible-sounding
  claim both skills exist to catch in *other* people's work — worth naming directly rather than
  quietly fixing and moving on.

**Fix applied:** `SKILL.md` and this file's criterion-7 row rewritten to describe the actual
relationship accurately — a shared epistemic *stance* (label everything, never fake confidence,
name what would change the verdict), not a shared label *taxonomy*. Criterion 7 remains a Pass,
but on the corrected basis, not the original one.

**What this addendum itself does not claim:** that this second pass is now exhaustive or immune
to the same conflict of interest — it was still performed by the same reviewer, just with an
explicit instruction to re-verify rather than re-assert. A genuinely third-party read (a different
model instance, or a human) would be a stronger check than either pass here.
