# PRE-REGISTRATION — bullish OB inside Strong Low, 4h: fresh-instrument gate (XLM)

**Committed before XLM data exists on disk.** Verified empty at commit time: no `binance-xlm-*.csv`
in `data/historical/`. `data/` is gitignored so the commit cannot itself prove absence; the honest
form of the guarantee is that this spec and its frozen runner land in one commit, the fetch is
timestamped after it, and **XLM appears in none of the 219 existing register rows.**

**This runs ONCE.** Runner: `scripts/signal-bus/smc/preregistered-ob-sl-xlm.js`, committed alongside.

## 1. This is a SECOND gate on the same construction — declared, not hidden

`PREREGISTRATION-ob-strong-low-forward.md` (committed 2026-08-21) already opened a FORWARD gate on
this construction, currently at 8/60 resolved. This spec opens a SECOND, independent gate on a fresh
instrument.

**That is two looks at one hypothesis and it is declared up front.** The two are not redundant —
they fail differently and therefore test different things:

- the **forward** gate tests whether the construction survives in time it has never seen;
- the **instrument** gate tests whether it survives in a market it has never seen, and answers in
  minutes rather than three months.

**Both results will be recorded regardless of outcome, and a PASS on one is not a PASS on the
other.** If they disagree, that disagreement is the finding and must be reported as such rather than
resolved by preferring the friendlier number.

## 2. Instrument

**XLM** (XLMUSDT, Binance), listed 2018, liquid major, deliberately chosen for a *different market
character* from the BTC/ETH-like majors the construction was built on — a construction that only
works on high-beta majors is worth knowing about. Native fetch **1h and 1d only** (~6.9 MB);
2h/3h/4h/1w synthesized by the standard aggregation. SMC corpus built `--tf=1w,1d,4h,3h,2h,1h`.

No other instrument is fetched. Storage was raised as a constraint (2026-08-21) and one instrument
is the minimum that answers the question.

## 3. The construction — frozen, byte-identical to the forward gate

Population from `scripts/signal-bus/smc/ob-strong-low-builder.js` and only there:

- **Signal**: bullish order block created on **4h** while `swingBias == BULLISH` (Strong Low, #198).
- **Entry**: next 4h bar open, LONG, maker fee, no entry slippage.
- **Stop**: 2.0×ATR(14), taker + 0.15 ATR slippage. **Target**: 2R, maker. **Timeout**: 200 bars.
- **Funding** 0.00125%/hr. 4h only — the 1h arm was excluded by the forward spec and stays excluded.

**Reference: the PHASE-AVERAGED +0.3899% (#212)**, never the single-grid +0.6282%.

## 4. Criteria

- **X-1 (gating)** — XLM net/trade > 0.
- **X-2 (gating)** — XLM net/trade beats a matched random-long null drawn from XLM's own Strong Low
  population (#210's rule; a rising market makes "> 0" insufficient alone). Beat = above the 95th
  percentile of 300 matched draws.
- **X-3 (validity floor)** — n ≥ 60 resolved. Below → **INCONCLUSIVE**, not FAIL.
- **X-4 (reported, non-gating)** — win rate vs the 33.3% breakeven, cluster t (#204), and the
  realised signal count against the ~310/instrument in-sample expectation.

**VERDICT = PASS iff X-1 AND X-2 with X-3 satisfied. FAIL iff X-3 satisfied and either missed.**

## 5. Discipline

- One run. No threshold, rung, cost or instrument change for any reason, including a near miss.
- A FAIL closes the construction in this form and the forward gate should be read in that light —
  **it does not get quietly continued in the hope the slower gate is kinder.**
- Scorecard at commit: #143 P, #165 F, #180 P, #186 F, #208A F, #208B P — **three of six.** This is
  test seven; the forward gate will be test eight.
