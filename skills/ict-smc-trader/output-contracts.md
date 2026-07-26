# Output Contracts

Pick one template per response type. Stay inside it unless the user asks for another form.

---

## A) MTF Board Brief

The primary deliverable — grading a live setup across the full ladder.

```markdown
# Board Brief — [symbol] — [timestamp]

## Grade: [Strong / Medium / Weak / No-trade]
[1-2 sentences: what's driving the grade, in plain language]

## HTF bias layer (W, D)
| TF | SMC structure bias | Cipher A ribbon | SuperTrend regime | Score |
|----|--------------------|-----------------|--------------------|----|

## Structure layer (4H, 3H, 2H)
| TF | SMC OB / BOS-CHoCH | Divergence zone (confluence degree) | Cipher B context | Score |
|----|---------------------|--------------------------------------|-------------------|----|

## Trigger layer (1H, 15m, 5m)
| TF | Boom Hunter tier | Lower-TF SMC/Div touch | SuperTrend flip | Score |
|----|-------------------|--------------------------|-------------------|----|

## Vetoes checked
- [ ] rules.json risk_rules — [pass/fail, which one if fail]
- [ ] HTF opposition — [pass/fail]
- [ ] Liquidity-sweep-as-signal — [confirm NOT used]
- [ ] Naive confluence-only entry — [confirm NOT presented as standalone]

## What would invalidate this grade
[Specific, checkable: e.g. "a 1H close back below the swing order block's low," "W turning
opposed," not a vague "if it stops working." This is the setup's kill criteria, not optional.]

## Ambiguous fields flagged this read
[Any of: exit_warning_ambiguous, break_ambiguous, inferred (not extracted) SMC direction, etc.]

## Proxy disclosures
[e.g. SuperTrend `[via BTCUSD proxy]`]

## Explicit non-claims
Not financial advice. No orders placed. Human decides. Score reflects discretionary weighting of
tested inputs, not a backtested scoring system itself.
```

---

## B) Setup Grade Card (compact — for a quick check, not a full board sweep)

```markdown
# Setup: [symbol] [direction] — Grade: [band]

**Why:** [one paragraph, cites the 2-3 load-bearing inputs by name and significance label]
**Vetoes:** [none tripped / which one]
**Confidence caveats:** [ambiguous fields, proxy reads, inferred vs. extracted direction]
**What would upgrade this:** [specific next confirmation needed]
```

---

## C) Confluence / Significance Note

Use when the user asks "is X actually real" about any house-stack finding.

```markdown
# Significance check: [finding]

**Label:** [descriptive-significant / trade-construction-blocked / falsified /
engineering-complete / stub-outdated / unknown-untested]
**What was tested:** [the actual test, method, sample size]
**Result:** [real numbers, not paraphrased]
**What this does NOT mean:** [the adjacent claim it's easy to conflate this with]
```

---

## D) Rules.json Target Policy Proposal

Use when helping the user move `rules.json` from its current stub toward the house policy.

```markdown
# rules.json target policy proposal

## Current state
[quote the actual current bias_criteria — flag it as a stub, per PRIOR_ART.md]

## Proposed target
[a `bias_criteria`-shaped block that actually encodes decision-policy.md's layers, e.g. by
timeframe and indicator, in the same plain-language style rules.json already uses]

## What stays unchanged
risk_rules — these are the user's own standing rules, not touched by this proposal.

## Not proposing yet
[anything decision-policy.md itself flags as untested — e.g. don't propose the scoring weights as
"proven," propose them as "the current best discretionary layering"]
```

---

## E) Dual-lens stub (only if user asks for ICT + quant, mirrors institutional-quant's own template)

```markdown
# Dual lens — [symbol / topic]

## ICT/SMC lens (this skill)
Grade / vetoes / significance labels on the inputs used

## Quant lens
Deferred to `institutional-quant` — summary only if that skill is loaded this session; else ask
the user to invoke it directly.

## Overlap
Where bias / invalidation / risk agree

## Conflict
Where the two lenses disagree — do not force a reconciliation into false certainty. State both,
name the disagreement, let the human weigh it.
```
