# PRE-REGISTRATION — regime depth: does *how far into* a Strong Low a signal fires predict its outcome?

**Committed BEFORE the instruments it tests are fetched.** Same guarantee form as #208: `data/` is
gitignored so a commit cannot prove absence, but the plumbing making these symbols fetchable lands
in the SAME commit as this spec, the fetch is timestamped after it, and **XLM, TRX, ETC and DOGE
appear in none of the 209 existing register rows.**

**This runs ONCE.** Runner: `scripts/signal-bus/smc/preregistered-regime-depth.js`, committed
alongside this spec with every constant hard-coded.

## 1. Where the hypothesis came from, stated plainly

#209 found that the MSS **is** the transition into Strong Low — `swingBias` is BULLISH on 137/137
and 131/131 signal bars, mechanically, because `smc/calc.js` sets it on the bullish swing CHoCH
itself. That produced two results that only look contradictory:

- **#208A FAIL** — entering at the *instant* the regime is declared (depth = 0).
- **#208B PASS** — a q6 ceiling firing *during* an already-established regime (depth > 0, unmeasured).

**Hypothesis: Strong Low is a REGIME, not a trigger, and depth into it is the missing variable.**
Signals firing deeper into an established bullish regime outperform signals firing at or near its
declaration.

The hypothesis was *generated* from the existing eight instruments. It is *tested* here only on four
that did not inform it. That is the point of the exercise and the reason no depth statistic has been
computed on the existing corpus first — doing so would let the observed distribution set the
thresholds below.

## 2. Instruments and data

**XLM, TRX, ETC, DOGE** — Binance USDT, listed 2018–2019, liquid majors, none previously used.
Native fetch 1h/1d only; 2h/3h/4h/1w synthesized by the standard aggregation. SMC corpus built with
`--tf=1w,1d,4h,3h,2h,1h`.

## 3. The construction — inherited unchanged, not re-tuned

Event and trade mechanics are **exactly #208B's**, which is the arm that passed:

- Signal: q6 (Boom Hunter `Quotient6`, the blue Downward Boom Line — REFERENTS.md) crossing up
  through **105** on **4h**, with `swingBias == BULLISH` at the signal bar.
- Entry next 4h bar open, LONG. Stop 2.0×ATR(14). Target **2R**. Maker costing per #200: maker
  entry with no entry slippage, maker target, taker + 0.15 ATR slippage on the stop, funding
  0.00125%/hr. 200-bar timeout; a window running off the data edge is EXCLUDED, never marked to
  market.

**Only one thing is added: `depth` = bars between the most recent bullish swing CHoCH (the MSS that
opened the regime) and the signal bar.** Well-defined by construction — `swingBias == BULLISH`
guarantees a prior bullish swing CHoCH exists.

## 4. The split — thresholds fixed a priori, not from data

**SHALLOW = depth ≤ 12 bars. DEEP = depth > 12 bars.**

12 bars on 4h is **two calendar days**, chosen as a round unit of time before any depth distribution
was computed. It is not a median, not a quantile, and not tuned. If the realised split is badly
lopsided the test may land INCONCLUSIVE on the population floor — that is an accepted cost of
fixing the threshold honestly rather than fitting it.

## 5. Criteria

- **D-1 (gating)** — DEEP net/trade > SHALLOW net/trade.
- **D-2 (gating)** — DEEP net/trade > 0.
- **D-3 (validity floor)** — n ≥ 60 in **each** bucket. Either below → **INCONCLUSIVE**, not FAIL.
- **D-4 (reported, non-gating)** — cluster t for each bucket (q6 events can overlap; clusters
  chained per #204's adopted rule); Spearman rank correlation between raw `depth` and net return;
  per-instrument nets; and whether SHALLOW is *actively negative* (which would corroborate #208A)
  or merely weaker.

**VERDICT = PASS iff D-1 AND D-2 met with D-3 satisfied. FAIL iff D-3 satisfied and either gating
criterion missed.**

## 6. Discipline

- Single run of the committed runner. No threshold, bucket, rung, or instrument changes for any
  reason, including a near miss.
- Result appended to the register with the verdict stated mechanically, whatever it is.
- **Scorecard at commit: #143 PASS, #165 FAIL, #180 PASS, #186 FAIL, #208A FAIL, #208B PASS — three
  of six.** This is test seven. A 50% base rate is the honest prior for what follows.
- A PASS establishes depth as a real conditioning variable and authorizes nothing beyond paper
  accumulation. A FAIL closes the regime-depth hypothesis in this form — and specifically must not
  be followed by re-running at a different depth threshold.
