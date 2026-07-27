# Architecture — path to a cognitive adaptive trading intelligence

Living document. This is not a spec — it's where the big-picture sketching gets tracked so it
doesn't evaporate between sessions, updated incrementally as pieces firm up. See
`README.md`/`SETUP_GUIDE.md` for MCP tool mechanics; this doc is about the signal/strategy
architecture built on top of them.

**Vision (long-term, deferred):** many independent indicators/strategies acting as agents that
each produce signals, feeding a self-improving meta-agent that synthesizes them, with a companion
IDE surfacing their stats, learning data, and backtest results. **Current phase:** single
strategy, validated advisory pipeline, one symbol. Everything below tracks the gap between those
two.

---

## 1. Current system (what actually exists today)

```
rules.json (bias criteria, risk rules, watchlist, symbol->proxy map)
        |
        +-- morning_brief (src/core/morning.js) -- TV-native indicator scan, one symbol/TF
        |
        +-- scripts/signal-grid.js -- TV-native scan across 15m/1H/4H/1D/1W
        |
        +-- scripts/supertrend-monitor.js -- independent JS calc, Task Scheduler, every 5 min
```

Two distinct signal sources, deliberately not unified:

- **TV-native** (read via CDP, `src/core/data.js`): whatever's actually on the TradingView
  Desktop chart. Five indicators currently loaded — see §2.
- **Independently computed** (`scripts/lib/adaptive-supertrend.js`): reimplemented in JS from
  Pine source, runs against public Bitstamp candle data, no dependency on TV Desktop being open.
  Currently just the Adaptive SuperTrend.

Watchlist symbol: `COINBASE:BIPZ2030` (nano BTC Perp Style Futures). Bitstamp has no derivatives
listings, so the independent calc proxies through `BTCUSD` spot (`rules.json`'s
`supertrend_proxy` map) — documented, labeled `[via BTCUSD proxy]` in all output, not silently
assumed equivalent.

## 2. Signal inventory per indicator

| Indicator | Source | Signal Data | Notes |
|---|---|---|---|
| **VuManChu Cipher A** (ribbon) | TV-native, source obtained: `pine/vmc-cipher-a-ribbon.pine` | 8-EMA ribbon (periods 5,11,15,18,21,24,28,34), plus Long/Short EMA Signal, Red cross, Blue Triangle, Red Diamond, Bull candle, Blood Diamond, Yellow Cross | Ribbon direction is the indicator's own `ema8 < ema2` formula (corrected from a guessed monotonic-8-EMA-stack heuristic, see §3/§8 2026-07-25). Exact formulas now known for every signal. Its Data Window row has silently gone hidden 3x — now self-healing, see §4. |
| **VuManChu B Divergences** (Cipher B) | TV-native, source obtained: `pine/vmc-cipher-b-divergences.pine` | WaveTrend (WT1/WT2/VWAP spread), MFI, RSI(14), Stoch K/D, Schaff Trend Cycle, 4 divergence families (WT regular + WT 2nd-range, RSI, Stoch), buy/sell circles, "gold" warning circle, Sommi higher-TF flags/diamonds | Fully mapped — `extractCipherB` in signal-grid.js pulls the whole battery, not just RSI/WT. |
| **Smart Money Concepts [LuxAlgo]** | TV-native, source obtained: `pine/smart-money-concepts-luxalgo.pine` | BOS/CHoCH structure, Order Blocks (internal+swing, drawn as boxes), EQH/EQL liquidity pools, FVG, Premium/Discount/Equilibrium zones | Order block color decoded and confirmed (§3/§8 2026-07-25) — was "unverified," now resolved. **Important:** BOS/CHoCH tag text alone does NOT encode bullish/bearish — direction comes from which pivot (high vs. low) was crossed, not the tag. Our label reads so far have been direction-blind; see §3. |
| **Boom Hunter Pro 1.022** | TV-native, source obtained: `pine/boom-hunter-pro.pine` | 3 independent Ehlers-style oscillator systems (EOT 1/2/3: highpass -> SuperSmoother -> Fast-Attack-Slow-Decay peak norm -> quotient warp), q1/trigger crossover drives all entries. Long gray/yellow/blue/Lime (4 distinct, unique-title long setups, tiered by strictness), Exit Warning, Break | Source reuses the plot titles "Quotient 1"/"Quotient 2" **six times** across the 3 oscillator systems, and "Exit Warning"/"Break" twice each for *opposite-direction* signals — the Data Window collapses same-titled plots to one key. Resolved via "last plot() call wins" (see `extractBoomHunter` comment in signal-grid.js, 2026-07-25): Quotient 2 = q1 (main EOT-1 oscillator), Quotient 1 = its 2-bar-SMA trigger; Exit Warning = the Q3/Q4-based "Overbought" condition, not the Q5/Q6 one; **Break = the bullish continuation breakout, not the short setup** (`senter3`) — counterintuitive given the Long-signal naming pattern, worth double-checking against a live UI capture before trusting it. The 4 Long signals are safe as-is (unique titles). |
| **Divergence for Many Indicators v4** | TV-native, source obtained: `pine/divergence-for-many-relevance-gated.pine` | MACD/MACD Hist/RSI/Stoch divergence badges, relevance-gated "promoted" support/resistance glow levels | Fully mapped, settings match "Commander default profile." |
| **Adaptive SuperTrend [AlgoAlpha]** | Independently computed, source obtained: `pine/ml-adaptive-supertrend-algoalpha.pine` | K-means volatility-regime clustering (High/Med/Low) -> ATR-adaptive SuperTrend line + direction | Not on the visible chart by design — runs headless. Cross-validated once against the on-chart Pine instance (matched within ~$1). |

**Milestone, 2026-07-25:** all 5 TV-native indicators now have source in hand (Cipher A, Cipher B,
SMC, Divergence-for-Many, and now Boom Hunter Pro), plus SuperTrend already independently
computed — full source coverage of the stack for the first time. All 5 TV-native indicators are
now candidates for independent JS reimplementation for true retroactive backtesting, the way
SuperTrend already was. Deliberately not started yet — batching was intentional, this was the
trigger condition ("proceed once the set is complete"). Next architectural conversation: which
indicator(s) to reimplement first, and whether the MTF signal bus / persistent memory matrix
design (raised earlier, deferred pending this exact milestone) should be revisited now.

## 3. Known limitations

- **Data Window hidden-toggle bug** — a study's visibility flag has silently flipped off 3x
  (cause unconfirmed). Self-healing as of `getStudyValuesEnsured()` (`src/core/data.js`) — auto
  re-enables and retries, reported via `auto_fixed`/`was_missing`.
- **Bitstamp proxy mismatch** — the independent SuperTrend calc can't reach Coinbase Derivatives
  data; proxies through spot BTCUSD. Fine for a nano perp-style contract (tight basis by design)
  but not exact.
- **Sequential timeframe switching** — `signal-grid.js` sweeps 15m/1H/4H/1D/1W one at a time on a
  single chart (each switch has real settle-time). SuperTrend calcs across timeframes are already
  parallelized (independent of the chart); the TV-native reads are not. See §5.
- ~~Order block bullish/bearish classification unverified~~ — **RESOLVED 2026-07-25.** SMC's box
  color is packed **ABGR**, not the more common ARGB (confirmed programmatically, not by hand):
  decoding the two 4H order-block colors captured earlier gives exact matches to source --
  `#3179f5` (`internalBullishOrderBlockColor`) for the box containing current price, `#f77c80`
  (`internalBearishOrderBlockColor`) for the box above it. Not yet wired into `signal-grid.js`'s
  extraction (still just reports raw box zones, no bias field) — straightforward now that the
  byte order is known, just not built.
- **BOS/CHoCH tag text doesn't encode direction** (found reading `pine/smart-money-concepts-luxalgo.pine`,
  2026-07-25) — `displayStructure()` sets the tag to `CHOCH` when the trend bias reverses and
  `BOS` otherwise, but bullish/bearish is a *separate* fact: whether price crossed *above* a high
  pivot (bullish) or *below* a low pivot (bearish). Every "most recent BOS/CHoCH" read this
  session inferred direction from price context, not from the label text -- which was actually
  the only thing that could be done with label text alone, but it means our structure reads
  have never had guaranteed direction. `data_get_pine_labels` has a `verbose` option (unused so
  far) that may expose label color, which would fix this properly -- untested.

## 4. Self-healing / reliability work done

- `ensureDataWindowVisible()` + `getStudyValuesEnsured()` (§3, first bullet).
- SuperTrend background monitor moved from a session-tied loop process to a Windows Task
  Scheduler job (`scripts/run-supertrend-once-hidden.vbs`, silent) — survives session/reboot.
- `scripts/signal-grid-server.js` — local live dashboard (localhost only; no capability exists
  for a hosted Artifact to reach local data, so this stays local).

## 5. Open architecture questions (sketching, not decided)

