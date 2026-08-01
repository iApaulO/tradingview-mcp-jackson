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
5. **SMC confluence vs. nesting — sketched 2026-07-28, corrected 2026-07-28 (see §10's confluence-
   metric-gap writeup for the finding that prompted the correction).** iapaulo's own discretionary
   read of the chart ("nested signals seem more truthful") surfaced a real vocabulary gap: this
   project has been using "confluence" for one specific thing (`confluence.js`: same-side,
   price-close, time-overlapping — a *proximity* relationship, and specifically, per the gap found
   2026-07-28, **distinct-timeframes-only**) while at least two related but different concepts
   have gone unnamed and untested:
   - **Geometric nesting/containment** — one structure's price range strictly *containing*
     another's (an LTF order block wholly inside an HTF one, an EQH/EQL level inside an active
     order block's box). Stricter than proximity confluence. Not yet built.
   - **Same-timeframe sequential recurrence** — how many times has demand/supply re-formed at a
     price band on ONE timeframe over a rolling window, regardless of any other timeframe
     agreeing. This is what iapaulo's live chart example turned out to be (six same-timeframe 4H
     order blocks overlapping over three weeks, `confluenceCount = 1` for every one of them
     because they share a timeframe). Also not yet built.

   Proposed design, still sketching, not decided:
   - `mtf-snapshot.js` — `getActiveStructuresAt(timestamp)`: given a moment in time, return every
     SMC structure across all 8 timeframes currently live (order block created but not yet
     mitigated, EQH/EQL confirmed but not yet swept, most recent BOS/CHoCH per timeframe/scope).
     The missing piece today — every existing query is timeframe-siloed; nothing gives a
     whole-board-at-once view.
   - `nesting.js` — `computeNesting(snapshot)`: strict range-containment check (not the 0.2%
     tolerance `confluence.js` uses) between every pair of active structures, any two timeframes,
     producing a `nestingDepth` per structure.
   - A third, new pass for **same-timeframe recurrence**: for a given price band and timeframe,
     count how many order blocks (mitigated or not) have originated there within a rolling lookback
     — a `recurrenceCount` distinct from both `confluenceCount` (cross-timeframe) and
     `nestingDepth` (geometric containment).
   - Payoff: all three become independent bucketing variables, testable with the exact method
     already proven out in this project (zone-level permutation, hold-rate-by-bucket, then the
     cost/capacity gauntlet) — directly turning "nested/stacked signals feel more truthful" into
     a falsifiable claim per mechanism, rather than one blended intuition.

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

**Data refresh, 2026-07-28: gap-filled through today, venue switch to Coinbase.** The historical
data had gone stale — checked the *source* DB directly (not just our derived CSVs) and confirmed
it stops at 2024-12-31 too (its file mtime is Feb 2025, but nothing inside is newer). Binance's
live API is also geo-blocked from this environment (`api.binance.com` returns "restricted
location"). Switched the gap-fill source to Coinbase's public Exchange API
(`api.exchange.coinbase.com`, no auth) — deliberately, not just as a workaround: it's the actual
venue family this project's cost model is already built around (confirmed Coinbase Advanced
derivatives fee tier), so this is less of a proxy than Binance ever was, not more.

- `scripts/backtest/fetch-coinbase-gapfill.js` — fetches native Coinbase granularities (5m/15m/1h/1d)
  from each CSV's last timestamp through now, paginated (300 candles/request, self-throttled).
  Coinbase's candle response is `[time, low, high, open, close, volume]` — different field order
  than our CSVs, mapped explicitly, not assumed. Ran 2026-07-28: 165,032 (5m) / 55,013 (15m) /
  13,756 (1h) / 574 (1d) new candles, all through 2026-07-28T13:00Z.
- **Seam checked, not assumed clean:** last Binance close (2024-12-31) vs. first Coinbase value
  (2025-01-01T00:00Z) — $93,576 vs. $93,347.59 open, a ~0.24% gap, consistent with ordinary
  cross-venue basis, not a discontinuity worth correcting for.
- `scripts/backtest/build-aggregated-candles.js` — generalizes the existing `build-3h-candles.js`
  pattern (`aggregate-candles.js`, UTC-bucket-aligned) to all four non-native timeframes: 2H/3H/4H
  from 1H, 1W from 1D. Coinbase has no native 2h/4h/1w granularity at all (only
  1m/5m/15m/1h/6h/1d), so this synthesis is now load-bearing for more of the ladder than before.
- Both signal buses (`smc/build-historical.js`, `divergence-for-many/build-historical.js`)
  rebuilt against the extended data — all 8 timeframes now run through 2026-07-28, BTC ~$63,400
  in the newest bars.
- **Not yet re-run:** every cost/capacity and significance test in §9/§10/§11 was computed against
  the *old* (pre-2025-01-01) data window. None of those results are invalidated by the refresh —
  the underlying method didn't change — but none have been re-checked against the extended window
  either. Treat existing findings as still the best evidence available, not as freshly re-validated.

**Verification prompted by a live discretionary chart read (iapaulo, 4H chart, order blocks
around $61k–63k support, late Jun–Jul 2026) — partial match, not a full confirmation.** Queried
the rebuilt `smc.db` for 4H order blocks in that window rather than taking the read at face value
(per standing practice — a live read should be checked against real indicator data before being
treated as confirmed). Two of the four described zones line up closely:

| Described | Found in rebuilt data | Match? |
|---|---|---|
| 2 Jul, $61,160–62,185 | internal bullish, $61,067.81–62,147.89, created 2026-07-03, **still active** | Close — 1-day/~1% offset, plausibly the same zone |
| 6 Jul, $61,310–63,055 | **no order block with this range found** | No match |
| 13 Jul, $61,825–62,215 | internal bullish, $61,750.90–62,567.99, created 2026-07-14, **still active** | Roughly close, wider on the high side |
| 17 Jul, price re-tests the 6 Jul zone | can't confirm — the zone itself isn't found | Unconfirmed |

Nine distinct order blocks touched the $60k–64k band between 2026-06-24 and 2026-07-28, but only
**two are still active (unmitigated)** as of today — the rest were mitigated (broken) at some
point and, per LuxAlgo's own source (`orderBlocks.remove(index)` on mitigation), would have been
deleted from the chart entirely once that happened. That doesn't match a "5 currently stacked"
picture. Most likely explanation: a data-feed difference (this rebuild is Coinbase Exchange
BTC-USD spot; the live chart is presumably a different exact instrument/feed) shifting which
exact wicks trigger detection/mitigation — not ruled out: a reimplementation discrepancy, or the
indicator's `HISTORICAL` vs. `PRESENT` mode setting on the live chart affecting what's retained.
Two of four zones matching approximately, one clearly not matching, is a real, mixed result — not
grounds to fully confirm or fully dismiss the discretionary read.

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

**Correction, 2026-07-28: the "EQH/EQL = liquidity zone" equivalence was an unverified assumption,
not an established fact — pushed back on directly (iapaulo), and the pushback is correct.**
`equalHighsLowsThresholdInput` defaults to **0.1 × ATR** — two pivots count as "equal" because
they're within a tolerance band, not because they're actually equal. This project's own framing
("EQH/EQL is the house's operationalization of liquidity zones," used when building
`scripts/signal-bus/smc/liquidity.js`) borrowed that equivalence from general ICT convention
(clustered near-equal highs/lows are said to mark resting stop-liquidity) — it was never
independently verified as the *correct* operationalization. EQH/EQL could easily be a weak or
wrong proxy for whatever "liquidity zone" actually means; real liquidity pooling might show up
somewhere else entirely (single strong swings, volume concentration, round numbers) that this
project hasn't looked at. **Concrete consequence: the EQH/EQL-sweep-reversal finding (above,
§10, labeled FALSIFIED) must be read as "falsified *as operationalized via EQH/EQL*," not as a
blanket statement that liquidity-sweep-reversal doesn't exist as a phenomenon.** Those are
different claims — the register's wording is being tightened to make this explicit rather than
implying more than what was actually tested.

**Order-block anchoring diagnosis, 2026-07-28 — verified a live discretionary chart read down to
the exact bar and rule, not just the price range.** iapaulo described a 4H order block ("zone 2"
of the stacked cluster below) at approximately $63,245–$61,210, attached to a red candle, formed
around 6 Jul 2026. Located it precisely in the rebuilt data: **internal bullish order block,
origin candle 2026-07-06T08:00 UTC** (a real red 4H candle: O=63,024.27, H=63,177.93, L=62,421.85,
C=62,421.85), box = **$62,421.85–$63,177.93**, mitigated 2026-07-08. The red-candle clue and the
high end ($63,177.93 vs. described $63,245) check out closely. The low did not (**$62,421.85 vs.
described $61,210**) — traced to a specific, verifiable rule rather than left as an unexplained
gap: the very next 4H candle (2026-07-06T12:00 UTC: O=62,420.01, **H=63,516, L=61,250**,
C=63,501.46) has a $2,266 range against a computed ATR(200) of ~$946 (2×ATR ≈ $1,893) — it exceeds
the source's own high-volatility-bar threshold. Per `pine/smart-money-concepts-luxalgo.pine` line
323, `parsedLow = highVolatilityBar ? high : low` — a high-volatility bar has its low swapped for
its high specifically so one oversized wick can't set an order block's boundary. The $61,250 wick
iapaulo was reading (very close to the described $61,210) is real price action sitting right next
to this order block, but the indicator's own anchoring logic explicitly disqualifies it from
being used as the box boundary. Confirmed correct via direct computation (`scripts/signal-bus/smc/calc.js`
lines 88–94, 116–124), not asserted — this is the same defensive rule this project's own
reimplementation already encodes, it just hadn't been checked against a live discretionary read
until now. If the live chart's box genuinely extends to $61,210 despite this rule, that would be
a real discrepancy between this reimplementation and the live indicator worth chasing further —
not ruled out, just not the more likely explanation.

**Confluence-metric gap found while confirming the "stacked zones" observation, 2026-07-28 — a
real, previously-unrecognized limitation of the flagship SMC confluence finding.** Confirmed the
underlying phenomenon iapaulo was describing (multiple 4H order blocks re-forming at the same
price band over time) is real: six distinct bullish 4H internal order blocks formed in the
$61,000–$64,800 band between 2026-07-02 and 2026-07-24 (origins 07-02, 07-05, 07-06, 07-13,
07-17, 07-20 — two still unmitigated as of 2026-07-28), all overlapping in price. But every one
of them shows `confluenceCount = 1` in the data — investigated why rather than assuming a bug in
the observation. Root cause, found in `scripts/signal-bus/smc/confluence.js` line 92:
`ob.confluenceCount = timeframesSeen.size` — confluence count is defined as **distinct
timeframes**, not total overlapping elements. Since all six of these order blocks share the same
timeframe (4H), they contribute nothing to each other's count — a set of six clearly
price-overlapping, sequentially-forming order blocks reads as "isolated" by this metric, every
time. **This means the flagship SMC order-block confluence-vs-hold-rate finding (34.7%→68.0%,
p<0.00001, §10 above) measures cross-timeframe agreement only and is structurally blind to
same-timeframe recurrence — it should be described that way specifically from now on, not as
"confluence" unqualified.** This is exactly the phenomenon iapaulo was calling "nesting" in the
§5 architecture discussion — a distinct, third kind of signal alongside cross-timeframe proximity
confluence (tested, real) and cross-structure geometric containment (sketched in §5, not yet
built): **same-timeframe sequential re-formation**, i.e. how many times has demand/supply
re-established at this price band over a rolling window, regardless of timeframe. Not yet named,
computed, or tested anywhere in this project. Candidate for a fourth bucketing variable alongside
`confluenceCount` and the sketched `nestingDepth`, worth adding to the §5 design before building
`mtf-snapshot.js`/`nesting.js` rather than after.

