# PRE-REGISTRATION — fresh instruments: MSS R4 and the flagship q6+StrongLow

**Committed BEFORE any data for these instruments exists on disk.** At the time this spec and its
runner are committed, `data/historical/` contains no `binance-bnb-*`, `binance-ada-*`,
`binance-ltc-*`, or `binance-link-*` files. `data/` is gitignored, so the commit itself cannot
prove that absence — the honest form of the guarantee is: the plumbing that makes these symbols
fetchable lands in the SAME commit as this spec, and the fetch is timestamped after it. None of
BNB, ADA, LTC, LINK appears in any of the 207 existing register rows.

**This runs ONCE.** The runner is `scripts/signal-bus/smc/preregistered-fresh-instruments.js`,
committed alongside this spec with every constant hard-coded. Changing any value after seeing a
result invalidates the run and must be recorded as such, not quietly re-run.

## 1. Instruments and data

BNB, ADA, LTC, LINK — Binance USDT spot klines, listed 2017–2019, liquid majors. Native fetch:
**1h and 1d only** (`--tf=1h,1d`, full mode); 2h/3h/4h/1w synthesized by the standard aggregation.
15m/5m are not fetched and nothing here uses them. SMC corpus built with
`--tf=1w,1d,4h,3h,2h,1h`.

## 2. Two frozen constructions — two tests, both reported

This spec deliberately registers TWO tests on the same fresh data. That is two looks, stated up
front; both results are reported regardless of outcome, and a pass on one is not evidence for the
other.

### Test A — MSS R4 (#206, the trim-robust arm)

Population from `scripts/signal-bus/smc/mss-r4-builder.js` and only there: bullish 4h SWING-scope
CHoCH, entry next 4h bar open, 2.0×ATR(14) stop (taker + 0.15 ATR slip), 4R target (maker), maker
entry, 200-bar timeout, funding 0.00125%/hr. LONG only.

In-sample reference (#206): +2.8241%/trade, 34.4% win, n=131 pooled BTC/ETH/SOL/XRP.

**Criteria:**
- A-1 (gating): pooled net/trade across the four fresh instruments > 0.
- A-2 (validity floor): pooled n ≥ 40. Below floor → INCONCLUSIVE, not FAIL.
- A-3 (reported, non-gating): per-instrument nets and cluster t.

**VERDICT A = PASS iff A-1 met with A-2 satisfied. FAIL iff A-1 not met with A-2 satisfied.**

### Test B — flagship q6 ceiling + Strong Low (#199/#200/#204, as audited)

q6 (Boom Hunter `Quotient6`, the blue Downward Boom Line — REFERENTS.md) crossing up through 105
on 4h, gated on `swingBias == BULLISH` at the signal bar (LuxAlgo's Strong Low state, exposed
#198). Entry next 4h bar open, LONG, 2R target @ 2.0×ATR(14), maker costing per #200 (maker entry,
no entry slip, maker target, taker + 0.15 ATR stop, funding). 4h ONLY — the 1h arm died in the
#204 audit and is not tested.

In-sample reference (#204, audit-corrected): +1.2862%/trade, cluster t=2.31, n=435 pooled 4h.

**Criteria:**
- B-1 (gating): Strong-Low-conditioned pooled net/trade > 0.
- B-2 (gating): conditioned net beats the non-Strong-Low complement's net on the same instruments.
- B-3 (validity floor): conditioned pooled n ≥ 60. Below floor → INCONCLUSIVE.
- B-4 (reported, non-gating): cluster t (q6 events can overlap; clusters chained per #204).

**VERDICT B = PASS iff B-1 AND B-2 met with B-3 satisfied.**

## 3. Discipline

- Single run of the committed runner. No threshold, window, or scope changes for any reason.
- Whatever happens is appended to the significance register with the verdicts stated mechanically.
- Scorecard context at commit time: pre-registrations run to date — #143 PASS, #165 FAIL, #180
  PASS, #186 FAIL. Two of four. These are tests five and six.
- A PASS here authorizes nothing beyond continued paper accumulation; it upgrades the evidence
  tier of the passing construction. A FAIL closes the construction in its current form.