1. **True multi-timeframe parallelism via multi-pane — TESTED, answer is no.** Hands-on test
   2026-07-24: switched to a 2-pane layout and inspected both `chart.getState()` and
   `data.getStudyValues()` while pane 0 was active. Findings:
   - **Plan-capped at 2 panes.** TradingView's own upgrade modal fired requesting a plan upgrade
     for >2 charts/tab (Essential=2, Plus=4, up to 16 on higher tiers). Not "many timeframes at
     once" without a paid upgrade regardless of anything else.
   - **The read APIs are scoped to the single active pane, not all panes at once.**
     `getStudyValues()` reads via `window.TradingViewApi._activeChartWidgetWV` — confirmed
     empirically: with pane 0 focused, `values` returned exactly our 5 indicators, nothing from
     pane 1. So even with N panes visually rendering concurrently, reading them programmatically
     is still one-at-a-time: focus pane -> read -> focus next pane -> read. No free parallelism.
   - **Each pane needs its own full indicator setup.** Pane 1 (a stale pane from earlier
     experimentation, symbol `MEXC:BTCUSDT.P`) had a completely different, unrelated indicator
     set on it ("Step Channel Momentum Trend", "Neural Network Buy/Sell Signals" — duplicated
     twice each). Nothing shares across panes automatically; every pane used for real work would
     need all 5 indicators added and Data Window visibility managed independently.
   - **One real upside found: focus-switching is fast.** `pane focus` took ~200ms vs. the
     ~1.8s+ settle time `signal-grid.js` currently pays per symbol+timeframe switch. Not a
     parallelism win, but could speed up a 2-wide sweep if ever worth the setup cost above.
   - **Conclusion:** not worth pursuing further. Plan cap + per-pane setup cost + no actual
     concurrent reads means this doesn't solve the multi-timeframe problem. The existing approach
     (sequential TV-native sweep, with the independent SuperTrend calc already running truly
     parallel across timeframes since it doesn't touch the chart at all) is the right shape —
     if more speed is needed later, look at trimming settle-time / narrowing what's queried per
     timeframe rather than multi-pane.
2. **Exchange-direct vs. TV-native, per signal type.** Current lean: keep the four sophisticated
   community indicators (Cipher A/B, SMC, Boom Hunter) TV-native — reimplementing them is
   high-effort, high-risk (SuperTrend alone took real work and is still an approximation).
   Reserve direct exchange/bulk data for (a) backtesting at scale and (b) signals we've already
   proven we can reimplement faithfully.
3. **Backtesting path.** Full design in §6 — this is no longer "open," it's the current focus.
4. **Performance baselines.** Not established for any indicator individually or in combination.
   This is what §6 exists to produce.

## 6. Backtesting lab design

"Enterprise grade" here means something specific: not "runs a backtest and shows an equity
curve," but statistically rigorous, reproducible, and hardened against the exact failure modes
§7 documents (parameter-optimization overfit, unfalsifiable-by-design methodologies,
survivorship bias in reported results). A lab that can't catch those isn't the lab we need.

### Pillars

1. **Historical data layer.** Years of OHLCV stored locally and versioned — not re-fetched live
   each run — so tests are reproducible and bulk/parameter-sweep runs don't hammer an API. See
   "Data source found" below — this pillar just got a running start.
2. **Two backtest engines, matching §5.2's TV-native/independent split:**
   - **TV Pine `strategy()` + Strategy Tester** for anything depending on the four TV-native
     black-box indicators (Cipher A/B, SMC, Boom Hunter) — we deliberately chose not to
     reimplement their logic, so testing them means testing them inside TV, via the MCP tools
     that already exist (`data_get_strategy_results`/`trades`/`equity`).
   - **Our own JS engine** for anything independently reimplemented (SuperTrend) or pure
     price-action rules — full control, fast parameter sweeps, no UI dependency.
3. **Every risk rule is an executable constraint, not a note.** R:R >= 1:2, max 2 open
   positions, no trading in the first 15 min of NY open, stop for the day after 2 losses — these
   have to be real logic in whichever engine runs the test, or the backtest isn't testing our
   actual rules.
4. **Anti-overfitting safeguards — the part that actually earns "enterprise grade":**
   - In-sample/out-of-sample split, walk-forward re-optimization (not one static fit)
   - Test across multiple regimes (trending/chop, high/low vol), not one lucky window
   - Parameter sensitivity checks — if a 1-tick nudge craters performance, that's a fragile
     overfit, not an edge
   - **A random-entry Monte Carlo baseline, run every time** — the same method §7's SMC/ICT
     skeptic used. If we can't beat random entries at the same R:R and trade count by a
     statistically meaningful margin, there's no edge, regardless of how good the curve looks.
5. **Baselines and decomposition.** Compare against buy-and-hold, and test each indicator alone
   vs. the combined stack — need to know combining signals adds value before the meta-agent
   vision gets built on that assumption.
6. **Experiment tracking.** Every result tagged with the exact `rules.json`/code commit that
   produced it, so results are comparable across iterations.

### Phasing (staying honest about "start slow")

1. Historical data layer
2. Own JS backtest engine, proved end-to-end on SuperTrend alone first (simplest case: already
   reimplemented, no Pine dependency)
3. Anti-overfitting harness, built once and generically, reusable for every future strategy
4. Pine `strategy()` translation for the TV-native-dependent signals
5. Unify reporting across both engines

### Phase 2 — own JS backtest engine, proved on SuperTrend — done 2026-07-24

`scripts/backtest/lib/` (load-candles, simulate-trades, metrics) + `run-supertrend-backtest.js`.
Reuses `scripts/lib/adaptive-supertrend.js`'s actual calculation (now exports
`calcATRSeries`/`computeAdaptiveSuperTrend`/`ATR_LEN` for this) — same code path as the live
monitor, run over full historical series instead of the last bar. Fill discipline: next-bar
open after signal confirmation, not same-bar close, to avoid look-ahead bias. No position
sizing/commission/slippage modeled yet (full-equity compounding, zero costs) — that's a real
simplification, not hidden.

**First real results (BTC, 2017-08-17 to 2024-12-31, in-sample, no anti-overfitting harness
yet — see caveats below):**

| Run | Trades | Win rate | Profit factor | Net return | Max DD | vs. buy-and-hold (21.5x) |
|---|---|---|---|---|---|---|
| 4H, long-short | 356 | 37.4% | 1.39 | 8.6x | 58.9% | **Loses** (8.6x vs 21.5x) |
| 4H, long-only | 178 | 39.3% | 2.00 | **27.8x** | **39.6%** | **Beats it** — more return, less drawdown |
| 1D, long-short | 64 | 31.3% | 1.49 | **0.94x** | 78.0% | **Loses money outright** |

Two things worth flagging, not burying:

1. **The 1D result is a genuine catch, not a bug worry.** Profit factor 1.49 (>1, "profitable"
   per trade) but net return is *negative* (0.94x = a 6% loss) once compounded. That's sequence
   risk — a few large losses landing at costly points in the equity curve — and it's exactly why
   compounded equity curves matter more than average-trade stats. Good sign the engine's math is
   doing something real, not just naive averaging.
2. **Shorting is actively hurting the 4H strategy.** Long-only (27.8x, beats buy-and-hold with
   *less* drawdown than raw BTC ever had) dramatically outperforms long-short (8.6x) on the same
   data. Consistent with BTC's strong secular uptrend over this specific window — shorting into
   that bias gave back most of what the long side made.

**Caveats — these are Phase 2 proof-of-mechanics results, not evidence of edge:**
- In-sample only. No train/test split, no walk-forward, no out-of-sample check.
- No random-entry Monte Carlo baseline run yet (§7's own method against SMC/ICT) — until that
  comparison exists, "beats buy-and-hold" isn't the same as "has statistically real edge."
- One instrument (BTC), one indicator, one simple flip rule. Phase 3 exists to stress-test all
  of this properly before anyone treats these numbers as decision-grade.

Results saved to `scripts/backtest/results/` (committed, not gitignored — small JSON files,
meant to accumulate as the experiment log per pillar 6).

### Phase 3 — anti-overfitting harness, run on Phase 2's results — done 2026-07-24, and it changed the conclusion

`scripts/backtest/lib/segment.js` (in-sample/out-of-sample split, year grouping) +
`monte-carlo.js` (random-entry baseline, seeded/reproducible) + `run-harness.js` orchestrator.
Three checks per run: IS/OOS consistency, year-by-year regime breakdown, and a random-entry
Monte Carlo baseline matching the real strategy's exact trade count/sides/holding-period shape —
the same method §7 documents being used against SMC/ICT's own claimed edge, turned on our own
result first.

**This flips Phase 2's headline finding.** 4H long-only looked like the clear winner (27.8x,
beat buy-and-hold, lower drawdown). Under the harness:

| | 4H long-only | 4H long-short |
|---|---|---|
| Full-period return | 27.8x | 8.6x (loses to buy-and-hold) |
| In-sample (70%) -> out-of-sample (30%) | 8.44x -> 1.94x | 5.05x -> 0.43x |
| Random-entry baseline mean / median (same shape) | 13.62x / 4.87x | 1.01x / 0.13x |
| Real result's percentile vs. random | 89.6th | 97.8th |
| p-value (random beats real) | **0.104 — NOT significant** | **0.022 — significant at 5%** |

**Long-only's big number is statistically indistinguishable from luck.** 10.4% of purely
random-entry sequences with the identical trade count/holding-period shape did as well or
better. The random baseline's own mean (13.6x) is high because being long *anything* for
random ~46-bar windows tends to work when the underlying asset went up ~20x over the test
window — the strategy wasn't shown to be doing something a coin flip couldn't.

**Long-short, despite the worse raw return, has real signal (p=0.022).** Why: the random
baseline for long-short is a much weaker opponent — half of random entries are shorts, and
random shorts lose money in a secular bull market. So a strategy that correctly *times* both
sides stands out clearly against that baseline, even though shorting into the overall uptrend
costs it raw return. The year-by-year breakdown supports this directly: long-short was
profitable in 2018 (+193%) and roughly flat in 2022 (+12%) — the two clearest bear-market
years — while long-only was flat in 2018 (+7%) and lost money in 2022 (−26%), having nothing
to offset the downside. The short side appears to be adding real, complementary value in down
years specifically, not just dead weight.