**Correction to the above, 2026-07-28, same session: the "confluenceCount=1 for all six" example
was a pipeline-staleness artifact, not a clean demonstration of the definitional gap.** Caught
before building on top of it: `build-confluence.js` is a required step separate from
`build-historical.js` ("Run after build-historical.js" — was in its own header comment,
missed during the data refresh above). Every order block in the database — 2018-2024 data
included, not just the new July 2026 rows — was sitting at `confluence_count`'s schema default
(1), because the confluence computation pass was never re-run after the refresh. Re-ran
`build-confluence.js`: 97.7% of order blocks now show real computed confluence (matching the
original finding's own documented ~97% density), and the six stacked order blocks above now show
**`confluenceCount = 6` each** — real, substantial cross-timeframe agreement, not 1. **The
definitional fact itself stands (confluenceCount is `timeframesSeen.size`, verified from source,
still blind to same-timeframe recurrence in principle) — what was wrong was using this specific
example as empirical proof of that blindness in action, since it turns out to also have strong
genuine cross-timeframe confluence.** Flagged here rather than silently editing the earlier
paragraphs, matching this project's standing practice for self-corrections.

**`recurrenceCount` built and tested, 2026-07-28 (iapaulo: "build the recurrence count and test
it against the hold rate") — a real, second bug found and fixed before trusting any result, then
a genuine, strongly significant finding.**

*The bug:* implementing `recurrenceCount` by reusing `confluence.js`'s existing sorted-sweep
(`searchFrom`/`break` bounds keyed off `obRange[0] - maxTol`) produced **asymmetric results** —
order block #225 ($61,067.81–62,147.89) counted #229 ($61,750.90–62,567.99) as a same-timeframe
match, but #229 didn't count #225 back, despite both genuinely overlapping in price, time, and
side (verified by hand). Root cause: the sweep's window assumes a matching element starts near
the target's own start — true for the tolerance-expanded point sources (EQH/EQL, structure —
102,868 of 104,200 pool elements) that dominate `confluenceCount`'s existing, already-tested
computation, but false for a WIDE order block that starts well before another yet still overlaps
it via its own width. This is specific to order-block-vs-order-block matching, so it doesn't
undermine the existing `confluenceCount` finding (dominated by point sources), but it would have
silently corrupted `recurrenceCount`, which is ONLY order-block-vs-order-block. **Fix:** computed
`recurrenceCount` separately (`computeRecurrence` in `confluence.js`), grouping order blocks by
`timeframe|side` and doing a correct pairwise overlap check within each (small) group rather than
reusing the flawed sweep — correctness over performance, since groups top out around 200 order
blocks. Re-verified the same pair is now symmetric (both #225 and #229 show `recurrenceCount=2`).
The six-order-block cluster resolves to three separate overlapping pairs (2,1,1,2,2,2), not one
blob of 6 — two of the six (created 07-05, mitigated before the next one at 07-06, formed) never
actually coexisted in time, correctly excluded.

*The test* (`scripts/signal-bus/smc/recurrence-significance.js`, exact same zone-level permutation
method as `confluence-significance.js` — order-block-level shuffle, not touch-level, since a
block's touches aren't independent observations of it): 1,200 order blocks with touches, 2,603
touches.

| recurrenceCount | order blocks | touches | hold rate |
|---|---|---|---|
| 1 (isolated) | 825 | 1,548 | 49.0% |
| 2 | 271 | 723 | 66.1% |
| 3 | 65 | 191 | 75.4% |
| 4 | 24 | 78 | 80.8% |
| 5 | 14 | 51 | 82.4% |
| 6 | 1 | 12 | 91.7% |

Point-biserial correlation across the full gradient: **r = 0.2109**, against a permuted null
range of [−0.076, 0.076] (50,000 iterations, seed=42) — **p = 0.0000**, real value entirely
outside the null. Top(6)-vs-bottom(1) gap: 42.64 points, p = 0.0336 — significant, but notably
weaker and closer to the 5% line than the correlation, because the top bucket is a **single order
block** (n=1, 12 touches) — don't read the 91.7%/recurrence=6 cell as reliable on its own; the
gradient from 1→5 (49.0%→82.4%, each bucket with real n) is the trustworthy part of this result.

**Label: `descriptive-significant` — a real, second confluence-adjacent gradient, independent of
the cross-timeframe one, not yet cost/capacity tested.** Two honest caveats before this goes any
further: (1) not yet run through the cost/capacity gauntlet — two of the three prior
descriptive-significant SMC/Divergence findings in this register turned out
trade-construction-blocked once actually costed, no reason to assume this one is different; (2)
not yet deconfounded from `confluenceCount` — order blocks with high same-timeframe recurrence
may also tend to have high cross-timeframe confluence (both could reflect "this is simply an
important, heavily-trafficked price level"), and this test doesn't control for that overlap. A
genuinely independent contribution from recurrence specifically, versus recurrence just riding on
the back of confluence, is an open question this test doesn't answer.

**Retroactively checked against the touchCount/survival-time confound that broke §12's
`proximityCount` result below (2026-07-29) — this finding largely survives it.** Once that
confound was found, the same check was owed to every order-block-derived count in this register,
not just the new one. `recurrenceCount` correlates with `touchCount` at r=0.30 (meaningfully
weaker than `proximityCount`'s r=0.53). Stratifying by exact `touchCount` and comparing high- vs.
low-recurrence within each stratum: real, mostly-consistent residual gaps of 4–14 points across 5
of 7 strata (touchCount 1 through 5), only flattening to zero at touchCount=6–7 — the two
smallest strata (n=27, n=18), where a modest real effect could plausibly wash out in the noise
rather than genuinely vanish. This does not fully clear the concern (the true effect size is
probably closer to single digits than the marginal 33.4-point gap implies), but it is a
materially different, more reassuring result than `proximityCount` got under the identical check.

## 11. Cross-indicator confluence (Divergence for Many × SMC) — 2026-07-27

Every confluence test built so far (§9, §10) was WITHIN one indicator, across timeframes. This
asks a different question, prompted directly: does a Divergence-for-Many zone that overlaps SMC
structure — sitting inside a still-active order block, or resting near a still-unswept EQH/EQL
liquidity level — hold more reliably than an isolated zone with no such overlap?

**Method** (`scripts/signal-bus/cross-confluence/cross-confluence-significance.js`, reads both
`divergence-for-many.db` and `smc.db`): for every Divergence-for-Many zone, side-matched against
SMC structure (divergence "bullish"/support ↔ order-block "bullish" ↔ EQL; divergence
"bearish"/resistance ↔ order-block "bearish" ↔ EQH):
- `obConfluence` — at least one SMC order block, same side, still active at the zone's
  `confirmed_time` (created before, not yet mitigated), whose real `[bar_low, bar_high]` range
  *contains* the zone's price. Order blocks have real width, so this is containment, not a
  tolerance band.
- `liqConfluence` — at least one SMC EQH/EQL level, same side, confirmed by the zone's
  `confirmed_time` and still *unswept* at that time, within 0.2% of the zone's price — the same
  flat tolerance `confluence.js` already uses everywhere else, not a new number invented for this
  test.

Both checks scan across ALL SMC timeframes, not just the zone's own — cross-timeframe structure
counts as "in the room" here the same way it already does inside each indicator's own confluence
test. Zone-level permutation, same discipline as `confluence-significance.js`: the label under
test (cross-confluence category, not confluence_count) is shuffled at the zone level; each zone
keeps its own real touch outcomes attached, since a zone's touches are not independent
observations of it.

**Result — no effect detected. Does not survive the test.** 4,141 zones with touches (27,851
touches), cross-referenced:

| category | zones | touches | hold rate |
|---|---|---|---|
| none | 3,496 | 23,597 | 54.0% |
| OB-only | 407 | 2,610 | 53.4% |
| liquidity-only | 215 | 1,483 | 55.1% |
| both | 23 | 161 | 60.9% |

The "both" bucket looks the most interesting at a glance (60.9% vs. 54.0% baseline) — exactly the
kind of number that looked real before testing in three other cases this project has now run
(SuperTrend flip, EQH/EQL sweep, the original 82–88% divergence hold-rate bug). It does not survive
here either: only 23 zones back it. Point-biserial correlation (has any cross-confluence vs.
held/broken, all touches) is r=0.0022 against a permuted null centered at 0.0000 with range
[−0.0314, 0.0250] — the real value sits almost exactly at the null's center, not near either tail.
p=0.3715. The any-vs-none hold-rate gap (0.31 points real) sits inside a permuted range of
[−4.26, +3.40] points, p=0.3705. Both statistics land close to the middle of their null
distributions, at 20,000 iterations (seed=42) — this isn't a borderline miss, it's a genuine null.

**Conclusion: `falsified` (no significant effect detected) — do not use SMC order-block or
EQH/EQL overlap to weight a Divergence-for-Many zone's confidence, in either direction.** Unlike
the EQH/EQL sweep test (§10), where the real rate sat *below* the entire null range (a confident
wrong-direction result), this one sits *inside* the null — the honest reading is "structural
overlap between these two indicators, as defined here, carries no detectable information about
whether a divergence zone holds," not "overlap makes things worse." The small "both" bucket
(n=23) is too thin to read either way and should not be quoted as if it clears the bar the table
next to it makes clear it doesn't.

**What this doesn't rule out** — worth being precise about scope, since a negative result invites
overreach in the other direction: this tested one specific operationalization (order-block
containment, EQH/EQL proximity within 0.2%, both evaluated at the divergence zone's own
`confirmed_time`). It does not test whether SMC structure predicts *anything else* about a
divergence zone (e.g., which direction it eventually breaks, or interaction with SMC's own
already-tested order-block confluence degree rather than raw presence), and it does not test
proximity to *mitigated* order blocks or *swept* liquidity levels, which were deliberately
excluded as "no longer live" structure. Those are different, untested questions, not settled by
this result.

Results saved to `scripts/signal-bus/cross-confluence/results/cross_confluence_significance_*.json`.

**Follow-up, same day: a different cross-indicator question — does BREAKOUT DIRECTION (not hold
rate) correlate with SMC's prevailing bias?** Asked directly as a follow-up to the null result
above: instead of "does SMC structure sitting on a zone predict whether it holds," this asks
"when a divergence zone breaks, does the direction of that break agree with what SMC's own
structure already says the trend is?" (`scripts/signal-bus/cross-confluence/breakout-direction-vs-smc-bias.js`).

**Method:** for every "broken" touch (12,806 total), breakout direction is implied by which side
broke — a bullish/support zone breaking is a bearish-direction break, a bearish/resistance zone
breaking is bullish-direction. "SMC bias" = the side of the most recent BOS/CHoCH structure event
on the *same timeframe*, at or before the touch's own `start_time` (no look-ahead), tested
separately for `scope='swing'` (primary — house convention already treats swing as less noisy
than internal, register row 8) and `scope='internal'` (secondary). Permutation unit is the touch,
not the zone: unlike `confluence_count`, SMC bias is genuinely time-varying, so what's being
tested is whether the true pairing (this touch's real bias reading, this touch's real breakout
direction) carries information beyond a random re-pairing of the two series — the null shuffles
which touch gets which real bias reading, keeping every touch's own real breakout direction fixed.

**Result — real, large, and checked for the obvious way this fools people before trusting it:**

| scope | n (defined bias) | real alignment | permuted null | p |
|---|---|---|---|---|
| swing | 12,795 | **79.79%** | mean 50.71%, range [48.45%, 52.40%] | 0.0000 (20,000 iters) |
| internal | 12,803 | **70.51%** | mean 50.28%, range [48.47%, 52.08%] | 0.0000 (20,000 iters) |

Both real values sit far outside the entire permuted range, not just past a tail — this is the
single largest cross-indicator effect found in this project. A number this dramatic is exactly
the shape of three prior results that turned out to be bugs or didn't survive correction
(SuperTrend's uncorrected p=0.022, the original 82–88% divergence hold-rate claim, and this
session's first cross-confluence test's tempting-looking "both" bucket) — so before trusting it,
checked the most obvious way a stat like this gets inflated: **is the "prior" SMC bias reading
actually prior, or is it coincident with the same breakout bar** (both indicators reacting to the
literal same price move at once, which would be circularity dressed up as prediction)? Bucketing
by the time gap between the referenced bias event and the touch's start (`scope='swing'`):

| gap | n | % of sample | alignment |
|---|---|---|---|
| same-bar (gap=0) | 663 | 5.2% | 95.0% |
| 0–1hr | 830 | 6.5% | 87.4% |
| 1hr–1day | 8,741 | 68.3% | 78.9% |
| 1day–1wk | 1,920 | 15.0% | 75.1% |
| >1wk | 641 | 5.0% | 80.8% |

The bulk of the sample (68%) sits at 1hr–1day lag and still shows ~79% alignment; it holds at
1-week+ lag too (80.8%). This is **not** an artifact of near-simultaneous coincidence — the
elevated same-bar bucket (95%, only 5.2% of the sample) isn't what's carrying the result. The
effect is genuinely present at lags long enough that "SMC's last confirmed structural bias" is
real, standing-before-the-fact information, not a same-instant echo of the divergence break
itself. Side breakdown is symmetric (bullish/support breaks 79.0% aligned, bearish/resistance
breaks 80.4% aligned, swing scope) — no lopsided skew hiding in one direction. Internal scope
alignment being meaningfully lower (70.5% vs. 79.8%) is also a good internal-consistency check —
it matches this project's pre-existing (separately derived) finding that swing structure reads
cleaner than internal structure, rather than contradicting it.

**Label: `descriptive-significant` — the largest, cleanest cross-indicator finding in this
project so far, but not yet decision-grade, for the same reason every other descriptive-significant
finding here has needed a further test before being trusted with size:** this has NOT been
cost/capacity tested. Two of the three prior descriptive-significant findings in this project
(SMC order-block confluence, Divergence-for-Many's own confluence) turned out to be
trade-construction-blocked once actually costed — there is no reason to assume this one clears
that bar just because the raw statistic is unusually strong. It also has a real, honest scope
limit worth stating plainly rather than glossing over: this measures agreement between SMC's
*existing* structural bias and a divergence zone's break direction, which is consistent with
ordinary trend persistence (breakouts tend to go with the grain of the prevailing trend, and SMC's
BOS/CHoCH machinery is itself one particular way of measuring "what has the trend been lately") —
it has not been checked against a naive baseline (e.g., simple recent price-direction momentum
with no SMC machinery at all) to see whether SMC's specific structural read adds anything beyond
that simpler signal. That's a real, useful next question, not yet answered here.

Results saved to `scripts/signal-bus/cross-confluence/results/breakout_direction_vs_smc_bias_*.json`.

**Follow-up, same day: cost/capacity test on the breakout-direction-vs-SMC-bias finding — a real
methodology bug caught along the way, and the underlying result is trade-construction-blocked.**
(`scripts/signal-bus/cross-confluence/breakout-bias-backtest.js`.) The classification above is
agreement between two already-known facts at break time, not a strategy. The natural trade it
implies: when a divergence zone breaks, take a continuation trade in the breakout direction, and
test whether SMC-bias alignment (the exact condition just measured) predicts better real P&L.
Same fixed-R:R convention already established for this indicator (risk = 0.6×ATR at zone
creation, R ∈ {1, 1.5, 2, 3}, race-to-target-or-stop, `scope='swing'` bias only). Entry = next-bar-open
after the breaking touch *ends* (when the break is actually confirmed, not touch start — direction
isn't knowable until the interaction resolves).

**Bug caught before trusting the first run's output: `net_return_pct` read 16,649x at 1R.**
`metrics.js` compounds every trade sequentially into one account (`equity *= 1 + pnlPct`,
documented in its own header comment as a known simplification) — valid for the earlier
lower-frequency, single-timeframe-at-a-time tests, but meaningless here: 10,209+ "aligned" trades
drawn from 8 timeframes genuinely overlap in time (a 5m trade and a 1W trade can easily be open
simultaneously), so modeling them as one account reinvesting 100% into one sequential position is
nonsense, and with a real positive edge across that many trades the compounding math explodes
combinatorially rather than settling near a plausible number the way it did in prior,
closer-to-breakeven tests. **Fix:** dropped `net_return_pct`/`final_equity_multiple` for this
test and used arithmetic-mean per-trade expectancy instead (`win_rate × avg_win − (1−win_rate) ×
avg_loss`, in %) — invariant to trade ordering and overlap, the correct non-compounding way to ask
"does the average trade clear costs." `win_rate`, `avg_win_pct`, `avg_loss_pct`, and
`profit_factor` were never affected by this bug (simple aggregates, not equity-curve-dependent) —
only the compounded return figure was nonsense. **This same distortion likely affects the
magnitude (not necessarily the pass/fail verdict) of every other high-frequency cost/capacity
result reported so far in §9/§10/§11** — worth a standing caveat rather than re-running every
prior test right now.

**Corrected result, 12,795 entries (10,209 aligned / 2,586 not-aligned), confirmed-derivatives
cost tier:**

| R | bucket | n | win rate | PF | expectancy gross | expectancy costed |
|---|---|---|---|---|---|---|
| 1R | aligned | 10,209 | 65.0% | 1.89 | +0.0966%/trade | −0.0441%/trade |
| 1R | not-aligned | 2,586 | 65.9% | 1.99 | +0.0807%/trade | −0.0595%/trade |
| 1.5R | aligned | 10,209 | 55.3% | 1.80 | +0.1136%/trade | −0.0277%/trade |
| 1.5R | not-aligned | 2,586 | 56.2% | 1.85 | +0.0930%/trade | −0.0475%/trade |
| 2R | aligned | 10,209 | 47.2% | 1.70 | +0.1182%/trade | −0.0236%/trade |
| 2R | not-aligned | 2,586 | 46.9% | 1.76 | +0.0988%/trade | −0.0420%/trade |
| 3R | aligned | 10,209 | 36.2% | 1.63 | +0.1273%/trade | −0.0152%/trade |
| 3R | not-aligned | 2,586 | 36.0% | 1.54 | +0.0869%/trade | −0.0543%/trade |

Capacity: aligned 1,385.2 trades/year, not-aligned 350.9 trades/year (7.37-year span).

**Two honest findings, not one:**
1. **The underlying breakout-continuation trade has a real gross edge regardless of alignment**
   (PF 1.5–2.0 in every row) **but never clears real costs at any R multiple tested** — best case
   is −0.0152%/trade (3R, aligned), still negative. Costs (~0.135% round-trip + funding) are the
   same order of magnitude as the raw per-trade edge (0.08–0.13%), and at 1,385 trades/year that
   gap compounds into a real, if now-correctly-measured (not astronomically-mis-measured), loss.
2. **The alignment classification's practical translation is far more modest than its 79.8%-vs-50%
   headline suggests.** Aligned beats not-aligned by only 1.6–4.0 basis points of expectancy per
   trade at every R multiple — both buckets are gross-positive with similar profit factors, and
   both are blocked by costs. The classification is real and large as a *directional agreement*
   statistic (§11 above), but it does not translate into "aligned breakouts are tradeable and
   non-aligned ones aren't" — both look similar once turned into an actual trade, and neither
   clears the bar.

**Label: `trade-construction-blocked`.** Consistent with every other descriptive-significant
finding tested for cost/capacity in this project (SMC order-block confluence, Divergence-for-Many's
own confluence) — the underlying classification survives rigorous testing, the leap to a
standalone trade does not.

Results saved to `scripts/signal-bus/cross-confluence/results/breakout_bias_backtest_*.json`.

## 12. Order-block proximity / "near-miss" detection (SMC) — 2026-07-28

Formalized directly from a live discretionary chart exchange: iapaulo counted 7 real touches on
the stacked $61k–63k order-block structure (§10/§11) plus "1 time where price found clean support
with no touch" — verified by hand first (a 3-bar pullback on 2026-07-04, bottoming $126/0.20%
above OB225's top before reversing cleanly, never entering the box), then formalized into a
permanent capability rather than left as a one-off script, per the direct request ("we may need a
proximity sensor... formalize this please and build it in").

**`scripts/signal-bus/smc/proximity.js`** — `detectProximityEvents`/`computeAllProximityEvents`,
mirroring `touches.js`'s exact structure (maximal run of consecutive qualifying bars, per order
block, bounded by its active window) but for the opposite condition: bars that approach an active
order block's boundary from outside within a tolerance, *without* ever touching it (mutually
exclusive with a real touch at the bar level — a bar is one or the other, never both). No
held/broken outcome, since a near-miss by construction never enters the box; the useful facts
recorded are closest approach (`closestApproachPct`), duration, and approach direction.

**Tolerance — checked before shipping it, not after: confluence.js's existing 0.2% constant
would have been wrong for this.** The motivating event bottomed at 0.20% away (runner-up bars at
0.31–0.33%) — a 0.2% hard cutoff would have excluded the very case this was built to catch. That
constant answers a different question (do two separate structures count as "the same" price
level for identity-matching); near-miss detection is "how close counts as almost touching one
specific existing box," reasonably a looser bar. Set `PROXIMITY_TOLERANCE_PCT = 0.5%` instead —
a new starting assumption, not a validated constant (same disclosed status as every other
tolerance constant in this project), chosen to clear the motivating example with real margin.

**Verified against the motivating example before trusting the formalized version:** re-ran the
full pipeline (`build-historical.js` → `build-confluence.js`, both required after any schema
change — the same two-step dependency that caused the pipeline-staleness bug earlier this
session, this time run in the right order) and queried OB225 directly. The detector reproduces
the exact 2026-07-04T00:00→12:00 event (closest approach 0.203%, matching the hand-verified
number) — plus 6 more legitimate near-misses on the same order block (07-05, 07-06, 07-08, 07-09,
07-14, 07-17) that hadn't been individually checked before, all in the 0.2–0.5% range. New DB
table `order_block_proximity_events` (schema in `store.js`), wired into `build-historical.js`
alongside touches — every future rebuild computes both automatically. Totals across the full
8-timeframe ladder: 3,708 near-miss events (2 on W up to 960 on 5m), roughly comparable in
volume to the 2,404 real touches across the same ladder.

**Significance test, 2026-07-29 — looked dramatic, turned out confounded. Written up as a full
diagnosis, not just the number that survived.** (`scripts/signal-bus/smc/proximity-significance.js`,
exact same order-block-level permutation method as `confluence-significance.js`/
`recurrence-significance.js`.)

*The naive marginal test:* `proximityCount` (total near-miss events per order block) vs. hold
rate, 1,200 order blocks / 2,603 touches. Hold rate rises from **26.7% (zero near-misses) to
80.4% (11+ near-misses)** — the largest raw gradient found anywhere in this project. Correlation
r = 0.3055 against a permuted null of [−0.090, 0.076] (50,000 iterations) — p = 0.0000. Top-vs-bottom
gap 58.98 points, p = 0.0000. Both statistics look as clean as anything in this register.

*Checked before trusting it, and it doesn't hold up.* A gradient this large, on a brand-new
metric, from a project that has already caught three dramatic-looking-but-wrong results this
month (the original 82–88% divergence hold-rate bug, EQH/EQL's sweep-reversal, the
`net_return_pct` compounding artifact) warrants suspicion before belief, not after. Checked the
most obvious mechanical confound: **order-block survival time.** `touchCount` alone (completely
ignoring proximity) shows an even starker gradient — 9.0% hold rate at touchCount=1 up to 91.7%
at touchCount=11+ — because a block can only be mitigated ("broken") *once*, and per LuxAlgo's
own source it's removed from tracking the instant that happens. A block that survives to be
touched 11 times has, by construction, at most one "broken" touch among those 11 — the rest are
mechanically "held." This isn't a real predictive signal about the future, it's closer to
tautology: "this block has lasted a while" and "most of its recorded touches were held" are
nearly the same fact stated twice. `proximityCount` correlates with `touchCount` at r = 0.53 —
plausible on its face (both scale with how long a block stays active) and enough to suspect
proximityCount's marginal result is riding on this, not contributing independently.

*Controlled for it directly:* stratified order blocks by exact `touchCount`, split each stratum
by `proximityCount` above/below its own median, compared average hold rate within each stratum
(holding survival time fixed, isolating proximity's remaining contribution, if any):

| touchCount | n | low-proximity hold rate | high-proximity hold rate | gap |
|---|---|---|---|---|
| 2 | 332 | 50.5% | 57.1% | 6.6pts |
| 3 | 155 | 67.4% | 70.6% | 3.2pts |
| 4 | 76 | 78.8% | 79.1% | 0.3pts |
| 5 | 47 | 80.8% | 83.6% | 2.8pts |
| 6 | 27 | 83.3% | 83.3% | 0pts |
| 7 | 18 | 85.7% | 85.7% | 0pts |

The 58.98-point marginal gap collapses to single digits — and inconsistent, non-monotonic single
digits at that — the moment survival time is held constant. Whatever's left (0–6.6 points,
depending on stratum) is small enough to plausibly be noise in these sample sizes, not a
methodically re-verified independent effect.

**Conclusion: the naive proximityCount-vs-hold-rate correlation does NOT survive controlling for
the obvious confound — do not present this as a real, independent signal.** This is a different
kind of catch than the bugs found earlier in this section (those were code defects; this is a
textbook confounded-variable trap: `proximityCount` and hold rate are both driven by a third
factor, order-block survival duration, and the marginal correlation mistook that shared cause for
a direct relationship). The underlying question §12 raised — does being "respected from a
distance" carry information beyond mere survival — remains genuinely open; this specific test of
it does not answer yes.

## 13. Cost/capacity test on recurrenceCount — the first finding in this project to clear the bar

Mirrors `confluence-backtest.js`/`confluence-backtest-fixed-rr.js` exactly (same trade
construction, same confirmed Coinbase derivatives cost model), bucketed by `recurrence_count`
instead of `confluence_count`. Given every prior cost/capacity test in this project ended
`trade-construction-blocked` or worse, a positive result here demands *more* scrutiny before
trusting it, not less — treated accordingly below.

**Naive construction** (`recurrence-backtest.js`, same entry/exit rule as §10's original
confluence test): near-breakeven at the high-recurrence bucket — gross expectancy +0.148%/trade
(PF 1.47, 30.7 trades/year), costed expectancy **−0.0057%/trade**, essentially flat, not
meaningfully different from zero. Same story as every other finding so far: a real gross
gradient that doesn't clearly survive costs under this construction.

**Fixed R:R follow-up** (`recurrence-backtest-fixed-rr.js`, same stop as before — the order
block's own far boundary — target = entry ± R-multiple × risk, R ∈ {1, 1.5, 2, 3}): the
high-recurrence bucket clears real costs at **every** R multiple tested, and improves
monotonically with R:

| R | n | win rate | PF | costed expectancy |
|---|---|---|---|---|
| 1R | 332 | 76.8% | 3.20 | +0.7055%/trade |
| 1.5R | 331 | 71.6% | 3.74 | +1.1140%/trade |
| 2R | 331 | 68.3% | 3.38 | +1.2496%/trade |
| 3R | 322 | 60.9% | 3.47 | +1.6104%/trade |

Capacity: ~54 trades/year at 1R (332 trades over the 6.15-year span) — a realistic, executable
frequency, not one of the thousands-per-year buckets that got crushed by cost drag elsewhere in
this project.

**Checked before trusting it — this is the first positive result in the whole project, which is
exactly the situation that calls for the most scrutiny, not the least:**
1. *Not a directional/regime artifact.* Split the 1R construction by side: bullish (long) wins
   68.5% (n=213), bearish (short) wins **84.0%** (n=119) — if this were just "riding a bull
   market" or one secular trend, the counter-trend side should underperform, not outperform. It
   doesn't.
2. *Not concentrated in one cluster or timeframe.* 104 distinct order blocks across 7 of the 8
   timeframes (15m through 1D — 1W too thin to appear), not a handful of lucky boxes.
3. *Formal permutation significance test*, not just descriptive diagnostics
   (`recurrence-fixed-rr-significance.js`, same order-block-level shuffle as every other
   significance test in this project, applied to the 1R win/loss outcome directly rather than
   `touches.js`'s held/broken): 1,193 order blocks, 2,589 resolved 1R trades. Point-biserial
   r = 0.2860 against a permuted null of [−0.109, 0.114] (50,000 iterations) — **p = 0.0000**.
   Top(6)-vs-bottom(1) win-rate gap: 67.10 points — **p = 0.0000**. Both statistics land entirely
   outside their null ranges.

**Two honest scope limits, not swept under the rug just because the result is finally positive:**
(1) the formal permutation test covers the **1R construction only** — 1.5R/2R/3R are corroborating
descriptive evidence (consistent direction, monotonically increasing magnitude, which is itself
harder to produce by chance than a single lucky value) but have not each been independently
permutation-tested; (2) this is one finding surviving out of roughly a dozen tested across this
entire project (SuperTrend, SMC confluence ×2 constructions, Divergence-for-Many confluence ×2,
breakout-bias, EQH/EQL, cross-indicator confluence, proximityCount all failed) — real cause for
some optimism, not proof the broader system works. Single-asset (BTC), backtest-only (no live
execution), idealized next-bar-open fills throughout.

**Label: the first finding in this project to survive significance testing AND the full
cost/capacity gauntlet.** Worth being precise about what that does and doesn't mean: it clears
every bar this project has set so far, on this specific construction (fixed R:R off an order
block's own far boundary, gated by recurrence_count ≥ 3). It has not been forward-tested, has not
been checked against a second asset, and has not yet been folded into `decision-policy.md` or the
live skill — that's a real decision worth making deliberately, not a default next step to take
silently.

**Update, 2026-07-29: formalized significance for 1.5R/2R/3R (previously flagged as untested
extrapolation) — result is real but split, not a clean "all four confirmed."**
(`recurrence-fixed-rr-significance.js`, extended to loop over R multiples, same order-block-level
permutation as the 1R test above, run independently per R since a wider target changes which bar
each trade resolves on — not one test reused across R values.)

| R | n trades | correlation r | correlation p | top(6)-vs-bottom(1) gap | gap p |
|---|---|---|---|---|---|
| 1R | 2,589 | 0.2860 | 0.0000 | 67.1pts | 0.0000 |
| 1.5R | 2,583 | 0.3123 | 0.0000 | 66.9pts | 0.0004 |
| 2R | 2,578 | 0.3337 | 0.0000 | 47.7pts | **0.1173 (NOT significant)** |
| 3R | 2,551 | 0.3368 | 0.0000 | 3.6pts | **0.2545 (NOT significant)** |

**Don't round this up or down — the two statistics tell different parts of the story.** The
point-biserial correlation (uses the full gradient across all 6 recurrence buckets, the larger,
more stable sample) is significant at p=0.0000 for every R multiple, and if anything *strengthens*
as R increases (0.286→0.337). The top-vs-bottom gap (compares only the extremes) loses
significance at 2R and 3R — but that's not evidence the effect reverses at higher R; it's the same
**single order block (n=12 trades, recurrence=6)** that was already flagged as too thin to trust
on its own in the original hold-rate test, now showing through again at every R multiple, since
it's literally the same one block's trades re-evaluated at a wider target each time. A thin
bucket doesn't get more trustworthy just because a different R was chosen.

**Practical read: 1R and 1.5R have the cleanest, most complete evidentiary support — both
statistics clear 5%.** 2R and 3R have real correlational support (arguably the more informative
statistic here, and the strongest of the four) but the specific top-bucket comparison is
inconclusive at those targets, for a known, disclosed reason rather than an unexplained gap.
`decision-policy.md`'s Tested Setup Alert defaults to 1R for exactly this reason — narrowest
scope limitation, cleanest support on both measures — and that default stands; 1.5R is now
similarly well-supported if a different target is wanted, 2R/3R carry the extra caveat above.

**Live wiring, 2026-07-29 — recurrence_count computed by `signal-grid.js`, built with two
deliberate, disclosed differences from the offline metric, not a straight port. VERIFIED against
a real chart 2026-07-30 — see below.** Closes the "no live computation exists yet" gap
`decision-policy.md`'s Tested Setup Alert flagged as a standing blocker — `extractOrderBlockRecurrence()`
now runs every sweep, reading `data_get_pine_boxes({ study_filter: "Smart Money", verbose: true })`.

- **Side is inferred from price position, not decoded from the box's color.** The exact ABGR
  byte-order decode was confirmed once (§3, 2026-07-25) but the decode function itself was never
  saved as reusable code — rather than re-guess the byte order (risking a silent, confident-looking,
  possibly *inverted* side call feeding straight into a live trade alert), used the same fallback
  this project already relies on for BOS/CHoCH direction when tag text alone is ambiguous (§3): an
  unmitigated order block price has moved away from is, by construction, on the correct side
  (mitigation deletes the box the instant price fully clears it). A box price is currently inside
  can't be classified this way — scored `side: "unknown"`, excluded from recurrence counting
  rather than guessed.
- **Only counts currently-visible boxes.** Pine's own source only ever displays the most recent
  ~5 boxes per scope even though it tracks up to 100 internally (§2) — the offline backtest's
  `recurrence_count` was computed against that full tracked history. A live reading of
  "recurrence=3" is a **lower bound** on what the offline metric would show, not a guaranteed
  match — narrower, not equivalent.

`printTable()` surfaces a `⚑ Tested Setup Alert candidate` line whenever a box's live recurrence
reaches the decision-policy.md gate (≥3) — explicitly labeled a manual-review watchlist note, not
a trigger.

**Correction, 2026-07-30: this session's repeated claim that no live TradingView connection
existed was wrong — checked directly (`curl localhost:9222/json/version`) and the CDP port
TradingView Desktop exposes was reachable the entire time.** That claim rested on `ToolSearch`
not finding `mcp__tradingview__*` tools registered in this background session, which is true —
but `signal-grid.js` and the rest of `src/core/` never went through those MCP tools at all; they
talk to CDP directly. Absence of the MCP tool layer and unreachability of the underlying chart
are different facts, and they got conflated across multiple turns until directly questioned
("have you lost the chart or what") prompted an actual check rather than a repeated assumption.

**Verified against the live chart, 2026-07-30 — ran `signal-grid.js` for real
(`COINBASE:BIPZ2030`, price $64,305 at the 4H read) and hand-checked the output, not just
trusted it:**

| Box | Side | Live recurrence |
|---|---|---|
| $65,045–65,745 | bearish | 1 |
| $62,455–63,695 | bullish | 2 |
| $61,750–62,275 | bullish | **3** ⚑ |
| $61,240–63,000 | bullish | **4** ⚑ |
| $61,110–62,180 | bullish | **3** ⚑ |

Manually recomputed every pairwise price-overlap by hand rather than trusting the function's own
arithmetic: $61,750–62,275 overlaps two other bullish boxes → 1+2=3 ✓; $61,240–63,000 overlaps
all three others → 1+3=4 ✓; $61,110–62,180 overlaps two → 1+2=3 ✓. **Every recurrence count
matches exact hand-calculation.** Side inference also checks out directionally: the one bearish
box sits above current price (supply), all four bullish boxes sit below it (demand) — the correct
SMC convention, and the same $61k–63k zone independently corroborated by the offline analysis
earlier this session. Three boxes correctly cleared the ≥3 gate and were flagged, none below it
were.

**What remains genuinely unverified: the side-inference METHOD itself, not the arithmetic on top
of it.** This confirms the recurrence-counting logic is correct given a side label; it does not
independently confirm "price above the box" reliably means the same thing as the box's true
color/nature across every possible chart state (price currently inside a box, a box that formed
under unusual conditions, etc.) — only that it produced internally-consistent, directionally
sane results on this one real read. One verified pass not exhaustive testing.

## 14. Anchor-candle-color significance test (SMC order blocks) — 2026-07-30

Motivated directly by the specific 4H order block identified earlier (§13's neighborhood: bullish
order block anchored to a red candle, origin 2026-07-06T08:00, box $62,421.85–63,177.93,
mitigated 2026-07-08). Every order block's anchor bar is whichever bar had the most extreme
parsed-low/high in its pivot-to-break window (`calc.js`) — the anchor's color is incidental to
that algorithm, never chosen for it, so whether it carries real information is a genuinely open,
testable question rather than an assumption either way.

**Method** (`scripts/signal-bus/smc/anchor-color-significance.js`): for every order block, checked
whether its anchor candle closed red or green, then tested per side (bullish/bearish, all 8
timeframes pooled), per an "matches classic ICT convention" derived variable (bullish+red or
bearish+green — textbook ICT expects a bullish order block's anchor to be the last down candle
before the move), per individual timeframe (bullish only), and stratified by `recurrence_count`
("nested conditions"). Same order-block-level permutation discipline as every other test here.

**Result: a clean, comprehensive null, in every stratification tested.**

| Test | Red/label=1 hold | Green/label=0 hold | Gap | Null range |
|---|---|---|---|---|
| Bullish (pooled) | 54.1% | 59.7% | −5.67pts | [−9.83, +12.40] |
| Bearish (pooled) | 56.2% | 60.4% | −4.13pts | [−12.38, +12.98] |
| Matches ICT convention | 57.0% | 58.2% | −1.21pts | [−7.50, +7.64] |
| 2H bullish (largest single-TF gap) | 48.3% | 67.3% | −19.00pts | [−25.05, +24.73] |

Every real gap — pooled, per-side, per-timeframe (7 of 8 tested, 1W too thin), and per-recurrence
bucket — sits comfortably inside its own permuted null range, including the most extreme-looking
single-timeframe result (2H's −19pt gap, still well inside [−25, +25]). None approach
significance in either direction.

**Conclusion: anchor candle color carries no detectable information about hold rate.** The
specific 4H order block that prompted this is a real, correctly-identified data point (verified
bar-for-bar, §13's neighborhood) — but its red anchor isn't evidence of anything special. It's
incidental, exactly as the anchoring algorithm predicts (most extreme bar in the window, chosen
without regard to color). If anything the pattern trends opposite classic ICT lore (green anchors
holding marginally better), but that trend itself doesn't clear the null either.

Results saved to `scripts/signal-bus/smc/results/anchor_color_significance_*.json`.

## 15. Touch-refresh expiry test (Divergence for Many) — 2026-07-30

Prompted directly by iapaulo: "sustained interaction with a line should produce a sustained line,
however do not want to pollute my screen with ancient irrelevant lines." Checked against the
actual Pine source first — `pine/divergence-for-many-relevance-gated.pine`'s real expiry rule
(`expire_old_glows`/`draw_promoted_glow`) pins a promoted zone's clock to its **promotion bar
only**: `array.push(bars, bar_index)` at draw time, checked later as `bar_index - bars[idx] >
200`, with no refresh mechanism — a zone that keeps getting touched still expires exactly 200
bars after it was first promoted, no differently than one nobody ever looks at again. Confirmed
our `calc.js` reimplementation matches this exactly (uses `confirmedBarIdx` the same way) — no
existing deficiency in the current rule's *fidelity to the source*. The proposal is a genuinely
new design, not a bug fix.

**Also confirmed while investigating: the real indicator has no variable "intensity" at all.**
All three glow layers (outer/middle/core) render at fixed widths/opacity regardless of confluence
or divergence count (lines 66–68 of the source, plain input values) — "intensity scaling with
confluence" is a real, well-motivated proposal, but it isn't something we're failing to
reimplement; the source itself doesn't have it. It's independently justified by an already-tested
finding (§9: confluence-vs-hold-rate, 53.4%→60.6%, p<0.001) — a real basis for the idea, just not
yet built (would require modifying the actual Pine script, not a backdata question).

**Touch-refresh tested against real data**
(`scripts/signal-bus/divergence-for-many/touch-refresh-analysis.js`) — a from-scratch re-scan,
not a re-query: `touches.js`'s existing detection stops at each zone's original fixed
`expiresBarIdx`, so touches past that point were never even recorded. Rule tested: a zone's
"alive until" bar resets to (touch end + 200) every time it's touched, instead of being fixed at
confirmation + 200; it only truly expires after 200 bars pass with no touch at all.

| | n | hold rate |
|---|---|---|
| Core touches (within the original fixed window) | 34,927 | 53.9% |
| Extended touches (only reachable via refresh, past the original window) | 21,409 | 50.6% |

**Extended touches behave close to core touches, not degraded.** A 3.3-point gap on a sample this
large is worth a real significance check before leaning on it, but even taken at face value it's
nowhere near "these are stale, meaningless interactions" — sustained interaction appears to carry
real signal, not noise, largely consistent with the proposal's premise.

**Capacity/clutter concern directly addressed, not just asserted: only 2 of 5,519 zones (0.04%)
are currently "expired" under the fixed rule but would still read as touch-refresh-active right
now.** Most zones that ever get an "extended" touch still eventually go 200 bars without one and
lapse naturally — touch-refresh extends a zone exactly as much as sustained interaction actually
warrants, it does not create a growing backlog of old lines. This is a real, concrete answer to
the stated worry, not a hand-wave: adopting this rule would not flood the screen with ancient
zones.

**Status: empirically supported, not yet built.** This analysis validates the *backdata
behavior* of the proposed rule — it does not itself change what's drawn on the live chart.
Implementing it for real would mean forking `divergence-for-many-relevance-gated.pine`'s expiry
logic (a Pine script change), a separate, deliberate step from this analysis.

## 16. Touch-refresh + intensity-scaling Pine fork — built, debugged, live-verified — 2026-07-30

Followed through on §15: `pine/divergence-for-many-touch-refresh-intensity.pine`, a surgical fork
of the original (diffed byte-for-byte to confirm every divergence-detection line above the
promoted-glow-level machinery is untouched). Two changes, both gated by their own input, default
true: (1) touch-refresh expiry — a new `refresh_touched_glows()` resets a level's stored
`bar_index` to now if price is touching it, before `expire_old_glows` runs; (2) confluence-scaled
intensity — `draw_promoted_glow` computes a `tier` from `divcount - badgeglow_min_reg_divs`
(capped at `badgeglow_max_intensity_tier`) and widens/brightens the three glow layers accordingly;
tier 0 (at the minimum threshold) renders identically to the original's fixed widths.

**A real, pre-existing bug was found and fixed in the process, not introduced by the fork.** The
original's `expire_old_glows` computes its delete index as `idx = array.size(levels) - 1 - i`
*inside* a `for i = 0 to array.size(levels) - 1` loop whose bound is fixed at the ORIGINAL size —
when 2+ levels expire on the same bar, the first deletion shrinks the array but `i` keeps
incrementing against the old bound, driving `idx` negative on a later iteration. Confirmed live on
the actual chart: `RE10045 — array.get() Index -1 is out of bounds, array size is 1`, bar 2113.
This crash halts the script's historical replay at that bar, which is why the fork initially
showed **zero** promoted glow lines on the live chart despite compiling cleanly — not a fork
regression, a latent bug in the unmodified original that this fork's live-testing happened to
surface first (it requires the rare condition of two simultaneous same-bar expirations, which the
original script apparently hadn't hit yet on this specific instance/timeframe history). Fixed by
iterating the index directly (`for i = array.size(levels) - 1 to 0`, using `i` itself, not a
recomputed value) so a deletion never invalidates a not-yet-visited index.

**Debugging trail, disclosed because it was expensive and the failure modes are worth knowing
about for next time:**
- The Pine Editor's automated `pine.set()`/`pine.compile()` path proved unreliable at this session's
  scale of back-and-forth: a save operation silently created a **duplicate script** ("... copy")
  rather than updating the original in at least one instance, and separate edits landed in an
  editor buffer that wasn't the one visually active on the chart. Ground truth that actually worked:
  screenshotting the real Pine Editor tab, and hovering the chart's error-exclamation icon directly
  for the exact `RE10045` runtime-error tooltip (compile-time checks — both the editor's own marker
  API and TradingView's public `translate_light` endpoint — do NOT surface runtime errors like this
  one; confirmed the endpoint doesn't even catch an undefined-variable reference, so it's not a
  reliable signal for anything beyond gross syntax).
  - A live temp-debug `label.new()` added under `if barstate.islast` without deleting the prior
    instance caused a SECOND, self-inflicted runtime error (blew past `max_labels_count=400` since
    `barstate.islast` stays true across every tick of the forming bar, not just once) — fixed by
    creating the label once via `var` and updating it in place with `label.set_xy`/`label.set_text`.
    Standard pattern worth remembering for any future live Pine debug scaffolding.
  - Separately found and fixed a real UI bug unrelated to the Pine fork itself: the price pane had
    silently become "maximized" (`chart.model().model().panes()[0].maximized() === true`), forcing
    VMC Cipher B and Boom Hunter Pro's panes to height 0 — invisible, but still fully computing.
    Fixed with a double-click on the price pane (TradingView's own maximize/restore toggle
    gesture); no reliable JS setter was found for this, the UI gesture was the only working path.

**Live-verified after the fix:** confirmed zero runtime errors across all 8 signal-bus timeframes
(1m/5m/15m/1h/2h/4h/1d/1w), and confirmed glow lines are genuinely being drawn (not just "no
crash") via direct `line.new()` object reads on 2h (3 bearish levels) and 5m (bull+bear mixed).
The originally-reported "missing lines" pattern (badges without corresponding glow lines) was
separately confirmed to be the relevance-gating design working as intended, not a bug: a badge
fires on any 3+ total divergences (mixed regular/hidden across families), while promotion to a
glow line requires 3+ REGULAR divergences specifically, deduplicated by ATR-tolerance against
existing levels, and capped at `badgeglow_max_levels` (default 3) concurrently visible per side —
most historical badges will correctly never have a currently-visible line for one of these three
reasons, which is the anti-clutter design §15 was proposed to complement, not a defect in it.

## 17. Per-indicator signal bus (VMC Cipher B Divergences) — 2026-07-31

Third indicator brought into the signal-bus pipeline (after Divergence-for-Many, §9, and SMC,
§10) — motivated directly by iapaulo naming the gap: "we have a whole battery of indicators and no
clear path to evaluate their individual and cumulative value." `pine/vmc-cipher-b-divergences.pine`
read in full first; settings verified against the **live chart's actual configuration** (a direct
properties probe on the running indicator, entity `Ilt4Lv`), not the Pine author's documented
defaults — `wtShowHiddenDiv` is live-set to `true`, a real deviation from the author's own default
of `false`, meaning hidden divergences are genuinely active on the chart, not just regular ones.

**Scope, deliberately narrow for this first pass:** only the flagship WT-wave-2 regular + hidden
divergence signal (`f_wavetrend` + `f_findDivs`, faithfully ported in
`scripts/signal-bus/vmc-cipher-b/calc.js`) — the signal the indicator is literally named after. Not
yet built: RSI/Stoch divergence (both confirmed OFF live), `buySignal`/`sellSignal` (WT cross at
OB/OS, no divergence requirement), `wtGoldBuy`, Sommi flag/diamond (both confirmed OFF live).
`touches.js`/`confluence.js` are ported verbatim from Divergence-for-Many (same single-price-line
zone shape, kept as a per-indicator copy per this project's existing convention rather than a
shared import — see SMC's genuinely-different range-based `touches.js` for why that convention
exists). One structural difference from every existing zone type in this project: **Cipher B zones
never expire** (no analogous mechanism in the source) — touches accumulate across the zone's
entire remaining history, which mattered directly for the significance-testing methodology below.

**Full 8-timeframe historical build:** 38,704 zones, 5.06M touches (`data/signal-bus/vmc-cipher-b.db`).

**Standalone significance test result: essentially null, both cuts.**

| test | statistic | result | p-value |
|---|---|---|---|
| regular vs. hidden divergence | hold-rate gap (touch-weighted) | 0.65 pts | 0.0000 |
| regular vs. hidden divergence | hold-rate gap (zone-level, unweighted) | 0.90 pts | — |
| cross-timeframe confluence | point-biserial r | 0.0077 | 0.0000 |
| cross-timeframe confluence | isolated vs. 3-way gap | 1.98 pts | 0.0000 |

Every p-value clears 5% — but the effect sizes are all within ~1-2 points of a 50% coin flip,
nowhere near the ~7-point gap that made #4/#27 worth pursuing. At 5M touches, statistical power is
high enough that even an economically meaningless real difference reads as p<0.0001; **checked
this isn't a single-dominant-zone artifact first** (top 100 zones by touch count are only 1.3% of
all touches — ruled out) before concluding the effect is real-but-trivial rather than a bug.
**Read this as a genuine negative result**, not a failed build: Cipher B's raw WT
divergence — "does price hold at this level" — carries essentially no standalone edge with the
live chart's current settings, regular or hidden, confluent or isolated.

**Cross-indicator confluence test (2026-07-31), kept apples-to-apples with §11's already-falsified
SMC test:** same base indicator (Divergence-for-Many zones), same permutation methodology, testing
Cipher-B-confluence instead of SMC-confluence
(`scripts/signal-bus/cross-confluence/divergence-vs-cipherb-confluence.js`). Result: **falsified**,
r=0.0034 (p=0.2712), gap 0.74pts (p=0.2812) — neither statistic distinguishable from a randomly
relabeled null. **One methodological caveat worth flagging explicitly, not burying**: because
Cipher B zones never expire, 4,932 of 5,189 Divergence-for-Many zones (95.0%) show *some* Cipher B
confluence — the "none" bucket (n=257) may partly just be catching very early-history zones before
enough Cipher B zones had accumulated nearby, a time-in-history confound rather than a pure
confluence measurement. The near-universal "yes" rate on its own is a sign this particular
confluence definition has limited discriminating power for Cipher B specifically (unlike SMC's
mitigation-bounded order blocks, which meaningfully turn on and off over time) — a cleaner test
would need a bounded "still-relevant" window for Cipher B zones, not just "ever existed before."

## 18. Cipher B divergence — testing the causal mechanism directly, not just level-hold rate — 2026-07-31

§17's standalone/confluence tests both used the level-hold framing borrowed from Divergence-for-Many
and SMC ("does price defend this exact price when later revisited"). iapaulo pushed back hard and
correctly: that's not what a momentum divergence claims. The causal story is *momentum exhaustion
precedes price reversal* — a forward-looking prediction about what price does in the bars right
after the signal, not a support/resistance claim about years later. Four follow-up tests, in order,
each motivated by the last:

**18.1 — Naive forward return** (`forward-return-significance.js`): for each divergence event,
signed return over N∈{5,10,20,40} bars from the confirmation bar, vs. a same-timeframe randomly-
sampled-bar-and-side baseline (controls for the mostly-uptrending regime, not a naive 50%). Result:
**regular divergence shows a real, short-horizon edge** — 53.9% correct-direction at 5 bars
(z=3.10, p=0.0019), decaying to non-significant by 10-20 bars. **Hidden divergence shows nothing**
at any horizon. This directly refutes the §17 "no value" framing — the level-hold test was
structurally blind to a real, if modest and short-lived, effect.

**18.2 — Elite-trading-theory gates** (`gated-divergence-significance.js`): professional divergence
use never trades the raw print — it requires (a) LOCATION at independent structure (active
same-side SMC order block, regular divergence only — a reversal claim should matter most where the
market already marked significance), (b) TREND CONTEXT (hidden divergence only — a continuation
claim needs an established trend to continue; gated via price vs. a 50-bar SMA), (c) CONFIRMATION
(don't enter on the raw print; require price to break the pivot-formation window's own high/low
within 5 bars, or discard — no confirmation, no trade), (d) OSCILLATOR AGREEMENT (a same-side
Divergence-for-Many zone within a TIGHTENED same-day window, not the "ever in 9 years" check §17
correctly flagged as meaningless).

**Caught and fixed a real methodological error before trusting the result, disclosed rather than
quietly corrected**: the first version measured forward return starting at the confirmation bar
while *also* using "does it confirm within 5 bars" as the filter for N=5 — the filter window and
the measurement window were the same 5 bars, producing a near-tautological 81% "edge" that
evaporated on inspection (rebuilding it with entry fixed at the divergence's own confirmation bar,
filtering only on eventual confirmation, produces the same look-alike inflation for exactly the
reason the overlap predicts). Corrected design: entry AT the confirmation-detection bar itself, a
completely fresh non-overlapping forward window from there.

**Real result, and it's the opposite of what the theory predicts: waiting for confirmation makes
regular divergence WORSE, not better.** 46.3% correct-direction at 5 bars (z=-4.45, p=0.0000) vs.
the raw signal's 53.9% — confirmation-chasing enters after a real chunk of the confirming move has
already happened, buying the tail of that thrust right where it's likeliest to pause or give back.
Stacking SMC location and oscillator agreement claws back toward neutral (49-53%) but never beats
the raw signal at any horizon. Hidden divergence stays null-to-negative at every gate level,
including fully stacked (n=1157).

**18.3 — Two better-motivated confirmation designs, requested directly** (`confirmation-variants-
significance.js`), same non-overlapping-window discipline: (A) oscillator recross — a cheaper,
earlier confirmation than a full price breakout (WT1/WT2 crossing in the implied direction, the
indicator's own built-in buy/sell-dot mechanism); (B) pullback-after-breakout — enter on a 30%
retracement into the confirmed breakout instead of chasing the breakout bar itself, discarding if
price invalidates before retracing. **Neither improved on the raw signal.** Both landed close to
raw at short horizons (53-55%, not significantly different) and oscillator-recross turned
significantly *worse* than raw by 40 bars (z=-4.00, p=0.0001). Across four entry-timing designs now
tested (raw / price-break chase / oscillator recross / pullback retest), **the plain raw print,
entered immediately with no waiting at all, remains the only one with a clean edge** — modest, and
only at 5 bars.

**18.4 — Timeframe stratification** (`timeframe-stratified-significance.js`): tests the one
remaining untested piece of the theory, "higher timeframe divergence is more reliable." **Result
contradicts the theory.** 1w is too data-thin to test (n=4); 1d/4h/2h show nothing significant;
3h has one isolated 5-bar hit (p=0.007) that doesn't survive to 10 bars; 1h's one significant cell
is in the *wrong* direction (48.7% correct, p=0.035). **5-minute is the only timeframe with a
consistent, multi-horizon-replicating result** — significant at 5, 10, AND 20 bars (54.1-55.4%
correct, p<0.01 each) on the largest sample (n=9,766) — and the pooled 53.9% headline from §18.1
turns out to be mostly this one timeframe's data (65% of the pooled sample) carrying the average.
**Multiple-comparisons caveat, stated plainly**: 8 timeframes × 2 kinds × 4 horizons = 64 tests at
α=0.05; pure chance predicts ~3 false positives, close to what the scattered non-5m hits look like.
The 5m result is the one worth trusting specifically because it replicates across three consecutive
horizons on the largest sample, not because of where it sits in the timeframe ladder.

**Where this leaves Cipher B, honestly:** the only signal that has survived every test run today is
**regular WT divergence on 5-minute BTC, entered immediately on the raw print with no confirmation
gate, held for roughly 5-20 bars** — modest (53.9-55.4% correct-direction, not a dramatic edge),
real (consistent across three consecutive horizons, largest available sample, survives a fair
skeptical audit including a self-caught look-ahead bug), and the opposite of what "wait for
confirmation" and "trust higher timeframes more" would have predicted going in. Not yet cost/
capacity tested per iapaulo's explicit direction (2026-07-31: "no point running cost analysis until
you have established elite trader level understanding of divergence") — do not treat as tradeable
without that step.

Results saved to `scripts/signal-bus/divergence-for-many/results/touch_refresh_analysis_*.json`.

## 19. Cipher B buySignal/sellSignal ("green dot"/"red dot") — Phase 1 of the video-driven plan — 2026-07-31

iapaulo supplied "Intro to Market Cipher: Everything You Need to Know" (crypto_face,
youtu.be/bxkm4Kjubqs) — the authoritative walkthrough for the commercial indicator
`pine/vmc-cipher-b-divergences.pine` clones. It revealed that §17/§18's divergence work tested a
secondary signal: the video's actual centerpiece is `buySignal`/`sellSignal` (WT1/WT2 cross at
oversold/overbought, no divergence requirement), called explicitly more reliable than divergence.
Full 5-phase plan approved and saved; this is Phase 1.

`computeWtCrossSignals()` added to `calc.js` — same-bar sign-change on `wt1-wt2`, gated by
`wt2 <= -53` (buy) / `wt2 >= 53` (sell), both live-confirmed thresholds (`obLevel`/`osLevel`,
`in_10`/`in_13`, no deviation from Pine defaults this time). Sanity-checked first (967 events on
4h/19,587 candles, ~1 per 20 bars, no bad prices, side split 434/533) before any test ran against
it. Same forward-return methodology as §18.1, run BOTH pooled and stratified in one script
(`buysell-forward-return-significance.js`) since §18.4 already showed pooling can hide a
timeframe-concentrated effect.

**Result: a stronger, more robust version of §18.4's finding.** 5-minute buySignal/sellSignal is
significant at **all four** horizons tested (5/10/20/40 bars) — 54.1-55.3% correct-direction
throughout, n=45,192 — versus divergence's 3-of-4. The pooled view (n=67,733) shows nothing at
N=5/10/20 and only a weak, likely-noise negative hit at N=40 — the 5m effect is real but gets
washed out by 1d/2h/1h, which show scattered null-to-negative results (1d: -2.37% mean, wrong
direction, at N=20; 2h/1h: significant but wrong-direction at several cells) that partially cancel
it in the aggregate. 4h/3h show nothing; 1w is too thin (n=23) to test.

**This is the strongest, most-replicated finding of the whole Cipher B investigation so far** —
four consecutive significant, same-direction cells on the largest available sample is far beyond
what the 32-cell (8 timeframes × 4 horizons) multiple-comparisons noise floor (~1.6 expected false
positives at α=0.05) would produce by chance. Proceeding to Phase 2 (MFI regime gate) per the
approved plan, same discipline: one variable, one comparison against this raw baseline, report
plainly whether it helps or not.

## 20. MFI regime gate on buySignal/sellSignal — Phase 2 — 2026-07-31

`computeMfi()` added to `calc.js`, faithfully matching Cipher B's own `f_rsimfi` (which, confirmed
by reading both sources side by side, subtracts `rsiMFIPosY` (2.5) — Cipher A's otherwise
identically-named function does NOT; a real, disclosed difference relevant to Phase 4). All three
live settings (period 60, multiplier 150, posY 2.5) match Pine defaults exactly, no deviation to
account for. Video's rule: green/positive MFI → only trust longs; red/negative → only trust
shorts. Tested as the simplest, most literal reading — same-bar, same-timeframe MFI sign at the
signal bar — against Phase 1's raw baseline, both "aligned" (following the rule) and "against"
(the opposite reading), pooled and stratified.

**Result on 5-minute — the one timeframe with a real, replicated signal — is the opposite of the
video's rule.** MFI-aligned events (n=11,107) are WEAKER than raw at every horizon (51.9-53.3%
correct vs. raw's 54.1-55.3%, not significant at 5 or 40 bars), while MFI-against events
(n=34,085, the majority) are slightly STRONGER than raw at every horizon and significant
throughout. A sanity check caught a related, non-obvious base-rate fact before this result could be
misread: on 4h, `buySignal` (an oversold cross-up) co-occurs with `mfi<=0` far more often (334 vs.
99) than `mfi>0`, and `sellSignal` the mirror image — the opposite skew from the video's simple
heuristic, because same-bar MFI captures RECENT momentum, which is often already negative right
before an oversold bounce triggers (and positive right before an overbought top triggers).

**This does not necessarily falsify the video's actual claim — it falsifies this literal
operationalization of it.** The video repeatedly frames MFI as a slower-moving, HIGHER-TIMEFRAME
regime ("start with the larger time frames to identify environment") checked before trading a
signal on a LOWER timeframe — not a same-bar, same-timeframe co-reading. That cross-timeframe
version is a materially different, more charitable test of the actual claim and is a natural
extension of Phase 3 (which already tests cross-timeframe agreement, just for dot-stacking rather
than a regime filter) — flagged for a follow-up pass, not built in this phase. As tested here, the
verdict stands: **do not gate Cipher B `buySignal`/`sellSignal` by same-bar MFI sign** — it doesn't
help on the timeframe that matters, and the majority "against" bucket already carries the raw
signal's edge on its own.

## 21. Multi-timeframe stacking — Phase 3 — the strongest result in this whole investigation — 2026-07-31

Tests the video's other central claim directly: does a 5-minute `buySignal`/`sellSignal` (Phase
1's one real, replicated base signal) confirmed by a SAME-SIDE dot on a HIGHER timeframe outperform
one without? Different question from §18.4's per-timeframe stratification (which asked "which
single timeframe alone is best") — this asks whether cross-timeframe agreement adds value on top
of the best timeframe already found. Window scales with each higher timeframe's own bar duration
(3 bars — a 3-hour lookback on 1h, a 3-day lookback on 1d, a 3-week lookback on 1w) rather than a
flat window, avoiding the "ever in 9 years" mistake already caught once today. Implemented as a
two-pointer sweep (both event lists chronologically sorted) for efficiency at 45k+ base events, and
verified look-ahead-safe by construction (a higher-TF event only counts if its own confirmation
time is at or before the base event's).

**Result: a clean, monotonic dose-response, significant at every one of 4 horizons for every
confirm-count bucket above zero.**

| confirm-count | n | correct-dir (5/10/20/40 bars) | significant? |
|---|---|---|---|
| 0 (no higher-TF agreement) | 29,890 | 53.2–54.4% | **no, at any horizon** |
| 1 | 11,351 | 54.4–56.1% | yes, all 4 |
| 2 | 3,056 | 56.9–58.8% | yes, all 4 |
| 3+ | 895 | 60.2–68.0% | yes, all 4, by far the strongest |

**This is the first result in the entire Cipher B investigation (divergence or buySignal) where a
professional-practice refinement confirms the theory instead of contradicting or being neutral to
it** — confirmation-chasing on divergence (§18.2) reversed the edge; same-bar MFI (§20) weakened
it; multi-timeframe stacking amplifies it cleanly, and the unconfirmed majority (66% of all base
events) carries essentially no edge on its own — the entire signal lives in the confirmed 34%,
scaling with how many timeframes agree, exactly as the video describes ("start with the larger
time frames... the more time frames that agree, the stronger the signal"). 68.0% correct-direction
at confirm-count=3+, N=20 is the single strongest number produced anywhere in this project's
Cipher B work, though n=895 there is the thinnest of the four buckets and shouldn't be read as more
precise than it is. Proceeding to Phase 4 (Cipher A yellow-X veto) per the approved plan.

## 22. Cipher A yellow-X veto — Phase 4 — 2026-07-31

`scripts/signal-bus/vmc-cipher-a/calc.js` built from scratch, porting `yellowCross` from
`pine/vmc-cipher-a-ribbon.pine` — a fully separate script from Cipher B with its own independent
WT/RSI/MFI calculation, confirmed by reading both sources side by side (not assumed): Cipher A uses
`wtAverageLen=13` and `osLevel3=-80` where Cipher B uses `12`/`-75`, and Cipher A's `f_rsimfi` does
NOT subtract `rsiMFIPosY` the way Cipher B's does. Live settings probed against entity `hVarCL`
("VuManChu Cipher A") — all 26 inputs match the Pine author's documented defaults exactly, no
deviation this time (unlike Cipher B's `wtShowHiddenDiv`). `yellowCross` is rare by construction
(782 events across all of 5m history vs. 45,192 buySignal/sellSignal events, ~1 per 1,201 bars) —
sanity-checked (non-zero, sparse, spans the full history) before testing against it.

Tested the video's specific claim — "if you see a yellow X on the same candle as a green dot, the
yellow X takes precedent... stay out or short" — as a veto on 5-minute `buySignal`/`sellSignal`
(Phase 1's real signal), at three pre-registered windows (exact same bar, ±3 bars, ±10 bars).

**CORRECTED 2026-07-31, after a bug caught while building Phase 6 (see §26): the original window
check (`Math.abs(yellowCrossBarIdx - signalBarIdx) <= window`) let a yellowCross occurring AFTER
the buySignal/sellSignal count as "flagging" it — look-ahead, since a warning that fires later
isn't information available at signal time. Fixed to only count a yellowCross AT OR BEFORE the
signal bar. The corrected result REVERSES the original "veto" conclusion below — replacing it here
rather than leaving a stale, wrong finding in place.**

**Corrected result: a PRIOR yellowCross does not veto a subsequent buySignal/sellSignal — if
anything it strengthens it.** Window=0 (n=23, exact same bar) is too thin to test. Window=±3 bars
(n=743) shows a real positive effect at N=20 (57.6% correct-direction vs. clean's 55.2%, z=2.06,
p=0.0392). Window=±10 bars (n=935) shows it more clearly: 58.3% vs. 54.9% at N=10 (z=3.14,
p=0.0017) and 57.9% vs. 55.2% at N=20 (z=3.09, p=0.0020), both real positive gaps. **This makes
sense on reflection, not just as a correction for its own sake**: yellowCross is documented as a
"manipulation/trap" warning that precedes further adverse movement ("about 80% of the time it's a
trap... a pump then a dump"); a buySignal/sellSignal firing shortly AFTER that warning is
plausibly confirming the trap has already played out (the anticipated move already happened),
not warning of a fresh one about to start.

**Verdict, corrected: do not treat yellowCross as a veto in either the same-candle or widened
forms.** As a PRIOR warning (~10-50 bars back), it's weak evidence FOR the subsequent signal, not
against it. The "clustering ruled out" check (627 of 782 events isolated, spread across 107
months) still stands and applies equally to this corrected reading. Testing discipline unchanged:
3 windows × 4 horizons, results concentrated at the two shorter/wider-window cells, disclosed as
such rather than treated as uniformly clean.

## 23. "Blue Wave" — Phase 5 (final) — formalized, tested, CORRECTED after a thorough reread, still null — 2026-07-31

The video's own top-billed technique ("I have made more money off of these blue waves than any
other indicator basically ever"). First version of `computeBlueWave()` tracked swings in `wtVwap`
(`wt1-wt2`, the separate white "VWAP" area) — **wrong, caught on a full reread requested by
iapaulo**. At 20:04 the video explicitly names the oscillator behind Blue Wave: "the blue and
light blue area... -100 to 100... thresholds at 60 and -60." Checked against the actual Pine plot
colors, not assumed: WT1 is literally blue (`#4994ec`), WT2 dark purple/navy (`#1f1559`, easily
read as "light blue" against WT1 on screen), and 60/-60 matches `obLevel2`/`osLevel2` exactly —
"Blue Wave" is about WT1 itself, not a third derived series. Also missed the first time: "a nice
healthy blue wave... that dips below or above this blue line marker" means the REFERENCE wave must
clear the 60/-60 threshold to count as a valid starting point, not just any two consecutive
same-direction waves.

**Corrected version**: a "wave" is the segment between two consecutive wt1/wt2 crosses (the same
crossing event used for `buySignal`/`sellSignal`); magnitude = largest `|wt1|` reached during that
segment; only a wave that cleared ±60 becomes a valid reference for "was the next one smaller."
Entry fires on the cross ending a wave that is smaller than a threshold-clearing reference wave.
Sanity-checked (3,054 events on 4h, balanced 1536/1518 split, no bad prices) before retesting.

**Result: still uniformly null — actually cleaner than before.** Pooled (n=234,331) sits at
49.3-49.4% correct-direction across all four horizons; one marginal hit at N=5 (p=0.011). Stratified
across 8 timeframes × 4 horizons, a handful of cells barely clear 5% (1d/3h at N=5 only, pooled at
N=5 only) — all at the shortest horizon, none replicating to N=10+, consistent with the ~1.8
false-positives-by-chance the 36-cell multiple-comparisons floor predicts. No timeframe shows
anything resembling Phase 1 or Phase 3's multi-horizon consistency.

**Two independently well-motivated formalizations (the original wtVwap-based one and this
corrected WT1-based one) now both land on the same null result**, which meaningfully raises
confidence this is a genuine property of the pattern rather than one wrong guess — though it still
cannot fully rule out a third, untested reading of the video's visual description. Read as: the
underlying "shrinking momentum wave" concept, mechanically formalized two different reasonable
ways, shows no forward-return edge on this instrument; the video's "most money I've ever made"
claim most plausibly reflects the hindsight/cherry-picked-example bias common to discretionary
trading narratives, though that inference is not proven by this result alone.

## 24. Video-driven plan complete — all 5 phases — summary — 2026-07-31

Approved plan (`C:\Users\apaul\.claude\plans\claude-continue-splendid-dewdrop.md`) fully executed.
Net picture, phase by phase:

| Phase | Signal | Result |
|---|---|---|
| 1 | `buySignal`/`sellSignal`, raw | **Real** — 5m, all 4 horizons significant (§19) |
| 2 | MFI regime gate (same-bar) | **Falsified as stated** — reverses the video's rule (§20) |
| 3 | Multi-timeframe stacking | **Strongest finding in the project** — clean dose-response (§21) |
| 4 | Cipher A yellow-X veto | **Partially real** — not same-candle, but a real ~10-bar warning (§22) |
| 5 | "Blue Wave" | **Null** — uniformly, across every timeframe and horizon (§23) |

The house model that survives this pass, stated plainly: **Cipher B `buySignal`/`sellSignal` on
5-minute BTC, confirmed by a same-side signal on one or more higher timeframes within a
TF-scaled lookback window, is the one component with a clean, replicated, dose-responsive edge** —
strongest at 3+ confirming timeframes (60.2-68.0% correct-direction). The Cipher A yellow-X veto
adds a real, if narrower, risk flag on top of that (a ~10-bar elevated-risk window, not an instant
veto). MFI regime filtering and Blue Wave, as tested here, do not add value — MFI actively hurts
when read literally, Blue Wave shows nothing at all. None of this has been cost/capacity tested,
per iapaulo's explicit sequencing direction (2026-07-31) to complete the understanding-building
pass first — Phase 3's multi-timeframe-stacked signal is the clear leading candidate for that step
whenever it's requested.

## 25. Full-transcript reread audit — 2026-07-31

Requested directly by iapaulo after the 5-phase summary: "reread the video and check your work
thoroughly." Full transcript reread line by line against the actual Pine sources (both
`vmc-cipher-a-ribbon.pine` and `vmc-cipher-b-divergences.pine`), not just skimmed for
confirmation. One real error found and fixed (§23's Blue Wave series correction, above). Two
further findings, disclosed rather than silently absorbed:

**Two distinct "green dot" signals exist, and the video is explicit that they're used
differently.** Cipher A ALSO has its own green-circle signal (`longEma = crossover(ema2, ema8)`,
shown directly on the price chart, discussed 6:31-9:57 before Cipher B is even introduced) — a
completely different mechanism from Cipher B's `buySignal` (WT cross at oversold, discussed from
12:19 onward, what Phase 1-3 actually tested). At 9:41 the video states its own preference
explicitly: **"I prefer Cipher B green dots for entries, I use the green dots on Cipher A as more
of a confirmation."** Phase 1's target (Cipher B `buySignal`) was correctly identified — that part
of the build was right. But **Cipher A's own green dot as a same-timeframe confirmation signal on
top of Cipher B's entry was never built or tested** — a real, distinct gap from Phase 3's
cross-timeframe stacking (which confirms across TIMEFRAMES within Cipher B alone) and from Phase
4's yellow-X veto (which only checks a negative/warning condition, not this positive
confirmation). Flagged, not built — a natural Phase 6 if wanted.

**The video's "5th oscillator" doesn't map onto a real plot in this specific clone.** At 31:41 the
video describes a "custom v-web algorithm... displayed as the YELLOW area... doesn't interact with
other oscillators... a leading indicator for reversals." No yellow-colored plot exists anywhere in
`vmc-cipher-b-divergences.pine` matching that description — the only yellow-colored plot in the
entire source is the Sommi flag's higher-timeframe VWAP line (`sommiShowVwap`), which is off by
default and confirmed off on the live chart, and doesn't match "doesn't interact with other
oscillators" (it's explicitly a Sommi-flag component). **Working conclusion, stated as inference
not certainty: this open-source clone likely doesn't implement every feature of the original paid
"Market Cipher" product the video describes** — worth remembering before assuming every technique
in the video has a buildable, testable equivalent in this codebase. Everything actually tested in
Phases 1-5 (buySignal/sellSignal, MFI, multi-TF stacking, yellowCross, Blue Wave/WT1) was verified
against real, checkable plot statements in the source before being built, not assumed from the
video's narration alone — this limitation applies specifically to the untested "5th oscillator,"
not to anything already built.

## 26. Phase 6 — Cipher A green-dot confirmation — a look-ahead bug caught, a real structural finding — 2026-07-31

Built `computeGreenDot()` (the `longEma`/`shortEma` EMA(11)/EMA(34) crossover, §25's identified
gap) and tested it as a same-timeframe confirmation on 5-minute `buySignal`/`sellSignal`.

**Caught a serious bug before trusting the result.** First run produced 84-89% correct-direction
with z-scores in the 30s-40s — far beyond anything real elsewhere in this project (the best prior
result was §21's 68%). Diagnosed immediately: the window check
(`Math.abs(greenDotBarIdx - signalBarIdx) <= window`) let a Cipher A dot occurring AFTER the
Cipher B signal count as "confirming" it — look-ahead, since a dot forming later is itself
evidence the anticipated move already happened. **The exact same flaw was present in §22's
yellow-X veto test**, built earlier with the identical symmetric-window pattern — its smaller
effect size (yellowCross is far rarer, 782 vs 32,543 events) made it look plausible enough not to
trigger suspicion at the time, but the bug was there regardless of how modest the result looked.
Both fixed to only count a PAST occurrence; §22 rewritten in place with the corrected (and
reversed) result rather than left stale.

**Corrected green-dot-as-recent-event result: thin and, if anything, weak.** A green dot within
±10 bars of a signal (n=622) shows a WEAKER, significantly worse outcome at N=40 (46.8% vs. 54.2%,
z=-3.46, p=0.0005) than an unconfirmed signal. Recent-crossover-event framing doesn't help.

**Built a second version — regime alignment (is ema2 currently above/below ema8 right now, not
"did it just cross") — since a rare crossover EVENT is a poor proxy for an ongoing STATE, the same
lesson §20's MFI test already taught.** This surfaced something structurally real, verified
directly rather than assumed: `buySignal` co-occurs with a BEARISH Cipher A regime 98.5% of the
time (21,861 of 22,196 events), and `sellSignal` with a BULLISH regime 98.7% of the time (22,694
of 22,996) — confirmed by direct count, not inferred from the thin "aligned" bucket alone. This
makes mechanical sense: Cipher B's WT-cross-at-oversold/overbought is designed to catch reversals
EARLY, before a slower EMA(11)/EMA(34) trend-follower has caught up and flipped. Requiring
same-side agreement (n=637, the rare case) doesn't help either — 50.9-53.4% correct-direction,
weaker than the dominant "against" bucket's 54.1-55.3%.

**Verdict: neither operationalization of Cipher A's own green dot adds value as same-timeframe
confirmation for Cipher B's entries.** Unlike §21's cross-TIMEFRAME stacking (which strengthens
the signal cleanly), cross-INDICATOR agreement with a structurally slower, lagging tool selects
for a rare, weaker subset rather than a stronger one — Cipher B's fast-reversal design and Cipher
A's trend-following design are frequently, by construction, on opposite sides at the exact moment
Cipher B fires.

## 27. Phase 7 — WT2 extremity dose-response — an inverted-U, not a straight line, and a direct reversal of the video's own claim — 2026-07-31

iapaulo's request: "learn the significance of green dots occuring above 80 and below -80." Tested
whether a `buySignal`/`sellSignal` firing at a more extreme `wt2` reading (beyond the ±53 OB/OS
gate that defines the signal at all) predicts a stronger forward move — the same dose-response
framing that worked cleanly for §21's confirm-count buckets. `wt2` magnitude read directly from the
already-computed series at the signal's own bar (`computeWaveTrend`, exported, no new calc.js code
needed) — same-bar, look-ahead-safe by construction, same as §20's same-bar MFI attribute.

**Not monotonic — an inverted U, peaking well below the video's claimed threshold, then reversing
hard past it:**

| wt2 magnitude | n | correct-dir (N=5/10/20/40) |
|---|---|---|
| 53-60 | 12,941 | 52.8 / 53.7 / 53.5 / 52.4% (mostly not significant) |
| 60-70 | 15,857 | 54.8 / 55.5 / 55.8 / 54.3% (significant at 3 of 4 horizons) |
| **70-80** | **10,225** | **55.8 / 56.6 / 57.5 / 56.2% (significant at ALL 4 horizons — the peak)** |
| 80-90 | 4,473 | 54.3 / 54.3 / 55.8 / 54.4% (weakening, mostly not significant) |
| 90-100 | 1,313 | 50.0 / 52.7 / 50.6 / 52.6% (null) |
| **100+** | **383** | **47.8 / 51.2 / 47.0 / 44.1% (significantly NEGATIVE at all 4 horizons, z=-2.9 to -4.3)** |

The effect builds cleanly from the OB/OS gate up to a peak at 70-80, then decays and **reverses
sign** past ~90-100 — the 100+ bucket isn't just weaker, it's a significant edge in the OPPOSITE
direction from the signal's own side at every horizon tested. Checked the tail wasn't just thin
noise before trusting this: n=383 at 100+ is workable (>30 threshold), and the pattern is
monotonic across three consecutive buckets (80-90 → 90-100 → 100+, all degrading in the same
direction), not a lone outlier cell. Max observed extremity is 127.7; the reversal is not an
artifact of a hard ceiling in the WT2 calculation.

Multiple-comparisons context: 6 buckets × 4 horizons = 24 cells, ~1.2 false positives expected by
chance at α=0.05. 11 cells are significant, clustered coherently in exactly the two places the
inverted-U predicts (the 60-80 rise, the 100+ reversal) — far beyond chance and structurally
coherent, not scattered.

**This directly reverses the video's specific claim.** "Above 80/below -80" is not a stronger
signal — the 80-90 band is already past peak, and the 100+ band is a significantly worse entry than
the raw §19 baseline, worse than doing nothing extreme at all. A plausible mechanical read (not
independently tested, offered as a hypothesis): `wt2` this extreme means price has already moved
unusually far before the cross even completes, so the signal is calling exhaustion into an
already-overextended move rather than catching a fresh reversal — the opposite of what makes 70-80
work. **Practical implication for any future trade-construction pass: prefer 60-80 as the
"stronger" bucket, and treat 90+ readings as a caution flag, not a stronger buy/sell — the reverse
of the video's own framing.**

## 28. Phase 8 — multi-indicator confluence in the extreme ranges — one near-tautology caught, one genuine compounding effect found — 2026-07-31

iapaulo's third and final ask from the same request: "the significance of multi indicator
confluence of signals occuring in these ranges." Two attempts.

**Part 1 (caught before trusting it, abandoned as degenerate): Cipher A's own wt2 also reading
extreme, same side, same bar as Cipher B's.** The obvious first idea — check whether a second
indicator's oscillator agrees. Before running any significance test, checked the correlation
between Cipher A's wt2 and Cipher B's wt2 directly: **r=0.9993 across all 939,150 5m bars.** The two
series are near-identical (both are the same WaveTrend formula on the same price data; the only
real difference is `wtAverageLen` 12 vs 13) — "confluence" here is close to reading the same number
off two clocks, not independent confirmation. The naive significance test does show a dramatic
split (confluent 54.3-55.5% vs. non-confluent 51.0-52.5%), but the non-confluent bucket is only
7.2% of events (n=3,269) and vanishes to zero entirely above wt2=70 — a direct consequence of the
near-1.0 correlation, not evidence of a real effect. **Do not use Cipher A's own WT2 as a
confluence check for Cipher B signals** — it isn't a second opinion, it's the same opinion measured
twice.

**Part 2 (the real test): Cipher B's own regular WT divergence — a structurally distinct, fractal-
pivot-based detector (`computeVmcCipherB`, unrelated in method to the OB/OS-threshold crossing
behind buySignal/sellSignal, though both ultimately read wt2) — occurring same-side within the
prior 10 bars.** Past-only window, same look-ahead-safe convention as §22/§26's corrected checks.

Overall: divergence-confluent signals (n=3,137, 6.9% of the total) beat non-confluent at every
horizon except the last: 57.0% vs. 54.0% at N=5 (z=3.78, p=0.0002), 58.6% vs. 54.7% at N=10
(z=4.67, p<0.0001), 57.0% vs. 55.2% at N=20 (z=4.57, p<0.0001), non-significant by N=40.

**This compounds specifically inside §27's peak zone.** Within the 70-80 wt2 bucket (§27's best
single-indicator result, 55.8-57.5% correct-direction), adding divergence confluence (n=711) pushes
it further: 58.5% at N=5, **61.7% at N=10** (z=3.98, p=0.0001), 61.5% at N=20, 60.5% at N=40 — every
horizon significant, the strongest sustained result in the entire Phase 6-8 extension. The 53-70
band shows a similar but weaker and less consistent lift (fades by N=20/40). The 80-100 band shows
a promising but thinner lift (n=366, significant only at N=10/20). **The 100+ reversal bucket
cannot be tested for a rescue effect — only 15 of 383 events there have a recent divergence, too
thin to read either way; this is a disclosed gap, not a null result.**

Multiple-comparisons context: this table is dense (roughly 40 cells across the overall test and the
4-bucket interaction), ~2 false positives expected by chance at α=0.05 — the actual significant-cell
count is far higher and, critically, concentrated coherently in the theoretically motivated cells
(the 70-80 peak bucket clears all 4 horizons), not scattered.

**Verdict: genuine multi-indicator (or, more precisely, multi-DETECTOR) confluence is real and
compounds the strongest existing Cipher B finding — but only when the second signal is actually
independent.** Two indicators computing the same formula on the same inputs (Part 1) is not
confluence; two structurally different detection methods reading the same underlying series (Part
2, an OB/OS-threshold cross plus a fractal-pivot divergence) is. The combination of §27's 70-80
wt2-extremity sweet spot with a recent same-side regular divergence (this section) is now the
single strongest, most specific entry description produced across Phases 6-8 — not yet
cost/capacity tested, per the same standing direction that applies to every finding in this
extension.

## 29. Cost/capacity test on every surviving Cipher B finding — none clear real costs, and precisely why — 2026-07-31

iapaulo's direction after Phases 6-8 landed: cost/capacity test the survivors. Built
`scripts/signal-bus/vmc-cipher-b/cost-capacity-backtest.js`, reusing the one trade construction
that has ever cleared real costs anywhere in this project (#27b's fixed R:R) rather than starting
from naive construction again (which has failed every other finding tested: #2/#2a, #4a, #25a):
entry = next-bar-open after the signal; risk = 0.6× ATR(14) at the signal bar (same convention as
`breakout-bias-backtest.js`, not a new number); stop = entry ∓ risk; target = entry ± R×risk;
race-to-target-or-stop, R ∈ {1, 1.5, 2, 3}, same-bar ambiguity scored as the stop. Costs reused
directly from #22's confirmed Coinbase Advanced 1 figures (0.070% taker, both sides + hourly
funding) — not re-derived. All 45,192 events resolved within the 200-bar backstop at every R (zero
inconclusive), and every stratification from Phases 3/7/8 was tested in the same run: baseline,
multi-TF confirm-count (§21), wt2-extremity bucket (§27), divergence confluence (§28), the combined
wt2-70-80-plus-divergence construction (§28's leading candidate), and the corrected yellow-X prior
warning (§22).

**Every single bucket, at every R multiple, stays negative after costs — nothing here clears real
costs, unlike #27b.** Best case found (wt2-70-80 + divergence confluence, 3R): gross expectancy
+0.0545%/trade, PF 1.40 — genuinely the best gross number in the whole sweep — but costed
expectancy is still **-0.0858%/trade**. Every other bucket is worse. The 3+-confirmation bucket
(§21's strongest single-variable finding) tops out at -0.0606%/trade costed even at 3R. The 100+
wt2-reversal bucket (already known negative pre-cost, §27) is catastrophic once costed
(-0.2651%/trade at 3R) — consistent, not surprising.

**Diagnosed why, precisely, rather than just reporting the negative number:** on 5-minute BTC, mean
`0.6× ATR(14)` risk is only **0.168% of price** (median 0.132%). The fee-only round-trip cost alone
(2 × 0.070% = 0.140%) is **~83% of the average stop distance itself** — before funding is even
added. This is a structurally different regime from #27b's 4H order-block test, where the
underlying price swings are large enough relative to the same fixed percentage fee for a real edge
to survive. No R-multiple scaling fixes this: raising R doesn't shrink the cost-to-risk ratio, it
just changes how much of an already-thin edge gets diluted by the same fixed drag. **This is a
capacity/instrument-frequency mismatch specific to trading a fast, high-frequency oscillator signal
(~1 buySignal/sellSignal per 21 bars on 5m, 5,052/year) at real transaction costs, not evidence the
underlying statistical edges from §19-§28 are fake** — the forward-return significance tests remain
real, look-ahead-checked findings; they simply describe an edge too small, relative to a 5-minute
bar's typical range, for this cost structure to trade profitably as constructed.

**What would need to change for a future attempt, not built here:** (a) a coarser base timeframe
where typical bar range is larger relative to the fixed fee — the significance tests already found
5m to be the ONLY Cipher B timeframe with a real effect (§18.4), so this isn't a free substitution,
it would need re-establishing significance on a different timeframe first; (b) a materially lower
fee tier or maker-only execution (this test assumes worst-case taker fees on both sides, per
`costs.js`'s conservative-by-design convention); (c) a wider stop (larger ATR multiple) to dilute
the fixed cost's share of the risk — but that changes the trade's character away from what was
significance-tested and would need its own fresh test, not an assumption it still works. **Net
position: understanding-building (§19-§28) is complete and the findings are real; none of them, in
this construction, are currently tradeable at real cost.**

## 30. Cost-testing divergence as its own standalone entry — same real-but-cost-blocked profile, plus a flagged asymmetry — 2026-08-01

iapaulo pushed back on §29's framing (fair pushback): "not really understanding why you are unable
to find or see the significance of divergence." Worth being precise about this, since §29's
"trade-construction-blocked" verdict was about every bucket in that test, and every bucket in that
test entered off `buySignal`/`sellSignal` — divergence only ever appeared there as a CONFIRMING
FILTER on top of that entry (§28/#45), never as its own standalone trade. That's a real gap, not
just a clarity problem: this section closes it.

**To be direct about what the record already showed, restated plainly:** divergence has repeatedly
cleared statistical significance in this project — #33 (53.9% correct-direction at 5 bars,
p=0.0019), #35 (54.1-55.4% correct across three horizons on 5-minute specifically, the one
timeframe it replicates on), and #45 (58.5-61.7% correct-direction when combined with Cipher B's
own extreme-zone signal). None of that was ever in question. §29's negative verdict is a claim
about whether the AVERAGE DOLLAR SIZE of that edge, at 5-minute BTC's typical bar range, is larger
than a fixed 0.14% round-trip fee — a materially different question from "is the direction call
real," and one where the answer can legitimately be "yes to the first, no to the second."

**Built `divergence-cost-capacity-backtest.js`: entry directly off a Cipher B regular WT divergence
zone's own confirmation bar (not off buySignal), same fixed R:R construction as §29 (0.6× ATR(14)
risk, R ∈ {1, 1.5, 2, 3}, real costs from #22).** Result: the same profile as everything else in
this cost-testing pass. Gross expectancy is genuinely positive and PF > 1 at every R multiple
tested (e.g. 3R: PF 1.10, gross +0.0125%/trade, pooled n=9,766) — confirming the underlying
direction-call edge is real, exactly as §33/§35 already established. But costed expectancy is
negative at every R multiple regardless (3R pooled: -0.1279%/trade) — the same mechanical
cost/ATR-ratio problem as §29, not a different failure mode.

**One genuinely interesting, honestly-flagged asymmetry surfaced along the way, not smoothed over:**
splitting divergence events by whether a buySignal/sellSignal also fires within ±10 bars (either
order — a purely descriptive split here, not a look-ahead-safety claim) shows divergence events
WITHOUT a nearby buy/sell signal performing BETTER (54.0% win at 1R, n=1,421, the minority — 14.5%
of all divergence events) than divergence events WITH one (47.4% win, n=8,345, the majority). This
looks like it points the opposite direction from §28/#45, where divergence-near-buySignal made
buySignal's own outcomes BETTER. These are not a formal contradiction — they're two different
anchor populations (most divergence events sit near a buySignal by base-rate co-occurrence, but
most buySignals do NOT have a preceding divergence, so the "confluent" subset is a small, possibly
unrepresentative slice from either anchor's point of view) — but it's a real, unresolved asymmetry,
not independently significance-tested here, flagged rather than quietly dropped. **Even the best
sub-bucket in this new test (isolated divergence, no nearby buy/sell signal, 3R: gross
+0.0292%/trade, PF 1.29) stays solidly negative after costs (-0.1112%/trade)** — the asymmetry is
interesting as a future research lead, not a rescue for the cost problem.

**Net position, stated as plainly as possible: divergence is real. It is not tradeable on 5-minute
BTC at real transaction costs, in a fixed-R:R ATR-based construction, no matter which specific
entry variant (raw buySignal, raw divergence, or their confluence) is used — because the fixed
per-trade fee is large relative to how much a 5-minute bar typically moves, not because the
direction-prediction itself is weak or fake.** ARCHITECTURE.md §29's "what would need to change"
list (a coarser timeframe re-tested for significance, a lower fee tier, or a deliberately wider
stop) applies identically here.

## 31. Coarser timeframes for divergence, done right — a real significance catch, then a second finding to ever clear real costs — 2026-08-01

iapaulo's direct request: "let's test a coarser timeframe for divergence significance." §18.4/#35
already tested this per-timeframe and found nothing above 5-minute — rerun fresh
(`timeframe-stratified-significance.js`, unchanged: 1d/4h/2h/15m null, 3h/1h single non-replicating
hits, only 5m replicates across horizons). But that test is individually underpowered on coarser
timeframes: over 8.95 years, regular divergence fires only 224 times on 4h and 44 on 1d, vs. 9,766
on 5m — nowhere near enough to detect an effect the size seen on 5m (4-5 points) with the standard
mean-based z-test used throughout this project. Absence of significance there isn't strong evidence
of absence.

**Built `coarser-tf-pooled-significance.js`: pooled 15m/1h/2h/3h/4h/1d (excludes 5m, already
established; excludes 1w, only 4 events) into one combined, well-powered sample (n=5,182) and
tested it the same way.** First pass (mean-based z-test, the project's standard) came back mixed
and NOT trustworthy on its face: significant positive at N=5, null at N=10/20, significant NEGATIVE
at N=40. **Checked before reporting it, per this project's standing discipline** — traced the N=40
"negative" result to five specific trades with raw uncapped returns of -44% to -104% (signed against
a bearish divergence call). Verified these are REAL price action, not a data bug: BTC genuinely ran
from $5,477→$11,165 in Oct-Dec 2017 and $15,297→$36,742 in Nov 2020-Jan 2021, blowing through
several bearish divergence signals during two of BTC's most extreme historical blow-off phases.
Confirmed the mean-based test's negative N=40 result was an artifact of these five trades inflating
variance, not a real effect: 1%-trimmed mean flips from -0.28% to -0.20% and the median is
slightly POSITIVE (+0.03%). Re-ran with a magnitude-robust proportion (correct-direction) test
instead: **53.3-54.0% correct-direction at N=5/10/20 (all p<0.0001), only fading at N=40 (50.7%,
p=0.32)** — the same shape and magnitude as 5m's own established effect (#35), just invisible to
the standard test at this sample size until outlier-robustness was accounted for.

**This mattered enough to cost-test directly, because the economics are much more favorable here:**
checked first (not assumed) that the round-trip fee is 88.6% of 0.6×ATR(14) risk on 5m, but only
24.3% on 1h and 11.9% on 4h — a real edge has a much better shot at clearing costs on these
timeframes. Built `coarser-tf-divergence-cost-capacity-backtest.js`, same fixed R:R construction as
§29/§30. A stop caps any single trade's loss at -1R regardless of the raw uncapped move, so the
same outlier-sensitivity that distorted the significance test's mean does NOT carry over here.

**Result: 15m/1h/2h/4h all stay negative after costs at every R (matching 5m's pattern), 3h clears
costs only at 2R (an isolated, non-replicating hit, not trusted). But 1d clears costs at EVERY R
multiple tested, and gets MORE profitable as R increases** — 1R: costed +0.4671%/trade → 3R: costed
+1.0013%/trade, pooled n=44. That shape (monotonic improvement with R) is the same signature that
made #27b (SMC recurrence, the only other finding to ever clear costs in this project) trustworthy.

**Scrutinized hard before reporting it, given this exact leg is where the significance test's
outlier events came from:** (a) checked year-by-year distribution of all 44 events — spread 2-7 per
year across all 10 calendar years 2017-2026, no single year above 16% of the total, not a clustered
artifact of the 2017/2020-21 windows already identified; (b) the 44 events split 37 bearish / 7
bullish (BTC's secular uptrend bias, not a bug — divergence naturally fires more on the side that
fights the prevailing trend); the thin bullish leg (n=7, below this project's own n≥30 trust
threshold) could not be independently verified, so re-ran bearish-only (n=37, safely above
threshold): **still clears costs at every R multiple, still monotonically improving with R** (1R:
+0.0273%/trade costed → 3R: +0.6788%/trade costed) — the result does not depend on the thin bullish
subset.

**This is the second finding in the entire project to survive both significance testing and real
costs, after #27b.** Real, disclosed limits, same category as #27b's: n=37 (bearish-only, the
robustly-tested subset) is genuinely small — about 4.1 trades/year, a very low-frequency setup;
single-asset (BTC), backtest-only, idealized fills (next-bar-open, no slippage modeled beyond the
conservative same-bar-ambiguity-favors-stop rule); the strong bearish skew reflects this specific
10-year uptrending sample and has not been tested in a sustained downtrend regime. **Do not treat
as fully live-ready without an explicit, deliberate decision to do so** (the same standing caveat
as #27b) — but this is real evidence, found by taking iapaulo's pushback seriously, checking a
dramatic-looking result before trusting it (twice — once catching the mean-test's outlier
distortion, once verifying the 1d cost result wasn't the same distortion recurring), and following
the diagnosis in §29/§30 (fee-vs-ATR ratio) to its logical next step instead of stopping at "nothing
on 5m clears costs."

## 32. Does §31's daily divergence finding stack with SMC bias? Yes — as a counter-trend filter, with real thinness caveats — 2026-08-01

iapaulo's direct follow-up: "check if it stacks with smc bias." Tested whether aligning §31's
daily-timeframe Cipher B regular divergence entry (the second finding in this project to clear real
costs) with SMC's own same-timeframe structural bias (`structure_events`, same convention as
`breakout-bias-backtest.js`) compounds or hurts the edge.

**Two readings tested, decided empirically rather than assumed:** "with-bias" (SMC's current bias
already agrees with the divergence's direction — e.g. a bearish divergence firing while SMC bias is
already bearish, a continuation/pile-on read) vs. "against-bias" (SMC's bias is the OPPOSITE of the
divergence's direction — e.g. a bearish divergence firing during a bullish SMC bias, the classic
"catching exhaustion at a trend top" reading most divergence trading theory actually describes).
Bias checked at two granularities since 1d `swing`-scope structure only changes 19 times across the
whole 8.95-year history (extremely coarse relative to divergence's own ~4.4 events/year) — `internal`
scope (159 regime changes on 1d) reported alongside as a more responsive alternative, not assumed
better without checking both.

**Result: against-bias clearly outperforms with-bias, consistently across both scope readings.**
Swing scope: against-bias (n=29) at 1R — 69.0% win, PF 2.06, costed +0.8066%/trade; with-bias (n=10)
at 1R — 40.0% win, PF 0.51, costed **-1.0139%/trade**, and stays negative at every R multiple
tested. Internal scope: against-bias (n=37, clears this project's own n≥30 threshold outright) is
positive at 3 of 4 R multiples (1R +0.4805%, 2R +0.3334%, 3R +0.6940%, dipping to -0.1076% only at
1.5R); with-bias (n=4) is too thin to read at all. **Filtering §31's already-established bearish
population (n=37) down to just the against-bias subset roughly TRIPLES the per-trade edge at 1R**
(§31's unfiltered bearish result was +0.0273%/trade costed; against-bias alone reaches +0.48-0.81%)
— this concentrates the edge rather than diluting it, unlike §28's Part 1 near-tautology or most
other "does X stack" checks in this project, which mostly found nothing or made things worse.

**Read plainly: divergence appears to work specifically as a counter-trend reversal signal, exactly
matching classical divergence theory (catching exhaustion against the prevailing trend), not as
confirmation of a trend SMC has already recognized** — a coherent, intuitive story, not just a
numerical pattern.

**Caveats taken seriously, not glossed over, because this is exactly the kind of small-sample
result this project's discipline exists to catch:** §31's base population was already thin (n=37
bearish); splitting it further leaves against-bias at n=29 (swing, just under this project's own
n≥30 threshold) or n=37 (internal, at the threshold only because internal's finer bias resolution
reclassifies more events as against-bias); with-bias is thin under BOTH scopes (n=10, n=4) — its
consistently negative direction across every R multiple and both scopes is suggestive of a real
effect, not proof of one. The two scopes agree directionally (a form of internal replication that
adds some confidence) but differ enough quantitatively that neither should be treated as the final
number. **This is real, promising, well-motivated evidence for a specific refinement of §31's
finding — not a new confirmed result at the same evidentiary bar as #27b or §31 itself.** Before any
live use: would benefit from more historical data (impossible to add here — the base signal is
capped at ~4.4 events/year) or cross-validation against a different asset/period, neither built
here.

## 33. Correction: the "2nd WT Regular Divergence" gap and its effect on §31/§32 — the finding survives, now for a documented reason instead of by accident — 2026-08-01

iapaulo reported seeing far more daily bullish divergences on a live BTC/USD chart than this
project's code detected (9 since Jun 2021 vs. this file's 5) and pushed back hard, correctly, on
how the gap was found: "when i ask you to inventory an indicator, claude should logically return
the inventory not part of the inventory." Investigated and found a real, structural gap — the
actual on-chart divergence-dot signal (`buySignalDiv`/`sellSignalDiv`) is `wtBullDiv OR
wtBullDiv_add`, an OR against a second, independently-gated "2nd WT Regular Divergence" detector
(±40/15, much looser than the primary ±65/45) that this project's `calc.js` never implemented —
confirmed live-active via a properties probe (entity `Ilt4Lv`, `in_21`/`in_22`/`in_23`), not a
tuning question. **A systematic re-inventory pass (grepping every `plot`/`plotshape` line in both
Cipher A and Cipher B, not just re-checking the one gap iapaulo caught) turned up a second live
deviation from Pine's own defaults never caught before (Schaff Trend Cycle, `tcLine=true`) and four
entirely unbuilt Cipher A signals (`redCross`, `blueTriangle`, `bloodDiamond`, `bullCandle`) — see
the standing memory note this produced (`feedback_complete_indicator_inventory`) for the process
fix going forward.**

Added `computeRegularDivergenceUnion()` to `calc.js` (regular OR regular_add, deduped) as the true
on-chart population. **Critical finding before rebuilding anything on top of it: the union DILUTES
rather than strengthens §31/§49's daily cost-clearing result — it should NOT be used for trading,
only for chart-inventory completeness.** Split by kind and tested independently:

- **`regular` (the original ±65/45 gate, n=44 daily events) — UNCHANGED, verified identical to the
  original §31/§49 numbers.** Clears real costs at every R multiple (1R costed +0.4671%/trade → 3R
  costed +1.0013%/trade), exactly as originally reported. This subset was never affected by the gap
  — the gap was a missing SECOND signal, not an error in the first one.
- **`regular_add` (the newly-added ±40/15 gate, n=58 daily events) — a real but smaller directional
  edge that does NOT clear costs at any R multiple tested**, and is actively negative after costs
  (1R costed -0.2590%/trade, 3R costed -0.4153%/trade). Checked whether this is just noise before
  concluding it's tradeable-negative rather than a null: pooled across coarser timeframes (5,182
  `regular` vs. 7,439 `regular_add` events), `regular_add` shows 52.2-52.9% correct-direction at
  N=5/10/20 (p<0.001) — a real, smaller version of the same directional edge, just too thin in
  magnitude relative to a 5-minute-to-daily fixed transaction cost, the identical "real signal,
  wrong magnitude" story already established for buySignal/sellSignal in §29/§30. Rerunning the
  pooled coarser-timeframe significance test (§31) on the union gives 52.8-53.2% correct-direction
  at N=5/10/20 (still significant, p<0.0001, n=8,893) — real, just more diluted than the `regular`-
  only 53.3-54.0% originally reported, exactly as expected from averaging a stronger and a weaker
  population together.

**Net correction: §31/§49's headline finding (daily Cipher B divergence, bearish side, clears real
costs) is fully intact and unchanged in its numbers.** What changes is WHY it should be trusted: it
was built on the `regular`-only subset by construction (this project's original, incomplete
implementation), which turns out — now confirmed rather than assumed — to be the higher-quality
half of the true on-chart signal. **Going forward, `regular` alone (not the union) is the
deliberately correct filter for any future trading construction on Cipher B divergence** — the
"2nd"/`regular_add` detector is a real signal for inventory/completeness purposes but should be
excluded from any cost-sensitive construction, backed now by a direct, tested reason rather than an
accident of what got built first. §32's SMC-bias-stacking result, which already filtered to
`regular` only, required no computational change — its numbers stand as originally reported.

**Extended the same verification to §17/§18 (the original divergence significance chain, #31/#33/
#34/#35) rather than assuming the pattern holds without checking.** Rebuilt `data/signal-bus/
vmc-cipher-b.db` from scratch (the old schema's `CHECK` constraint hard-rejected the new
`regular_add` kind — updated `store.js` first) and reran every DB-based script with `regular_add`
added as a third bucket, appended LAST in each RNG consumption order specifically so `regular`'s and
`hidden`'s baseline draws are undisturbed. Confirmed, not assumed: `timeframe-stratified-
significance.js`'s headline 5m result reproduces almost exactly (54.1/54.8/55.4/54.2%
correct-direction at N=5/10/20/40, p<0.01 at the first three, matching the original report);
`forward-return-significance.js`'s pooled-all-8-timeframes number reproduces exactly (53.9%
correct-direction at N=5, still significant, still decaying by N=20); `gated-divergence-
significance.js`'s "confirmation makes it worse" result reproduces (confirmed-only drops to
46.3-50.6% vs. raw's 53.0-54.7% at every horizon); `confirmation-variants-significance.js`'s "neither
alternative confirmation beats raw" result reproduces (oscillator-recross still turns significantly
negative by N=40). The latter two scripts' gate logic (SMC location, trend-context, oscillator
recross/pullback) is specific to `regular`/`hidden`'s own theoretical claims and was deliberately
NOT extended to `regular_add` here — excluded from their queries with a documented reason rather
than left to crash on the new kind, a scope decision, not an oversight. **Net result: §17/§18's
findings are fully intact, verified against the rebuilt database rather than assumed unaffected.**

**Last piece: §28/#45 Part 2 (buySignal's confluence with a recent same-side divergence).** Reran
`multi-indicator-confluence-significance.js` against all three divergence sources (`regular`,
`regular_add`, `union`) side by side. `regular` alone reproduces byte-for-byte identical to the
original report (70-80 peak bucket, n=711, 58.5-61.7% correct-direction across all 4 horizons).
**Unlike the standalone cost tests, `regular_add` ALSO compounds the effect here** (peak bucket
n=820, 57.7-60.5% correct-direction, all 4 horizons significant) — a meaningfully different result
from §29/§30/§31's finding that `regular_add` isn't tradeable on its own. The distinction makes
sense once stated plainly: `regular_add`'s directional information is too small to survive its OWN
transaction cost as a standalone entry, but costs no money to consult once you're already taking the
`buySignal` trade — using it as a confirming FILTER, not a separate position, sidesteps the exact
problem that sank it standalone. The `union` (n=1028 in the peak bucket, the largest sample of the
three) confirms this: 57.5-60.9% correct-direction across all 4 horizons, all significant — slightly
larger sample, comparable strength to `regular` alone. **Practical implication, different from
§29-§31's "always prefer `regular` alone" guidance: for a CONFIRMATION role specifically (not a
standalone entry), the union is a reasonable or even preferable choice** — the two roles call for
different filters, now checked rather than assumed to be the same answer.

**This closes out the full re-verification prompted by iapaulo catching the original undercount:
§31/§32 unchanged, §17/§18 unchanged, §28/#45 Part 2 unchanged for `regular` and meaningfully
extended (not weakened) once `regular_add`/`union` are properly checked. No finding in this whole
investigation was reversed by the fix — the fix corrected an incomplete inventory, and closer
checking made several results either unchanged or stronger.**
