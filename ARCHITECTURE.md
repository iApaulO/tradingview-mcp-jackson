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
4. **Performance baselines.** Not established for any indicator individually or in combination.
   Needs the backtesting path above before this is answerable with real numbers rather than
   vibes.

## 6. Changelog

- 2026-07-24 — doc created. Captures state after: 5-indicator signal grid with full Cipher B
  battery, Coinbase futures watchlist switch + proxy mapping, self-healing Data Window fix.
- 2026-07-24 — multi-pane parallelism question tested and closed (§5.1): not viable, plan-capped
  and reads aren't actually concurrent. Discovered a stale second pane with unrelated leftover
  indicators from earlier experimentation — left in place untouched, just not in the active layout.
