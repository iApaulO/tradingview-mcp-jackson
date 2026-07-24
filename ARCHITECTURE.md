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
| **VuManChu Cipher A** (ribbon) | TV-native, public script, source not obtained | 8-EMA ribbon (periods 5,11,15,18,21,24,28,34), plus Long/Short EMA Signal, Red cross, Blue Triangle, Red Diamond, Bull candle, Blood Diamond, Yellow Cross | Ribbon direction = monotonic EMA stack (`extractRibbon` in signal-grid.js). Its Data Window row has silently gone hidden 3x — now self-healing, see §4. |
| **VuManChu B Divergences** (Cipher B) | TV-native, source obtained: `pine/vmc-cipher-b-divergences.pine` | WaveTrend (WT1/WT2/VWAP spread), MFI, RSI(14), Stoch K/D, Schaff Trend Cycle, 4 divergence families (WT regular + WT 2nd-range, RSI, Stoch), buy/sell circles, "gold" warning circle, Sommi higher-TF flags/diamonds | Fully mapped — `extractCipherB` in signal-grid.js pulls the whole battery, not just RSI/WT. |
| **Smart Money Concepts [LuxAlgo]** | TV-native, source not obtained | BOS/CHoCH structure, Order Blocks (internal+swing, drawn as boxes), EQH/EQL liquidity pools, FVG, Premium/Discount/Equilibrium zones | Box data gives high/low but color->bullish/bearish classification unverified (ARGB values didn't map to an obvious convention) — open item. |
| **Boom Hunter Pro 1.022** | TV-native, source not obtained | Quotient 1/2, Exit Warning, Long gray/yellow/blue/Lime, Break | Raw values only pulled so far (signal-grid.js) — meaning of Quotient 1/2 not yet documented. |
| **Divergence for Many Indicators v4** | TV-native, source obtained: `pine/divergence-for-many-relevance-gated.pine` | MACD/MACD Hist/RSI/Stoch divergence badges, relevance-gated "promoted" support/resistance glow levels | Fully mapped, settings match "Commander default profile." |
| **Adaptive SuperTrend [AlgoAlpha]** | Independently computed, source obtained: `pine/ml-adaptive-supertrend-algoalpha.pine` | K-means volatility-regime clustering (High/Med/Low) -> ATR-adaptive SuperTrend line + direction | Not on the visible chart by design — runs headless. Cross-validated once against the on-chart Pine instance (matched within ~$1). |

**Open:** Boom Hunter and SMC signal semantics aren't fully documented (no source yet — could
request/fork like we did for Cipher B, or reverse-engineer from behavior).

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
- **Order block bullish/bearish classification unverified** — SMC's box color data doesn't map
  cleanly to a known convention; currently reporting raw zones without a direction label.

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
3. **Backtesting path.** Two tiers, neither started:
   - *Manual now*: `skills/replay-practice/SKILL.md` + `agents/performance-analyst.md` already
     exist — Replay mode, discretionary rule application, P&L summary. Zero new code.
   - *Automated, not yet built*: needs `rules.json`'s bias/risk criteria translated into an
     actual Pine `strategy()` script with `strategy.entry()`/`strategy.exit()`. Everything
     downstream (`data_get_strategy_results`, `strategy-report` skill, `performance-analyst`
     agent) is already scaffolded and waiting.
   - **Raised in priority by §7** — public data can't answer "are our settings/signals any good,"
     only we can, on our actual instrument. That's what this path is for.
4. **Performance baselines.** Not established for any indicator individually or in combination.
   Needs the backtesting path above before this is answerable with real numbers rather than
   vibes.

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

## 8. Changelog

- 2026-07-24 — doc created. Captures state after: 5-indicator signal grid with full Cipher B
  battery, Coinbase futures watchlist switch + proxy mapping, self-healing Data Window fix.
- 2026-07-24 — multi-pane parallelism question tested and closed (§5.1): not viable, plan-capped
  and reads aren't actually concurrent. Discovered a stale second pane with unrelated leftover
  indicators from earlier experimentation — left in place untouched, just not in the active layout.
- 2026-07-24 — added empirical research log (§7): no public validation exists for either
  AlgoAlpha's ML Adaptive SuperTrend or LuxAlgo's SMC specifically; SMC/ICT as a methodology has
  genuine, unresolved controversy (not just an absence of data). Raised backtesting path priority.
