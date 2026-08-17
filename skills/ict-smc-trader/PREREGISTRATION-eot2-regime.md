# PRE-REGISTRATION — EOT2 saturation, regime-conditional, single run on SOL

**Frozen 2026-08-16, before `boom-hunter-sol.db` existed.**
Register rows: hypothesis from #159–#162, adjudication in #164. This document is the specification.
Nothing below may be changed after results are seen. **The run happens once.**

---

## 1. Why this needs pre-registering

#164 found that the EOT2 saturation construction works *with* the prevailing regime on both sides
and both instruments — long in bull regimes, short in bear regimes — beating a same-regime
random-entry baseline in all four aligned cells while all four counter-regime cells stayed dead.
That refuted the drift confound #162 could not rule out.

**But the regime definition was introduced after #162's long-only failure was already known.** One
definition was tried, it was declared before that run, and no lengths were swept — but it was not
frozen before the construction existed. A reader is entitled to ask whether SMA(200) happens to be
the one cut that worked, and #164 cannot answer that. This run is the answer.

### Honest statement of the guarantee, which is weaker than #143's

#143 could state that SOL price data did not exist in this repository at the moment its
configuration was committed. **That is not true here.** SOL candles were built earlier in this same
session (`binance-sol-*.csv`, 2026-08-16) for #143's own run, so the price data is present and I
could in principle have looked at it.

What *is* true and verifiable: **Boom Hunter has never been computed on SOL.**
`data/signal-bus/boom-hunter-sol.db` does not exist at this commit, no script in
`scripts/signal-bus/boom-hunter/` has ever been invoked with `--instrument=SOL`, and the only SOL
references anywhere in that directory are a prose comment and the `DB_FILES` filename mapping.

So the guarantee is **"the hypothesis has never been evaluated on this instrument"**, not
**"the data did not exist"**. That is a real difference and it is stated here rather than glossed,
because the whole value of a pre-registration is that its limitations are declared in advance.

---

## 2. Frozen configuration

Every constant below is hard-coded in the runner rather than exposed as a CLI flag — deliberately,
on #143's reasoning that a sweepable parameter is one that will get swept.

### Instrument and rung
| Item | Value |
|---|---|
| Instrument | **SOL** (SOLUSDT, Binance) |
| Rung | **4h only** |

4h is where #162 located the surviving effect and where #164 ran. 1h is excluded: it failed on BTC
and was marginal on ETH. 15m is excluded: it failed the cost check in #161. Neither may be
substituted after the fact.

### Signal
| Item | Value |
|---|---|
| State detector | `q3 == q4` within 1e-9 — the exact Möbius fixed-point test for "EOT2 is railed" |
| Upper rail | state where `q3 > 50` |
| Lower rail | state where `q3 <= 50` |
| Events | rail **entry and exit**, pooled per side (as `ALL_upper` / `ALL_lower` in #162) |
| Long side | upper-rail events |
| Short side | lower-rail events |
| Entry | **next bar's open** after the event bar |

### Regime
| Item | Value |
|---|---|
| Definition | close vs **SMA(200)** on the 4h rung |
| Bull | `close >= sma200` |
| Bear | `close < sma200` |
| Aligned cells | long/BULL and short/BEAR |
| Counter cells | long/BEAR and short/BULL |

One definition. No alternative filters, no length sweep, no calendar cut.

### Trade construction — #143's frozen configuration, verbatim
| Item | Value |
|---|---|
| Stop | 2.0 × ATR(14) |
| Target | 2R |
| Hold limit | 200 bars, mark-to-market on unresolved |
| Ambiguous bars | stop-first |
| Slippage | 0.05 ATR entry, 0.15 ATR stop, 0 target (resting limit) |
| Costs | `bitunix_futures_vip1` taker, both sides, plus representative funding |

### Statistics
| Item | Value |
|---|---|
| Null | random entry of the **same side within the same regime**, matched count |
| Iterations | 20,000 |
| Seed | 42 |

The null is the load-bearing choice. Comparing against the unconditional mean would re-answer a
settled question; the drift hypothesis says the edge is "being long in a rising market", so the
baseline must be random same-side entry inside the same regime.

---

## 3. Pass / fail criteria — declared before any SOL result exists

The run **PASSES** only if all four hold:

1. **Both aligned cells profitable after costs.** `long/BULL` net > 0 **and** `short/BEAR` net > 0.
2. **Both aligned cells beat their same-regime baseline at p < 0.05.**
3. **Population floor:** n ≥ 60 in each aligned cell. Below this the run is **INCONCLUSIVE**, not a
   pass and not a fail.
4. **Neither counter-regime cell is significantly positive** (p < 0.05 with positive excess). The
   mechanism predicts these are dead; a live counter-regime cell would mean the regime story is
   wrong even if the aligned cells look good.

Anything short of all four is a **FAIL** and will be recorded as one. A partial result — one side
working, or the aligned cells passing while a counter cell also fires — is a fail, not a
"qualified pass".

### What a pass does and does not authorise

A pass authorises **the next stage of the #33 promotion ladder — paper / live shadow — and nothing
further.** It does not authorise wiring into `portfolio-backtest.js`, and it does not reorder the
build plan: constraints C-2 (allocation dominates selection) and C-3 (the pool is budget-bound at
99.7% of signals discarded) apply to a second edge exactly as they apply to the first.

### Limitations that a pass will NOT remove

- **SOL is materially correlated with BTC and ETH.** A confirming result on a correlated asset is
  weaker evidence than the same result on an uncorrelated one. This must never be described as
  independent replication.
- SOL contributes ~6 years from 2020-08-11 against BTC/ETH's ~9.
- Target-as-resting-limit ignores queue position and partial fills.
- No L2 depth exists, so true market impact remains unmodelled.
- **No forward evidence exists for this construction or any other in this project.**

---

## 4. Procedure

1. Commit this document. `boom-hunter-sol.db` must not exist at that commit.
2. Build the SOL Boom Hunter corpus (`build-historical.js --instrument=SOL`).
3. Run `eot2-preregistered-sol.js` **once**.
4. Record the verdict against §3 in the significance register, pass or fail, without amendment.

**Sequence-structure questions raised at the same time as this document are explicitly OUT OF
SCOPE and must not be added to it.** Any exploration of event ordering is exploratory work on
BTC/ETH only and may not inform this specification or its runner.