**Practical takeaway:** the naive Phase 2 read ("drop shorts, long-only is clearly better") was
wrong, or at least unproven. Long-short is the one with statistical backing; long-only's
outperformance is plausibly just riding BTC's trend. This is exactly the failure mode the
harness exists to catch, and it caught it on our own first real result — not hypothetically.

**Still not decision-grade** — one instrument (Binance BTC spot proxy), one indicator, one
timeframe with real signal so far, IS/OOS split uses a single K-means fit over the whole
history rather than true walk-forward re-optimization, and the Monte Carlo baseline doesn't
model real market regime correlation. Directionally trustworthy, not yet a green light.

Results saved to `scripts/backtest/results/harness_*.json`.

### Tested: SuperTrend + Bollinger Bands combination — 2026-07-24

Question asked directly, answered by building it rather than theorizing. Added
`scripts/backtest/lib/bollinger.js` (standard 20-period SMA, 2 std-dev, untuned) and a filtered
strategy variant (`runSuperTrendBBStrategy` in `lib/run-strategy.js`, `--strategy=supertrend-bb`
on both orchestrators): the standard "double confirmation" combination — only take a SuperTrend
flip if price also agrees with the Bollinger Band basis direction (close above basis for longs,
below for shorts). Ran both modes through the full harness (baseline + IS/OOS + year breakdown +
Monte Carlo).

**Result: the filter does effectively nothing on this instrument/timeframe, and what little it
does do is slightly negative.**

| | Long-short | Long-short + BB | Long-only | Long-only + BB |
|---|---|---|---|---|
| Trades | 356 | 353 | 178 | **178 (identical)** |
| Net return | 7.63x | 7.30x | 26.78x | **26.78x (identical)** |
| p-value | 0.022 | 0.027 | 0.104 | **0.104 (identical)** |

**Long-only: the filter changed literally nothing** — zero of the 178 SuperTrend bullish flips
were ever rejected by the BB-basis condition. Makes sense once you see it: SuperTrend's own
volatility-adaptive bands are already trend-following in the same spirit as a 20-SMA basis, so
requiring agreement with a second, cruder trend proxy doesn't screen out anything SuperTrend
wasn't already screening on its own.

**Long-short: only 3 of 356 trades were filtered out (0.8%)**, and every metric got very
slightly worse — lower net return, lower out-of-sample return, and a *higher* (worse) p-value.
Not a meaningful difference either way, but if anything this specific combination is a mild net
negative, not an improvement.

**Bottom line:** Bollinger Bands as a same-direction trend filter is redundant with SuperTrend
here — they're both approximating the same medium-term trend, so requiring both to agree barely
changes the trade set. This doesn't rule out BB adding value in a *different* role (e.g.
mean-reversion entries filtered by SuperTrend as the trend gate, rather than the other way
around, or using band width for a volatility-squeeze breakout signal instead of the basis for
direction) — just that the most obvious combination doesn't help. Worth trying a genuinely
different combination role if this is revisited, not just re-running this one on other timeframes.

Results saved to `scripts/backtest/results/harness_supertrend-bb_*.json`.

### Tested: mean-reversion entries at the bands, gated by SuperTrend — 2026-07-24

The other combination role flagged above: reversed from the trend-filter test, here Bollinger
Bands drive entry *timing* and SuperTrend only gates *direction* + provides the exit stop.
New strategy shape, not a filter on the flip strategy — added `simulate-mean-reversion.js` +
`runMeanReversionStrategy` (`--strategy=mean-reversion`).

**Rules:** SuperTrend bullish + this bar's low touches/crosses the lower band -> long (mirror
for short). Exit on whichever comes first: price reverts to the BB basis (take profit) or
SuperTrend flips against the position (stop). "Buy the dip in an uptrend, sell the rally in a
downtrend" — a standard, sensible-sounding combination.

**Result: loses money outright, and is worse than random.**

| | Long-short | Long-only |
|---|---|---|
| Trades | 432 | 221 |
| Win rate | 53.7% | 55.7% |
| Avg win / avg loss | 1.49% / **2.05%** | 1.46% / **2.11%** |
| Net return | **0.46x** (lost 54%) | **0.72x** (lost 28%) |
| vs. buy-and-hold (21.5x) | Loses badly | Loses badly |
| vs. random-entry baseline | **14.1th percentile** | not run |
| p-value | **0.859 — real is worse than 86% of random runs** | not run |

The win rate looks fine in isolation (>50%, the mean-reversion signature) but average losses are
meaningfully bigger than average wins, and that asymmetry is enough to make the whole thing
net-negative. The Monte Carlo result is the sharper finding: this isn't "no edge," it's *negative*
edge — random entries with the identical trade count/sides/holding-period shape did better 86%
of the time. The entry timing itself (band touch, trend-agreeing) is actively counterproductive
here, not neutral.

**Plausible reason, not yet tested:** avg ~3.5 bars held (14 hours on 4H) is short — reversion
targets get hit quickly when the thesis works, but the trend-flip stop may not be cutting losers
fast enough when it doesn't, letting losses run longer than wins on average. A tighter/faster
stop, or requiring a deeper band penetration before entry (less noise-sensitive), are the more
promising next tweaks — not abandoning mean-reversion-on-BB entirely from one untuned attempt.

**Bottom line so far, across both combination roles tried:** BB-as-trend-filter was redundant
(§ above); BB-as-mean-reversion-trigger is actively harmful as implemented. Neither result
should be read as "Bollinger Bands don't work with SuperTrend" in general — both were one
specific, untuned rule set each. What they do establish: don't assume a plausible-sounding
combination helps without running it through the harness. Two for two, intuition was wrong.

Results saved to `scripts/backtest/results/*mean-reversion*.json`.

### Mitigating critique issue #1: cost sensitivity sweep — 2026-07-25

