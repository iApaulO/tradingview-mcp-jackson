# PRE-REGISTRATION — bullish OB inside Strong Low, 4h: FORWARD test

**This is a FORWARD pre-registration, and that framing is the whole point.** Every instrument in the
corpus has been used. XRP was spent in #195; BNB/ADA/LTC/LINK in #208; XLM/TRX/ETC/DOGE will not be
fetched (iapaulo, 2026-08-21: storage). **A temporal holdout on data that informed the hypothesis is
a robustness check, not an out-of-sample test, and calling it one would be dishonest.** Forward time
is the only clean gate left, so this spec commits to it before the data exists — which is the
strongest form of the guarantee available and stronger than #180's or #208's.

**Committed 2026-08-21. Every trade counted against it must have an entry timestamp AFTER this
commit.** Trades before it are history and are excluded by the ledger's PAPER_START discipline.

## 1. The construction — frozen, inherited from #211/#212 unchanged

- **Signal**: a BULLISH order block created on **4h** while `swingBias == BULLISH` (LuxAlgo's Strong
  Low state, exposed in #198). Read from `smc/calc.js` — never recomputed elsewhere.
- **Entry**: next 4h bar OPEN, LONG, maker fee, no entry slippage.
- **Stop**: 2.0×ATR(14), taker fee + 0.15 ATR slippage (a stop is a market order).
- **Target**: 2R, maker fee (a resting limit).
- **Timeout**: 200 bars, taker exit. Funding 0.00125%/hr throughout.
- **Instruments**: BTC, ETH, SOL, XRP, BNB, ADA, LTC, LINK — all eight, pooled.

**No rung pooling** (#204): 4h only. The 1h arm was measured at the 36th percentile against its null
in #211 and is excluded by this spec, not by later choice.

## 2. In-sample reference — what the forward run is being tested against

| | net/trade | n | vs matched null |
|---|---|---|---|
| ORIGINAL 4h | +0.4152% | 1,238 | 97.3rd pct |
| FRESH 4h | +0.6282% | 1,318 | 99.7th pct |
| **phase-averaged (#212)** | **+0.3899%** | — | survives all 4 grid phases |

**The phase-averaged +0.3899% is the reference figure**, per #212's standing rule — the single-grid
+0.6282% was the luckiest of four alignments and must not be used as the benchmark.

## 3. Criteria — evaluated when n ≥ 60 forward trades have RESOLVED

- **F-1 (gating)** — forward net/trade > 0.
- **F-2 (gating)** — forward net/trade beats a concurrent random-long null drawn from the same
  Strong Low population over the same forward window (#210's rule; a bull market makes "> 0"
  insufficient on its own).
- **F-3 (validity floor)** — n ≥ 60 resolved. Below that the test is simply NOT YET ANSWERED and no
  verdict may be stated in either direction.
- **F-4 (reported, non-gating)** — win rate against the 33.3% breakeven, cluster t, per-instrument
  breakdown, and realised vs expected arrival rate.

**VERDICT = PASS iff F-1 AND F-2 with F-3 satisfied. FAIL iff F-3 satisfied and either gating
criterion missed.**

## 4. Discipline

- The construction is frozen. No threshold, rung, instrument, or cost change for any reason,
  including a near miss or a bad run of luck.
- **Expected arrival ~2,500 in-sample trades over ~9 years across 8 instruments ≈ 280/yr ≈ 5/week.**
  n ≥ 60 should therefore arrive in roughly three months, not years — this is the fastest clean gate
  available, which is why it is worth spending forward time on.
- Interim readings may be LOOKED AT but **no verdict may be declared before F-3 is met.** Stopping
  early on a good run is the most common way a forward test is corrupted.
- Scorecard at commit: #143 PASS, #165 FAIL, #180 PASS, #186 FAIL, #208A FAIL, #208B PASS — **three
  of six.** This is test seven and the base rate is 50%.
- A PASS upgrades the construction to forward-confirmed and authorises nothing beyond continued
  accumulation. A FAIL closes it in this form.