An institutional-quant-lens critique of everything in this section (run 2026-07-25) flagged zero
cost modeling as the single fatal issue: every result above is gross, and gross "beats
buy-and-hold" claims are not net-edge claims. Built `scripts/backtest/lib/costs.js`
(`applyCosts`/`costSensitivitySweep`) and wired it into `run-harness.js` as a new reporting block,
rather than hand-picking one fee number to bake in — Coinbase's own fee-schedule and funding-rate
pages both returned HTTP 403 to automated fetch (scraping blocked), so the exact account-tier fee
and real historical funding-rate series are **not confirmed**, only a third-party-aggregator
figure (0.60%/0.40% taker/maker, explicitly Coinbase's lowest-volume <$10k/mo tier) and a
cross-exchange representative funding magnitude (~0.00125%/hr). Structural fact that *is*
reasonably confirmed: Coinbase perpetual-style futures settle funding **hourly**, not the more
common 8-hour cadence. Given the uncertainty, costs are swept as a band (gross / retail-worst-case
/ 3x-funding-stress / mid-tier-illustrative / high-volume-illustrative), not asserted as one number.

**Result: the one statistically-significant finding (4H long-short, p=0.023 vs. random) does not
survive realistic retail costs.**

| Scenario | Taker fee | Funding/hr | 4H long-short net return | 4H long-only net return |
|---|---|---|---|---|
| Gross (zero cost) | 0% | 0% | 7.63x | 26.78x |
| Retail worst-case | 0.60% | 0.00125% | **-0.95x (95% loss)** | 1.26x |
| Retail worst-case, 3x funding stress | 0.60% | 0.00375% | -0.99x (near-total loss) | 0.03x (breakeven) |
| Mid-tier (illustrative) | 0.15% | 0.00125% | 0.38x (62% loss) | 10.14x |
| High-volume (illustrative) | 0.02% | 0.00125% | 2.50x | 16.62x |

Long-short has 356 trades (178 round trips each side) against long-only's 178 — roughly double
the fee drag for a strategy whose gross edge (7.63x) was already thinner than long-only's. At the
retail tier, that's enough to erase the entire statistically-significant result and then some. It
only turns net-positive again at a high-volume/near-institutional fee tier neither confirmed nor
likely to reflect the account this will actually trade from. Long-only is more cost-resilient
(half the round trips, bigger gross edge) but recall it was already shown statistically
indistinguishable from random entries (p=0.109) — so its cost-resilience doesn't rescue a result
that was never established as real to begin with.

**Bottom line: nothing in this backtest program currently clears the bar of "real, costed edge" at
a plausible retail cost level.** The long-short result that looked like the program's best finding
(real signal, not just a trending-market artifact) is the one costs hit hardest.

**Mitigation follow-up, same day: costed Monte Carlo re-test.** The gross Monte Carlo above
compares a GROSS real result against an un-costed random baseline — apples to oranges once costs
matter this much. Added `costParams` support to `randomEntryBaseline()` (`lib/monte-carlo.js`) so
every random draw pays the identical round-trip fee + hours-held funding drag as the real trades,
then re-ran significance at the retail-worst-case tier for both variants:

| | Real (costed) | Random mean (costed) | Percentile rank | p-value (costed) |
|---|---|---|---|---|
| 4H long-short | 0.05x (95% loss) | 0.01x | 97.8th | **0.022 — still significant** |
| 4H long-only | 2.26x | 1.08x | 89.5th | 0.105 — still not significant |

**Important, easy-to-misread result: long-short's edge is still statistically real even after
matched costs — but "statistically real" and "profitable" are separate questions, and this
answers only the first one.** Both the real strategy and the random baseline lose money outright
at this cost tier (real ends down 95%; random's median is a near-total wipeout too) — the
strategy loses *less catastrophically* than random, which is enough to stay significant, but
losing less badly than random is not the same as making money. At the retail-worst-case tier, this
strategy is not tradeable regardless of its statistical validity.

**New suspicion raised by running the numbers, not just citing them:** 356 round trips (long-short)
against a 0.60% taker fee implies over 400% of cumulative fee drag before compounding — punishing
enough to suspect **`retail_worst_case` may be the wrong product's fee schedule entirely.** The
0.60%/0.40% figure is plausibly Coinbase Advanced Trade's *spot* tier, not a derivatives-specific
one — and Coinbase futures fees are typically quoted as a **flat $ amount per contract** (a nano
contract = 1/100 BTC), not a % of notional. If so, the cost model itself needs a structural change
(flat-per-contract fee, not %-of-notional) once the real derivatives fee schedule is confirmed —
this is a modeling gap, not just an unconfirmed number.

**Confirmed same day: real fee tier obtained, and the picture changes materially for the
better.** iapaulo supplied the actual Coinbase Advanced dashboard screenshot: Advanced 1 tier,
$73,923.25 trailing-30-day *derivatives* volume, fees **0.070% taker / 0.065% maker** — a real,
percentage-based fee (no flat-per-contract restructuring needed after all). This confirmed the
suspicion directly: the earlier "retail_worst_case" (0.60%/0.40%) was Coinbase's *spot* tier,
never actually paid on derivatives trades, and overstated real costs by roughly 8x.
`lib/costs.js` updated (`confirmed_derivatives`, `confirmed_derivatives_with_one_rebate`,
`confirmed_derivatives_3x_funding_stress`; the wrong spot figure kept only as a labeled contrast).

| | 4H long-short | 4H long-only |
|---|---|---|
| Gross | 7.63x | 26.78x |
| **Confirmed real fee tier** | **1.45x (+145%)** | 13.77x |
| Confirmed tier, 3x funding stress | **-0.47x (loses)** | 5.81x |
| With Coinbase One rebate (unconfirmed enrollment) | 1.77x | 14.71x |
| Costed Monte Carlo p-value (confirmed tier) | **0.022 — significant** | 0.105 — not significant |

**Long-short is now both statistically significant (in isolation) AND net-profitable at the real
fee tier** — the earlier "wiped out" finding was an artifact of testing against the wrong
product's fee schedule, not a property of the strategy. **Update, same day:** "significant in
isolation" turns out to matter — see the multiple-testing correction subsection below, which
shows this p-value does not survive correction for the 5 variants tried this session. Net-
profitability at real costs still stands; the significance claim needed downgrading. This is a materially better result than either the
gross number (looked great, wasn't real) or the spot-tier number (looked dead, wasn't real cost)
suggested on their own — the correct answer needed the correct input, which is exactly why this
was worth confirming rather than assuming.

**Still fragile, not yet decision-grade:** the 3x-funding-stress column flips long-short back to
a loss (-0.47x) — funding rate magnitude is still an unconfirmed cross-exchange placeholder
(~0.00125%/hr), not Coinbase's own historical funding series, and it's now the single largest
remaining source of uncertainty in the cost model (the fee side is confirmed; the funding side
isn't). Long-only remains statistically indistinguishable from random regardless of fee tier —
its absolute profit is still attributable to riding BTC's trend, not to real signal.

**Same day, funding mechanism confirmed (magnitude still not):** iapaulo confirmed Coinbase's own
description of how funding actually works — calculated hourly from the futures-vs-spot basis over
the prior hour; contract above spot means longs pay shorts, contract below spot means shorts pay
longs. This matters structurally: funding is a **peer-to-peer transfer**, not an exchange fee, so
it cannot be a net cost to both sides of the same position simultaneously — the original
"subtract funding regardless of side" model was mechanistically wrong, not just conservative.
`applyCosts()` now supports two modes: `pessimistic_both_sides` (legacy, kept as an explicit
worst-case stress bound) and `signed_contango_bias` (cost to longs, credit to shorts — modeling
the commonly-cited tendency for crypto perp funding to skew positive across full cycles;
**Hypothesized / recollection-based, not verified against Coinbase's own historical series**).

| | Pessimistic (both sides pay) | Signed (contango-bias: longs pay, shorts receive) |
|---|---|---|
| 4H long-short | 1.45x | **4.19x** |
| 4H long-only (no shorts, converges exactly — consistency check passed) | 13.77x | 13.77x |

Long-short's real net return spans **1.45x–4.19x depending on funding sign assumption alone** —
both scenarios remain profitable and (per the pessimistic scenario's already-run costed Monte
Carlo, §above) statistically significant; the signed scenario is strictly more favorable to this
specific strategy (its shorts cluster in down-trending stretches, plausibly correlated with
periods contango-bias would model as funding-receiving for shorts) so significance is expected to
hold at least as strongly there too, not yet re-run. The true number depends on Coinbase's actual
historical funding sign/magnitude series, still not sourced — that remains the single highest-value
open item in the cost model, now doubly so (both scenarios are directionally reasonable, and only
real data resolves which is closer to true).

Still outstanding from the same critique: Coinbase's own historical funding-rate data (magnitude
*and* sign — the highest-value remaining unknown now that fees are confirmed and the mechanism is
understood), multiple-testing correction across the 6 strategy variants tested, parameter-
sensitivity sweep on the inherited K-means constants, a second asset, and a true walk-forward split.

Results saved to `scripts/backtest/results/harness_supertrend_4h_*_2026-07-25*.json`.

### Mitigating critique issue #6: multiple-testing correction — 2026-07-25

The institutional-quant-lens critique's remaining statistical issue: one p<0.05 result found
after trying 5 distinct strategy variants in the same session is weaker evidence than a single
pre-registered p<0.05 test. Built `scripts/backtest/lib/multiple-testing.js`
(Bonferroni / Holm-Bonferroni / Benjamini-Hochberg, most to least conservative) and
`run-multiple-testing-correction.js`, applied to the 5 variants that actually got a Monte Carlo
significance test this session (GROSS p-values, for apples-to-apples comparison — only
supertrend-flip has costed re-tests so far):

| Variant | Raw p | Bonferroni | Holm | Benjamini-Hochberg |
|---|---|---|---|---|
| supertrend-flip long-short | 0.022 | not sig | not sig | not sig |
| supertrend-flip long-only | 0.104 | not sig | not sig | not sig |
| supertrend-bb long-short | 0.027 | not sig | not sig | not sig |
| supertrend-bb long-only | 0.104 | not sig | not sig | not sig |
| mean-reversion long-short | 0.859 | not sig | not sig | not sig |

**None of the 5 variants survive any correction — including supertrend-flip long-short, the
program's one headline finding.** Two raw p-values (0.022, 0.027) clear the uncorrected 5%
bar, but Bonferroni's per-test threshold at n=5 is 0.01 — neither clears it, and Holm/BH (less
conservative than Bonferroni) don't rescue it either, since the two smallest p-values are close
to each other and both still exceed even the least strict correction's threshold at their rank.

**Claim label downgrade, per epistemology.md:** supertrend-flip long-short's edge moves from
*Supported* back to **Hypothesized**. This doesn't mean the effect isn't real — it means the
evidence gathered so far can't distinguish "real edge" from "the best-looking result out of 5
searched variants," which is exactly the failure mode multiple-testing correction exists to
catch. The costed-Monte-Carlo and confirmed-fee-tier work earlier in §6 answered "does this
survive realistic costs" (yes, at the real fee tier) — this answers a *different*, harder
question ("was finding it in the first place already priced by how many things were tried"),
and the honest answer here is no, not yet.

**What would fix this properly, not just re-run the same test:** a single new, pre-registered
test that isn't part of this searched family — e.g. the same supertrend-flip long-short
rule set on a second asset (ETH) or timeframe, decided *before* looking at the result. That
result wouldn't need correcting against these 5, because it wasn't chosen from among them.
Re-running variants already in this family, no matter how many times, doesn't fix this — it can
only make the correction stricter (more tests = smaller per-test threshold).

Results saved to `scripts/backtest/results/multiple_testing_correction_2026-07-25*.json`.

### Data source — found, imported, Phase 1 done — 2026-07-24

`S:\Housekeeping\junkyard\Binance_Historical_Data.db` (SQLite, 650MB) — pre-aggregated OHLCV
tables for every timeframe from 1m to 1w (`T_1m` ... `T_1w`), Binance BTC, **2017-08-17 through
2024-12-31/2025-01-05** (7.4 years). Validated, then imported via
`scripts/backtest/import-historical-data.js` into `data/historical/binance-btc-{tf}.csv`
(gitignored, regenerable from source) — **8,390,000 rows, 546MB, zero out-of-order timestamps
in any of the 14 files.** Phase 1 of §6's phasing is done.

| Table | Rows | Range |
|---|---|---|
| T_1m | 3,870,558 | 2017-08-17 -> 2024-12-31 |
| T_15m | 258,046 | same |
| T_1h | 64,525 | same |
| T_4h | 16,146 | same |
| T_1d | 2,694 | same |
| T_1w | 386 | 2017-08-17 -> 2025-01-05 |

(T_2m/T_3m/T_5m/T_30m/T_2h/T_6h/T_12h/T_5d also present, same range, not detailed here.)

Spans the 2017 bull/crash, 2018-19 bear, 2020 COVID crash + bull run, 2022 bear (Luna/FTX), and
2023-24 recovery — genuinely multi-regime, exactly what pillar 4 needs. Daily table checked for
gaps/duplicates: **zero of either** across 2,694 consecutive days.

**Decode gotcha:** the `timestamp` column is declared `TEXT` but stores raw binary — a
pandas/numpy `to_sql()` quirk. Actual encoding: **little-endian int64, nanoseconds since Unix
epoch** (standard `datetime64[ns]` byte layout). Confirmed against known BTC price history (row 1
decodes to 2017-08-17T04:00:00Z at open $4,261.48 — correct for that date). Any import script
must decode with this before the timestamps are usable.

**Proxy caveat:** Binance BTC spot, not our exact Coinbase nano-futures contract — same style of
mismatch already accepted for the SuperTrend monitor's Bitstamp proxy, just smaller in practice
(spot-to-spot cross-exchange vs. spot-to-futures).

**Also found in that same folder, not touched:** `binance api key.txt` and `kraken.key` sitting
in plaintext — not our concern to fix, flagged for iapaulo's own awareness. Two other candle
sources exist in the same folder (`Binance_Candles_Database.db`, `btcusd_1m_master.csv`) but
weren't vetted — `Binance_Historical_Data.db` is the strongest candidate found (clean schema,
full timeframe coverage, validated gap-free) so no need to chase the others unless this one
turns out to have issues on import.

## 7. Empirical research log

Tracking what public/published data exists (or doesn't) for our indicators' settings and
real-world edge — so "has anyone validated this" only gets researched once per indicator.

### Adaptive SuperTrend [AlgoAlpha] — researched 2026-07-24

**For this exact indicator: nothing.** Checked the TradingView script page, a derivative
"strategy" version (trade_crush's ML Adaptive SuperTrend Strategy), and general search — no
published backtest results, win rate, profit factor, or community-validated settings for
`atr_len`/`factor`/`training_data_period`/the volatility percentile guesses. Free community
script, feature description only, no performance validation from the author or anyone else.

**For the underlying classic SuperTrend (ATR+multiplier, no ML clustering) — real research
exists** and is directly relevant even though it's not our exact indicator. A 2024 arXiv
thesis used Bayesian optimization across 5 assets:

| Asset | Optimal ATR period | Optimal multiplier | vs. default (14/3) |
|---|---|---|---|
| Microsoft | 19 | 3.0 | **+233%** |
| Nvidia | 14 | 4.0 | +112.5% |
| HUL | 5 | 1.0 | +79.5% |
| Infosys | 14 | 5.0 | **−28%** (optimization made it worse) |
| Nifty 50 | 20 | 4.0 | default returned 0% profit |

**Headline finding, not a footnote:** optimal parameters "vary significantly across different
assets" — no universal best setting, and blind optimization can backfire. This reframes the
question: AlgoAlpha's K-means clustering is essentially an attempt to solve exactly this problem
(auto-adapt instead of hand-tune) — but nobody, including AlgoAlpha, has published whether their
specific approach (their percentile guesses, their 100-bar window) actually beats a well-tuned
static SuperTrend for any given instrument. Given even simple ATR/multiplier tuning is this
asset-specific, a generic "best settings" claim for our nano BTC futures shouldn't be trusted
either way without testing it ourselves.

Source: [Optimising Supertrend Parameters using Bayesian Optimization (arXiv:2405.14262)](https://arxiv.org/html/2405.14262v1)

### Smart Money Concepts [LuxAlgo] / ICT — researched 2026-07-24

**For the LuxAlgo indicator specifically: nothing**, same pattern as SuperTrend — no published
win rate, profit factor, or backtest data from LuxAlgo for the SMC indicator itself.

**For the underlying ICT/SMC methodology (order blocks, BOS/CHoCH, liquidity sweeps, FVG) —
genuine, unresolved controversy**, not just an absence of data:

- **Optimistic side:** community-reported backtests of specific rule-based SMC entries (e.g.
  order blocks after liquidity sweeps in discount zones) cite 50-65% win rates with profit
  factor >1.5 — but these are forum/community-level claims, not peer-reviewed, and vary by
  market/timeframe/execution.
- **Skeptical side, with actual statistical reasoning:** a critique argues SMC/ICT resists
  rigorous backtesting because it's fundamentally discretionary ("no objective way to use SMC...
  depends on how the person who uses it decides to use it"), which makes it unfalsifiable — a
  failed backtest gets attributed to misapplication, not the framework. It ran a **Monte Carlo
  simulation of 5 million random trading paths** (25% win rate, 1:3 R:R — pure breakeven-by-chance
  assumptions) and found outcomes up to $3.7M, with 15 paths exceeding $1M purely from variance.
  Argument: with 2.5M+ people trading SMC, the handful of famous "ICT success stories" are
  statistically expected from pure noise (survivorship bias), not evidence of edge. It also cites
  Reddit-documented backtests showing isolated Fair Value Gap setups are unprofitable in isolation.
- **Academic literature:** "limited attention," per search — SMC/ICT is largely a
  practitioner/retail-trading-community framework, not something with much peer-reviewed
  validation either way. One tangential academic thread (institutional trading behavior around
  earnings announcements showing superior information processing) is sometimes cited as loose
  support for the general "smart money moves differently" premise, but that's not evidence for
  the specific ICT trading rules (order blocks, BOS/CHoCH, etc.).

**Bottom line:** more contested than SuperTrend, not just under-researched. The subjectivity
critique matters directly for us — our SMC extraction (`extractStructure` in signal-grid.js)
reads LuxAlgo's own BOS/CHoCH/OB detection, which is itself one specific algorithmic
interpretation of an inherently discretionary framework. Worth remembering when weighing SMC
signals in the brief: this is the least empirically settled indicator in the stack, and its
own claims are genuinely disputed, not just untested.

Sources:
- [Smart Money Concepts (SMC) [LuxAlgo] — TradingView](https://www.tradingview.com/script/CnB3fSph-Smart-Money-Concepts-SMC-LuxAlgo/)
- [Dumb Money Concepts and Backtest Limitations — Sentient Trading Society (Medium)](https://medium.com/@SentientTradingSociety/dumb-money-concepts-and-stat-test-limitations-110dcd4b67cf)

### Bollinger Bands (optimized settings + divergence) — researched 2026-07-24

**One genuine academic paper found**, unlike the SuperTrend/SMC searches: ["Bollinger Bands
Thirty Years Later" (arXiv:1212.4890)](https://arxiv.org/abs/1212.4890), Mark Leeds. Real, but
answers a different question than ours — it's about the statistical/rolling-regression
foundations of Bollinger Bands and a pairs-trading variant ("Fixed Forecast Maximum Duration
Bands"), tested on SAP and Nikkei. No single-asset parameter-optimization or divergence-strategy
results in it. Cited for completeness, not as validation of anything we tested.

**Parameter optimization:** no rigorous single source, but consistent informal convergence
around the same default we already used (20-period, 2 std-dev) as a reasonable starting point —
one large-scale community backtest (TrendSpider, unverified methodology) reportedly found
SMA-20/2σ on a 60-min chart as "best" among tested combinations, and academic-adjacent technique
references exist for optimizing BB parameters via swarm/genetic algorithms for pairs trading
specifically (Butler & Kazakov; Ni & Zhang) — real methods, but not results we could verify or
that apply directly to our single-asset, non-pairs setup.

**Divergence-specific backtests — mixed, and one number is directly relevant to us:** a
community-reported cross-market backtest of a BB+divergence strategy found win rates of 60%
(EURUSD), 70% (US30), and **40% (BTC)** — crypto was the weakest of the three markets tested,
worth remembering before assuming a divergence approach transfers cleanly to BTC. A separate
source reported a Bollinger+RSI "double strategy" backtest across **4,032 parameter/pair/
timeframe combinations, of which only 1,849 (46%) had profit factor > 1** — i.e. the *majority*
of tested combinations were unprofitable. That statistic is the most trustworthy one found here
precisely because it's unflattering and specific, not a cherry-picked highlight.

**Higher-sounding numbers exist but couldn't be verified.** A MACD+BB divergence combo claiming
78% win rate / 1.4% per trade / 15% max drawdown, and a "Bitcoin Bollinger Bands strategy...
nearly 50% CAGR" claim, both come from the same content-marketing-style source
(quantifiedstrategies.com) that blocked direct verification (bot-check wall) both times it was
fetched. Not dismissed outright, but not weighted the same as the 46%-of-combinations-profitable
number above, which came with its own methodology visible in the search summary.

**How this lines up with what we found ourselves today:** the "most combinations don't help"
pattern in this research matches our own two-for-two negative results (SuperTrend+BB trend
filter: redundant; mean-reversion+SuperTrend gate: net negative, worse than random). That's
mutually reinforcing, not a coincidence to read too much into from two data points — but it does
mean our results aren't an outlier against the wider (thin, mixed-quality) literature; they're
consistent with it. The BTC-specific 40% divergence win rate is the most actionable single data
point here if a Bollinger Band divergence strategy is tried next — go in expecting BTC to be the
harder market for this to work in, not the easier one.

Sources:
- [Bollinger Bands Thirty Years Later (arXiv:1212.4890)](https://arxiv.org/abs/1212.4890)
- [Bollinger bands trading strategy (with divergence) — AsiaForexMentor](https://www.asiaforexmentor.com/bollinger-bands-trading-strategy/)
- [12 Bollinger Bands Trading Strategies: Backtested With Settings — QuantifiedStrategies.com](https://www.quantifiedstrategies.com/bollinger-bands-trading-strategy/)

## 8. Changelog

- 2026-07-25 — Multiple-testing correction (`scripts/backtest/lib/multiple-testing.js`,
  Bonferroni/Holm/Benjamini-Hochberg) applied across the 5 strategy variants Monte-Carlo-tested
  this session. **None survive correction, including supertrend-flip long-short (raw p=0.022,
  Bonferroni threshold at n=5 is 0.01)** — downgraded from Supported back to Hypothesized per
  epistemology.md's claim labels. The costed/fee-tier work still stands (real net-profitability
  at the confirmed fee tier is unaffected), but "statistically distinguishable from random" does
  not survive being corrected for the 5 variants searched this session. Fix requires one new,
  pre-registered test outside this family (e.g. a second asset), not more re-runs within it. See §6.
- 2026-07-25 — iapaulo confirmed Coinbase's actual funding MECHANISM (hourly, basis-driven,
  peer-to-peer transfer between longs and shorts) — revealing the original cost model's
  "funding always costs both sides" assumption was mechanistically wrong (funding is zero-sum
  between the two sides, not a fee charged to everyone). Added a `signed_contango_bias` mode to
  `applyCosts()` (long pays, short receives) alongside the legacy `pessimistic_both_sides` bound.
  4H long-short's real net return now spans 1.45x (pessimistic) to 4.19x (signed) depending on
  this one assumption — both profitable, real historical funding sign/magnitude data still not
  sourced and remains the top open item. See §6.
- 2026-07-25 — iapaulo confirmed the real Coinbase derivatives fee tier from the account
  dashboard (Advanced 1, 0.070%/0.065% taker/maker) — resolving mitigation item #3 and
  confirming the earlier "retail_worst_case" figure was Coinbase's spot tier, never actually
  paid, overstating real costs ~8x. Re-ran cost sensitivity + costed Monte Carlo with the real
  number: **4H long-short is now both statistically significant (p=0.022) and net-profitable
  (1.45x/+145%) at real costs** — a materially better result than either the gross number or
  the wrong-tier number suggested. Still fragile to the funding-rate assumption specifically
  (3x funding stress flips it to a loss) — funding magnitude is now the largest remaining
  cost-model uncertainty, having replaced fees as the open question. See §6.
- 2026-07-25 — Costed Monte Carlo re-test (`randomEntryBaseline`'s new `costParams`, applied to
  both real and random draws at the retail-worst-case tier). Result: 4H long-short's edge is
  still statistically significant after matched costs (p=0.022) but NOT profitable at that tier
  (real ends down 95%, random even worse) — significance and profitability are separate
  questions here, and only the first one survives. Also surfaced a modeling suspicion: 356
  round trips at 0.60% taker implies 400%+ cumulative fee drag, punishing enough to suspect
  `retail_worst_case` is Coinbase's *spot* fee tier, not derivatives-specific — real futures
  fees are typically flat-$-per-contract, which would need a structural change to the cost
  model, not just a different number. See §6.
- 2026-07-25 — Institutional-quant-lens critique of the full backtest program to date (6
  strategy variants), followed by the first mitigation: a cost-sensitivity sweep
  (`scripts/backtest/lib/costs.js`, wired into `run-harness.js`). Sobering result: the one
  statistically-significant finding so far (4H long-short vs. random, p=0.023) is wiped out
  (-95%) at a realistic retail fee/funding tier and only turns net-positive again at an
  unconfirmed high-volume tier — see §6. Coinbase's fee-schedule and funding-rate pages both
  blocked automated fetch (403), so the fee tier used is a third-party-sourced, explicitly
  worst-case-labeled anchor, not a confirmed number; funding cadence (hourly) is reasonably
  confirmed. Five more mitigation items (costed Monte Carlo re-test, real fee-tier confirmation,
  multiple-testing correction, parameter-sensitivity sweep, second asset, true walk-forward
  split) remain open, tracked in §6's new subsection.
- 2026-07-25 — Received source for Boom Hunter Pro, the last of the 5 TV-native indicators
  (`pine/boom-hunter-pro.pine`) — full source coverage of the stack achieved, see §2 milestone
  note. Found and resolved a real ambiguity: the script reuses the plot titles "Quotient 1"/
  "Quotient 2" six times across 3 separate oscillator systems, and "Exit Warning"/"Break" twice
  each for opposite-direction conditions -- the Data Window silently collapses same-titled plots
  to their last-defined value. Resolved via source read-order ("last plot() wins"): Quotient 2 =
  the main EOT-1 oscillator (q1), Quotient 1 = its trigger line; most notably, "Break" turns out
  to mean the *bullish continuation* signal, not the short setup (`senter3`) its naming pattern
  would suggest -- flagged for a live-UI double-check rather than treated as fully certain.
  Rewrote `extractBoomHunter()` in signal-grid.js to pull the 4 distinct Long gray/yellow/blue/
  Lime signals (unique titles, trustworthy) plus a derived `momentum_direction` from
  quotient_2 vs quotient_1, with the ambiguous Exit Warning/Break fields explicitly labeled as such.
- 2026-07-25 — Received source for Cipher A and Smart Money Concepts (4 of 5 TV-native
  indicators now have source; only Boom Hunter remains). Fixed a real bug: Cipher A's
  `ribbonDirection()` was a guessed monotonic-8-EMA-stack heuristic, stricter than the
  indicator's actual `ema8 < ema2` formula -- corrected and verified against live data.
  Resolved the "order block color unverified" open item: SMC's box color is ABGR-packed, not
  ARGB; decoded and confirmed exact matches to source for both a bullish and bearish box.
  Found a new gap while reading the source: BOS/CHoCH label text alone never encoded direction
  -- every prior "most recent structure" read this session inferred direction from price
  context, which was the best available approach but not a guarantee. Noted, not yet fixed.
- 2026-07-24 — Researched Bollinger Bands optimized settings + divergence (§7). One real
  academic paper found (pairs-trading focused, not directly applicable). Most useful data point:
  a community backtest across 4,032 parameter/pair/timeframe combos found only 46% profitable
  (PF>1) -- majority failed, matching our own two-for-two negative results today. BTC-specific
  divergence win rate (40%) was the weakest of three markets tested -- worth knowing before
  trying a divergence-based approach on our instrument.
- 2026-07-24 — Tested mean-reversion entries at the Bollinger Bands, gated by SuperTrend
  direction (the reversed combination role). Loses money outright (0.46x long-short, 0.72x
  long-only) and is *worse* than a random-entry baseline with the same trade shape (14th
  percentile, p=0.859) -- not just no edge, negative edge. Avg loss > avg win despite >50% win
  rate. Two different SuperTrend+BB combination roles tried today, both failed -- intuition about
  "plausible-sounding combinations" was wrong both times, exactly why the harness exists.
- 2026-07-24 — Tested SuperTrend + Bollinger Bands (standard trend-agreement filter) through the
  full harness. Negative result: does nothing for long-only (0 trades ever filtered), and barely
  anything for long-short (3 of 356 trades filtered, metrics very slightly worse). Redundant with
  SuperTrend's own trend logic in this role -- documented as a real finding, not a dead end to
  hide, and noted that a different combination role (mean-reversion entries, squeeze breakout)
  wasn't tried.
- 2026-07-24 — Phase 3 (anti-overfitting harness) done, run on both 4H variants. Result:
  flips the Phase 2 conclusion. 4H long-only's headline 27.8x is statistically indistinguishable
  from a random-entry baseline with the same trade shape (p=0.104). 4H long-short, despite the
  lower raw return, clears significance (p=0.022) — the short side appears to carry real signal
  in bear years specifically, not dead weight. Not decision-grade yet, but the harness did
  exactly what it was built for on its first real use.

- 2026-07-24 — Phase 2 (own JS backtest engine) done, proved on SuperTrend. First real results:
  4H long-only beats buy-and-hold (27.8x vs 21.5x) with less drawdown; 4H long-short and 1D
  long-short both lose to buy-and-hold, 1D long-short loses money outright despite profit factor
  >1 (real sequence-risk catch, not a bug). All in-sample, no anti-overfitting harness yet --
  Phase 3 next, before any of this is decision-grade.
- 2026-07-24 — Phase 1 (historical data layer) done: `scripts/backtest/import-historical-data.js`
  decoded all 14 timeframe tables from `Binance_Historical_Data.db` into clean CSVs under
  `data/historical/` (gitignored, regenerable from source). 8,390,000 rows total, 546MB, zero
  out-of-order timestamps across any table. Ready for Phase 2 (own JS backtest engine, proved on
  SuperTrend first).
- 2026-07-24 — added §6 Backtesting lab design (pillars, phasing) and a validated data source:
  `Binance_Historical_Data.db` (7.4yr multi-timeframe BTC OHLCV, gap-free, decode gotcha solved).
  Fixed a section-numbering gap (§6 didn't exist before). About to build the import.
- 2026-07-24 — doc created. Captures state after: 5-indicator signal grid with full Cipher B
  battery, Coinbase futures watchlist switch + proxy mapping, self-healing Data Window fix.
- 2026-07-24 — multi-pane parallelism question tested and closed (§5.1): not viable, plan-capped
  and reads aren't actually concurrent. Discovered a stale second pane with unrelated leftover
  indicators from earlier experimentation — left in place untouched, just not in the active layout.
- 2026-07-24 — added empirical research log (§7): no public validation exists for either
  AlgoAlpha's ML Adaptive SuperTrend or LuxAlgo's SMC specifically; SMC/ICT as a methodology has
  genuine, unresolved controversy (not just an absence of data). Raised backtesting path priority.

## 9. Per-indicator signal bus (Divergence for Many) — 2026-07-25

Started under the architecture decision (2026-07-25): each indicator gets its own signal bus +
lab page, not a shared generic schema — the signal shapes differ too much (event-only, zone-only,
mixed) to force into one model. Divergence for Many is the first one built, end to end, prompted
by a live observation: 4H showed no divergence badge while 2H/3H had active promoted zones price
was interacting with — different resolutions genuinely compute different structure, not just
noisier/cleaner views of the same thing.

**Pipeline** (`scripts/signal-bus/divergence-for-many/`):
- `calc.js` — faithful JS port of the Commander-default promoted-glow-level logic (pivot
  detection, regular-divergence "virtual line" check, ATR dedup, capacity eviction, bar-count
  expiry). Verified against real BTC history (correct price levels at known dates, e.g. the Dec
  2017 top, Dec 2024 near-ATH). Extended to support any of 10 implementable indicators (Commander
  default uses 4: MACD, MACD Histogram, RSI, Stochastic) via an `enabledIndicators` option,
  default-preserving.
- `touches.js` — interaction detection: maximal runs of consecutive bars touching a zone, with
  outcome (held/broken), penetration depth, approach direction, and a `polarityFlipRetest` flag
  (a level tested from the side opposite its creation side — added after a direct question
  surfaced it wasn't being distinguished from a fresh test).
- `confluence.js` — one algorithm for both same-timeframe tight clustering and cross-timeframe
  hierarchical confluence (price-close + time-overlapping + same-side zones, regardless of
  whether the matched pair shares a timeframe).
- `store.js` — own SQLite DB (`data/signal-bus/divergence-for-many.db`, gitignored/regenerable).
- `build-historical.js` — full W/D/4H/3H/2H/1H/15m/5m rebuild in under 2 seconds (offline, no
  TradingView connection needed — the payoff of the backdata-first decision).
- `indicator-sweep.js` — exploratory, read-only: does enabling the 6 disabled indicators help?
  Answer: mostly just increases frequency, not quality (individual additions swing hold rate by
  only ~±1 point); the fixed showlimit=3 threshold matters more in relative terms as the pool
  grows (confirmed: proportionally scaling it to 7 for 10 indicators collapses zone count without
  a clear quality gain). One modest lead (all 10 enabled, threshold unchanged) not yet tested.
- `confluence-significance.js` — permutation significance test, see result below.
- `analytics-page-template.html` + `build-analytics-page.js` — the "enterprise grade lab page," DB-driven (queries the live SQLite DB and reruns the permutation test fresh, not a hand-transcribed snapshot) so rerunning after any future rebuild keeps it current. Output: `analytics-page.html`, also published as an Artifact.

**Real bugs caught by testing against real data, not assumed correct:**
1. Touch detection initially only checked one side of the price (`low <= price` alone for a
   bullish zone), which is also true for bars fully past the level and drifting further away —
   silently merged "broke and drifted for 100+ bars" into one interaction. Caught by asking what
   should happen on a from-below retest: 0 polarity-flip retests out of 17,037 touches was the
   implausible tell. Fixed to require the level fall within the bar's actual range.
2. First confluence tolerance (max of each zone's own ATR-derived tolerance) let a weekly zone's
   naturally huge ATR reach out thousands of dollars, sweeping in zones nowhere near a real
   cluster (caught by inspecting the max-confluence example: pairs $2,900–$8,400 apart). Fixed to
   a flat 0.2%-of-price tolerance (a starting assumption, not validated).

**Headline result — the confluence-vs-hold-rate finding survives significance testing:**
53.4% (isolated) → 55.6% (2-way) → 60.6% (3-way) hold rate, tested via zone-level permutation
(shuffle confluence-count labels across zones, keep each zone's real touch outcomes, 50,000
iterations) rather than a touch-level shuffle that would pseudo-replicate and understate the true
null variance. **p=0.0002 (point-biserial correlation), p=0.0001 (3-way vs. isolated gap)** — both
real statistics sit past roughly the 99.98th percentile of the permuted null. This is the first
result in the whole cartographic/hierarchical thread to survive the same rigor the backtest
program's strategies were held to (the 82–88% hold rate claim earlier this session did NOT
survive — it was a bug; this one does). Still not decision-grade on its own: one indicator, one
asset (BTC), 4+ confluence bucket too thin (n=171) to read, and this tests "does the pattern
exist" not "is it tradeable" (no cost model, no capacity check — the same gap the backtest
program's strategies needed filled before anything about them was actionable).

**Follow-up, 2026-07-27: cost/capacity test on the confluence finding, run rather than assumed —
result is trade-construction-blocked, and for a different reason than SMC's version of this same
test.** Mirrors §10's SMC order-block confluence cost/capacity test exactly in method
(`scripts/signal-bus/divergence-for-many/confluence-backtest.js`), adapted for the one structural
difference: these zones are lines, not boxes, so there's no natural far-boundary exit price the
way an order block had one. Both "held" and "broken" touches exit the same way — next-bar-open
after the interaction ends — rather than inventing a boundary that doesn't exist in this
indicator's own logic. Entry stays next-bar-open after the touch starts (no look-ahead, same
discipline as everywhere else). 27,851 completed trades, all 8 timeframes combined, bucketed by
confluence count exactly as the significance test bucketed them.

*Naive construction — gross is barely above breakeven, and the reason is not what it looks like
at first:*

| bucket | n | trades/yr | win rate | avg win | avg loss | win/loss ratio | PF | costed net |
|---|---|---|---|---|---|---|---|---|
| 1 (isolated) | 21,955 | 2,978.7 | 28.9% | 0.298% | 0.118% | 2.53x | 1.03 | −1.00x |
| 2 | 4,901 | 664.9 | 28.0% | 0.409% | 0.154% | 2.65x | 1.03 | −1.00x |
| 3 | 824 | 111.8 | 30.9% | 0.699% | 0.307% | 2.28x | 1.02 | −0.70x |
| 4+ (top) | 171 | 23.2 | 28.1% | 1.199% | 0.449% | 2.67x | 1.04 | −0.25x |

The win/loss size ratio here is actually *favorable* (2.3–2.7x, no asymmetry problem the way SMC's
naive construction had) — but win rate sits at 28–31%, far below the 53–60% **hold rate** the
significance test measured. That gap is the real finding: "held" (the zone's price level wasn't
crossed during the interaction) and "this specific entry-to-exit window made money" are different
measurements. A zone can hold — the classification the confluence test validated — while the
trade built on top of it (entered at the touch's start, exited at its end) still nets a small
loss, because favorable movement inside that window isn't guaranteed by the level merely holding.
Net effect: gross profit factor lands at 1.02–1.04 across every bucket, an edge too thin to call
real before costs, let alone after. Real-cost (confirmed derivatives, 0.070%/0.065% + pessimistic
funding) collapses every bucket to decisively negative, with the two highest-frequency buckets
(isolated: 2,978.7 trades/yr; bucket 2: 664.9 trades/yr) hitting the −1.00x floor — at that
frequency, round-trip costs (~0.14%+ funding) are the same order of magnitude as the average win
itself (0.298–0.409%), so cost drag alone is close to sufficient to erase the edge, and it
compounds fast at thousands of trades per year. The lower-frequency buckets degrade less
violently (3: −0.70x; top: −0.25x) simply because there are far fewer trades to compound the drag
through, not because their per-trade economics are meaningfully better.

*Fixed R:R follow-up — unlike SMC, does not rescue the top-confluence bucket at any R multiple
tested* (`confluence-backtest-fixed-rr.js`, risk = 0.6×ATR(14) at zone creation — the same
constant `calc.js` already uses for zone dedup, not an invented number — target = entry ±
R-multiple×that, race-to-target-or-stop, R ∈ {1, 1.5, 2, 3}):

| bucket | 1R gross | 1.5R gross | 2R gross | 3R gross | 3R costed |
|---|---|---|---|---|---|
| 1 (isolated) | −1.00x | −0.99x | −0.96x | −0.91x | −1.00x |
| 2 | −0.43x | −0.26x | +0.32x | **+1.20x** | −1.00x |
| 3 | −0.34x | −0.18x | −0.11x | −0.21x | −0.77x |
| 4+ (top) | +0.03x | −0.09x | −0.12x | −0.28x | −0.47x |

SMC's fixed-R:R retest found forcing a designed R-multiple exit fixed its win/loss asymmetry and
turned the top-confluence bucket gross-positive at 3R. Here, the top-confluence bucket ("4+")
never turns gross-positive at any R multiple — it's flat-to-negative throughout and gets *worse*
as R increases (+0.03x at 1R down to −0.28x at 3R), the opposite direction from SMC's pattern. The
only bucket that turns sharply gross-positive is the *2-way* bucket at 3R (+1.20x) — but at 664.9
trades/year, real costs still crush it to the −1.00x floor, because the frequency-driven cost
problem from the naive test doesn't go away just because the exit rule changed. No R multiple,
confluence bucket, or exit design tested here clears real costs anywhere in the grid.

**Conclusion: `trade-construction-blocked`, same label as SMC's order-block confluence finding,
but a materially different diagnosis — don't collapse the two into "confluence doesn't translate
to trades" as if it's one universal problem.** SMC's block was a fixable size-asymmetry problem
that a designed R:R almost cleared (3R got to +0.34x gross before costs took it back to −0.93x).
This one is a thinner, more structural problem: the classification's "held" outcome doesn't
predict same-window P&L sign well enough to produce a real gross edge in the first place (PF
1.02–1.04 even before costs), a fixed R:R exit doesn't fix that at the one bucket that would
matter (top-confluence), and the buckets that do show a designed-exit gross edge fire far too
often for real transaction costs to survive. The underlying classification (higher confluence →
higher hold rate, p=0.0002/0.0001) remains real and unshaken — only the leap from that
classification to a standalone trade is blocked, and it's blocked harder here than it was for SMC.

## 10. Per-indicator signal bus (SMC) — 2026-07-25/26

Second indicator on the pattern, prompted by a direct question about whether directional colors
(EQH/EQL specifically) are faithfully observable in our own output, not just documented. Answer:
yes, and it surfaced something not everyone would assume — order blocks are **blue/red-family**
(`#3179f5`/`#1848cc` bullish, `#f77c80`/`#b22833` bearish), not green/red like structure and
EQH/EQL (`#089981`/`#F23645`), confirmed directly from `pine/smart-money-concepts-luxalgo.pine`
before writing any code, not assumed.

**Pipeline** (`scripts/signal-bus/smc/`): `calc.js` (leg-based pivot detection — separate
persistent leg trackers per size, matching Pine's per-call-site `var` state; BOS/CHoCH for both
internal size-5 and swing size-50 scopes, with the internal/swing duplicate-pivot suppression the
source itself applies; EQH/EQL; order blocks via parsed-high/low extremes with the ATR
high-volatility-bar swap filter and HIGHLOW-source mitigation) → `touches.js` (order-block touch
tracking — ranges, not lines, so a touch means the bar's range overlapping the box; "broken" ties
directly to the block's own precise mitigation event rather than a heuristic, since mitigation is
already terminal and exact) → `store.js`/`build-historical.js` (own DB, same 8-timeframe ladder) →
`confluence.js` (order blocks scored against a combined pool of other order blocks + EQH/EQL +
structure breaks, price-tolerance-matched and time-window-overlapped) → `confluence-significance.js`
(order-block-level permutation test) → `analytics-page-template.html`/`build-analytics-page.js`.

**Verified against real data:** real, historically accurate price levels at every date spot-checked
(Dec 2024's run through $100k, Jan 2018's crash); a "broken interaction must show ~100%+ box
penetration" invariant held with zero violations; a real example — a $18,626–$19,980 demand block
from the July 2022 lows survived six tests (up to 79% penetration) over two months before finally
failing on the seventh.

**Headline result — larger effect, more scrutiny applied, not less:** hold rate by confluence
degree runs 34.7% (confluence=1, isolated) up to 68.0% (confluence=8, all timeframes agreeing) —
a much bigger gradient than Divergence for Many's (53.4%→60.6%). A dramatic-looking result is
reason for *more* caution given the 82–88% bug earlier this session looked dramatic too and was
wrong — so this was pushed to 200,000 permutation iterations rather than stopping at the first
clean-looking p-value. Result held: **r=0.1163, the null never approaches it even at 200,000 draws
(max permuted 0.094) — p<0.00001**, the strongest-tested finding in the signal-bus project so far.
Confluence pool density means 97% of order blocks show *some* confluence (expected, given 68,781
structure events alone in the pool) — the informative signal is confluence *degree*, not presence.

**Deferred, same as Divergence for Many:** cost/capacity testing, a second asset — descriptive and
tested is not yet tradeable. FVG (off by default in the source) and Premium/Discount zones (a live
single-state display, not a historical zone series) remain out of scope for this pattern entirely.

**Liquidity zones (EQH/EQL) — added, then tested, then correctly downgraded — 2026-07-26.**
Flagged directly by iapaulo: EQH/EQL *is* the SMC/ICT liquidity concept (resting stops above
equal highs, below equal lows), but had only ever been used as a confluence input, never analyzed
on its own terms. Added `liquidity.js` (sweep + reversal detection, provably can't trigger before
or on the confirming bar by construction of the pivot logic) — first pass showed a striking ~81%
aggregate reversal-after-sweep rate, consistent across all 8 timeframes, matching the classic ICT
"stop-hunt precedes reversal" story.

**That number did not survive testing, and the result changed the conclusion, not just refined it.**
Built `liquidity-significance.js`: for every real swept EQH/EQL, draws a random bar from the same
timeframe's series and runs the identical two-stage sweep-then-reversal check against an
unvalidated level, to isolate whether being a genuine pivot-confirmed liquidity level matters
beyond "being some bar's high or low." First version of that test had its own bug (checked
reversal starting from the same bar that defined the level, which trivially passes for almost any
non-doji candle — produced a nonsensical 99.55% null rate, caught before trusting it). Fixed to
mirror the real algorithm's actual two-stage structure. Corrected result at 3,000 iterations: real
rate 81.15% sits **below the entire null range** ([83.81%, 85.98%]) — arbitrary price-level
crossings reverse *more* reliably than genuine liquidity sweeps, not less. p=1.0000. **The
"liquidity sweep precedes reversal" narrative does not hold up here.** Reported on the analytics
page as a tested negative result, not omitted or left as an unresolved lead — the third time this
session a dramatic-looking raw number was checked properly and didn't survive (after the 82-88%
Divergence-for-Many hold-rate bug and the backtest program's uncorrected p-values), and each time
the correction was the point, not a failure of the exercise.

**Cost/capacity testing on the order-block confluence finding — 2026-07-26, a new failure mode,
not just "costs ate the edge."** The confluence finding (p<0.00001) is a hold/break
*classification*, not a strategy — no entry/exit/P&L existed yet. Built
`confluence-backtest.js`: constructs real trades from the touch data (next-bar-open entry when
price enters a zone; exit at next-bar-open once price clears the zone if "held," or at the zone's
own boundary price at its real mitigation time if "broken"), bucketed by confluence tier, run
through the SAME confirmed cost model already built for the main backtest program
(`scripts/backtest/lib/costs.js` — the real Coinbase derivatives fee tier, both funding-sign
assumptions) rather than re-deriving costs from scratch.

**Result: negative gross P&L in every bucket, including the best one.** High confluence (6-8):
53.6% win rate, but net return **-0.78x gross**, before any fees. Diagnosed, not just reported:
avg_loss runs 1.7-2.8x avg_win across all three buckets (low: 0.25%/0.69%; mid: 0.46%/0.91%; high:
1.16%/1.98%) — because this specific trade construction caps wins at "price just cleared the
zone" while losses ride the full zone width to the boundary stop. A 53.6% win rate cannot
overcome a loss size nearly double the win size; the arithmetic doesn't work regardless of costs.
Costs make it modestly worse (-0.78x → -0.90x at the confirmed derivatives tier) but are **not the
deciding factor** — this fails on trade construction, not on fees. Capacity is not the problem
either: 79.5 trades/year at high confluence, 86.3/year at mid — plenty of frequency, the strategy
just loses money per trade.

**What this does and doesn't mean:** the underlying classification finding (higher confluence
predicts a more reliable hold) is still statistically real — that hasn't changed. What's now clear
is that "reliable hold rate" doesn't automatically imply "profitable if you just buy/sell the zone
and exit on resolution." Win rate and R:R asymmetry both matter, and this trade construction has
bad R:R baked in by design (small capped win, full-zone-width loss). A different exit rule (e.g. a
symmetric R-multiple target, or riding toward the next opposing zone instead of exiting at the
first clear) is the obvious next thing to test — flagged as a new, separate hypothesis to test
properly, not assumed to be the fix and not built yet, to avoid exactly the "keep changing the
rule until it looks good" pattern this whole session has been disciplined about avoiding.

Results saved to `scripts/signal-bus/smc/results/confluence_backtest_*.json`.

**Follow-up, 2026-07-27: the flagged fixed-R:R exit test, run rather than assumed.** Built
`confluence-backtest-fixed-rr.js` — same entry and same stop (the order block's own far
boundary, unchanged), but the exit is now a genuine fixed R-multiple target (1R/1.5R/2R/3R)
instead of "exit whenever the zone happens to clear." Tested 1R through 3R, all three confluence
buckets, both gross and at the confirmed real cost tier.

**Diagnosis confirmed, not just asserted:** avg_win/avg_loss ratio at 1R (high confluence) is
2.60%/2.85% — a ratio of 1.10, essentially symmetric, versus the original construction's 1.7-2.8x
skew. At 3R it's 6.65%/2.83%, a ratio of ~2.35, tracking the designed 3:1 target closely (some
slippage from stop-out imprecision expected). **The fix does exactly what it was built to do: it
eliminates the size asymmetry that was the original diagnosis.**

**Real, if modest, progress — not a full recovery.** At 3R, high confluence turns **gross-positive
for the first time** (+0.34x, win rate 32.4% against a 25% breakeven threshold for 3:1 R:R — a
genuine, if thin, positive edge). But the confirmed real cost tier still wipes it out
(**-0.93x costed**) — the win/loss asymmetry problem is fixed, and what's left standing in its
place is cost drag, principally funding accumulated over the longer hold times a bigger R-multiple
target requires. Every other R-multiple/bucket combination remains negative both gross and costed.

**Bottom line: `trade-construction-blocked` is still the right label, but the reason has
changed.** It's no longer "this exit rule has bad R:R baked in" (fixed) — it's "even a properly
symmetric R:R, on this classification, doesn't clear real trading costs at the sizes/hold-times
this construction produces." A genuinely different, narrower problem than before, and worth
distinguishing precisely rather than leaving the original blanket verdict unchanged.

Results saved to `scripts/signal-bus/smc/results/confluence_backtest_fixed_rr_*.json`.
