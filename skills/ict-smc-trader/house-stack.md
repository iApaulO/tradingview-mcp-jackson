# House Stack — Indicators, Extractors, TF Ladder, Proxies, Known Bugs

Operational reference. Full audit trail and significance labels live in `PRIOR_ART.md` and
`significance-register.md`; this file is "what do I actually read and trust when grading a setup."

## Timeframe ladder (fixed, do not deviate)

**W, D, 4H, 3H, 2H, 1H, 15m, 5m.** Never 14m. Never a subset unless the user explicitly asks for
one timeframe.

Two live/offline gaps to know about, not to silently paper over:
- `scripts/signal-grid.js` (the live CDP sweep tool) still only covers **5** of these 8 (15m/1H/
  4H/1D/1W) — 3H/2H/5m are missing from the live sweep. The offline `scripts/signal-bus/*` work
  covers the full 8. If you're reading a *live* board, say which timeframes you actually have.
- 3H candles don't exist natively in the historical data source; they're synthesized from 1H
  (`scripts/backtest/lib/aggregate-candles.js`, UTC-aligned 3-hour buckets). Fine for offline
  analysis, not relevant to live reads (TradingView Desktop can set 3H directly).

## Instrument & proxy

- **Traded instrument: `BITUNIX:BTCUSDT.P`.** Changed 2026-08-15 — Coinbase is no longer used.
  The previous instrument was `COINBASE:BIPZ2030` (nano BTC Perp Style Futures); anything in this
  repo still naming it is either stale or a deliberate historical record (see the cost note below).
- Independent SuperTrend calc pulls from Bitstamp (which lists neither Coinbase Derivatives nor
  Bitunix perps) → proxies through `BTCUSD` spot (`rules.json`'s `supertrend_proxy` map). **Always
  label `[via BTCUSD proxy]`** when reporting a SuperTrend reading. The proxy layer is unchanged by
  the venue switch — it was always a spot stand-in for a perp/futures contract, and still is.
- Backtest lab's historical data is Binance BTC spot, 2017–2024, gap-filled from Coinbase's public
  Exchange API — a second proxy layer, used only for offline signal-bus/backtest work, not live
  reads. Coinbase's role here is a free public price feed with no account attached, unaffected by
  no longer trading there.
- **Confirmed real trading costs: Bitunix VIP1, 0.050% taker / 0.020% maker** (`costs.js`'s
  `bitunix_futures_vip1`, pulled from Bitunix's own official fee page rather than a third-party
  aggregator). This is the current default for cost tests. Funding settles **hourly** (confirmed
  mechanism: basis-driven peer-to-peer transfer, contract-above-spot → longs pay shorts). Funding
  *magnitude* is still an unconfirmed cross-exchange placeholder — don't quote a precise funding
  number as confirmed.
- **Reading older findings against the old fee basis:** register rows up to roughly #74 costed
  trades on Coinbase's Advanced 1 tier (0.070% taker / 0.065% maker) — the real basis at the time.
  Those rows are historical record and are deliberately NOT rewritten. Bitunix VIP1 is cheaper on
  both sides, so any finding that cleared costs under Coinbase clears them by a wider margin now;
  a finding that was cost-*blocked* under Coinbase is not automatically rescued and needs an actual
  re-run before being called tradeable. `#75` onward already use the Bitunix basis.

## Validated cross-indicator strategies (2026-08-11/13 session)

If forced to pick ONE thing to trust over everything else in this file, it's this pair — both
cleared real significance, real costs, AND out-of-sample/walk-forward persistence (the full house
bar), not just one or two of the three. Full detail: `significance-register.md` #106-125.

- **Strategy A2 (SMC order-block engulfment, all timeframes)**: `recurrence_count >= 3 AND`
  fully-engulfed-by-or-engulfing-another-same-side-OB (not just partial overlap). n=17,434,
  costed +0.2458%/trade. Slightly LOWER in-sample average than the looser recurrence>=3-pooled
  version (A), but roughly **3x** A's walk-forward contribution and **half** A's out-of-sample
  loss (#120/#121) — the smaller, higher-conviction population generalizes better. Now the default
  in `portfolio-backtest.js` (`--strategy-a-variant=a` recovers the original).
- **Strategy G (WT2 extreme-anchor cascade, 15m/5m)**: Cipher B's WT2 hitting an extreme
  (`computeWtExtremeFractals`, `vmc-cipher-b/calc.js`) + same-side SMC swing order-block confluence
  at entry + held to the opposite-side OB's origin bar + Boom Hunter's q5 dropping at the anchor +
  same-side Divergence-for-Many line confluence + **firing AGAINST the concurrent daily WT-anchor
  regime, not with it**. n=545-668 (15m), costed ~+0.37-0.45%/trade, p=0.0000, walk-forward
  contribution dominates every other strategy in the portfolio (#106-121). Counter-intuitive but
  confirmed twice (observational split + formal significance, #113/#114): this is fundamentally an
  exhaustion/reversal signal, and trading it WITH the daily trend is statistically no better than
  chance — don't add a regime-agreement filter, the opposite one is what works.
  - **Open question on G's D4M component, as of #126 (2026-08-15) — do not quietly ignore this.**
    Formal permutation testing says the Divergence-for-Many line-confluence condition listed above
    is the one component that does NOT earn its place: it fails a selection test on both
    adequately-powered timeframes (15m p=0.1265, 5m p=0.9864 — on 5m the D4M-filtered subset is
    actually *below* its own unfiltered base). The swing-line condition (`computeSwingPivotSeries`,
    OB beyond the current active swing pivot), which G does **not** currently use, clears the same
    test on both (p=0.0008, p=0.0008) and carries the whole effect. G's numbers above are still
    valid as measured — this is not a claim G is broken — but the D4M leg is likely dead weight
    and swing-line is likely the better filter. **Not yet swapped**, deliberately: #121 established
    that in-sample ranking is not forward persistence, so this needs its own OOS/walk-forward run
    before touching `portfolio-backtest.js`. Also unsettled: #126 found the whole G chain queries
    D4M zones without a timeframe filter (pooling all timeframes, 66% of which are 5m rows), which
    is not the condition the prose describes — under an own-timeframe scope, D4M *does* add value
    on 15m (p=0.0242) but not 5m. Settle the scope before concluding anything final about D4M.
  - **15m/5m is not an arbitrary scoping.** #126's ladder check confirms it independently: above
    1h even the BASE anchor construction fails the direction null (4h p=0.8245, 3h p=0.1139,
    1h p=0.1910), while 15m and 5m are p=0.0000 for every variant. Higher rungs are also simply
    too thin (4h n=13, 3h n=21, 1d n=0, 1w has no base population at all).

Both are 15m/all-timeframe cross-indicator constructions, not single-indicator signals — they
don't fit cleanly under one indicator's card below, which is why they're called out here first.

## Indicator reference cards

### 1. Smart Money Concepts [LuxAlgo] — `pine/smart-money-concepts-luxalgo.pine`

- **Structure (BOS/CHoCH):** two independent scopes running simultaneously — **internal** (5-bar
  leg detection, fast/noisy) and **swing** (50-bar leg detection, slow/major). A break is CHoCH if
  it flips the tracked trend bias, BOS if it continues it. **Direction comes from which of the two
  independent code branches fired (bullish-high-cross vs. bearish-low-cross), never from the label
  tag text alone** — the tag only ever says "BOS" or "CHoCH," not direction. Live extraction
  (`signal-grid.js`) does not currently decode this; the offline reimplementation
  (`scripts/signal-bus/smc/calc.js`) does, by tracking trend bias explicitly bar-by-bar.
- **Order blocks:** internal and swing, anchored at the most extreme "parsed" high/low between the
  pivot and the break (with a high-volatility-bar swap filter so an outlier wick doesn't anchor
  the block). Colors are **blue/red-family, not green/red**:
  - Internal bullish `#3179f5`, internal bearish `#f77c80`
  - Swing bullish `#1848cc`, swing bearish `#b22833`
  - (Packed **ABGR** in the raw Pine color value, not ARGB — decode accordingly if reading raw box
    colors from the live tool.)
  - Mitigation (invalidation) = price's high/low (not close) fully clears the block's far edge —
    exact and terminal, not a judgment call.
- **EQH/EQL — this house's liquidity-zone concept:** EQH uses the SAME color as bearish structure
  (`#F23645` red), EQL uses the same color as bullish structure (`#089981` green) — i.e. equal
  LOWS are the bullish/green one (buy-side liquidity/support), equal HIGHS are the bearish/red one
  (sell-side liquidity/resistance). This is genuinely easy to get backwards on first read — check
  `grammar.md` if unsure.
  - **The classic "sweep precedes reversal" liquidity narrative is FALSIFIED on our own data.**
    Do not use a liquidity sweep as a bullish/bearish scoring input. See `significance-register.md`.
  - **Recurrence isn't uniform — full containment beats plain overlap (#117/#118, 2026-08-12).**
    `recurrence_count` (same-timeframe/side order blocks that overlap) treats "barely clips the
    edge" and "fully swallows it" as identical. They're not: isolated (recurrence=1) OBs are
    COST-NEGATIVE at every R multiple; among overlapping OBs, full containment (one range is a
    strict superset of the other, `scripts/signal-bus/smc/engulfment.js`) beats plain partial
    overlap by 3.6-5.0 win-rate points, p=0.0000 at every R. Not uniform across the ladder though —
    2h/3h lean the other way (partial beats engulfment there); the pooled win is carried by
    15m/5m/1h/4h. See the strategy box above for the validated A2 (engulfment-restricted) variant.
- **FVG:** off by default in the source. Not analyzed in this house's signal bus.
- **Premium/Discount/Equilibrium zones:** a live single *current-range* display, not a historical
  zone series — not part of any tested finding here, descriptive only if shown.

### 2. Divergence for Many Indicators v4 — `pine/divergence-for-many-relevance-gated.pine`

- Running under "Commander default profile": pivot period 10, minimum 3 divergences to badge, 4
  of 11 possible sub-indicators enabled (MACD, MACD Histogram, RSI, Stochastic).
- **Badges** (event, fires once) vs. **promoted glow-level zones** (persistent, ATR-deduped,
  200-bar-equivalent expiry, capacity-capped at 3 per side) are different objects — a badge firing
  does not by itself mean a durable zone was created.
- Zone hold rate: stable ~50–55% band across timeframes (descriptive-significant, not a trading
  rule by itself). Confluence with other timeframes' zones raises the tested hold rate materially
  (53.4%→60.6%, p<0.001) — this is the one Divergence-for-Many finding worth weighting in scoring.
- Hidden divergence is disabled by default and, per source, **does not affect zone promotion even
  if enabled** — promotion gates strictly on regular-divergence count.
- **Live indicator is the "Touch-Refresh Fork"** — a level's life extends every bar price re-touches
  it, not a flat expiry clock. This port (`divergence-for-many/calc.js`) was MISSING that mechanism
  entirely until 2026-08-13 (#124) — every D4M finding before that date (including the 0.2%-tolerance
  choice below) ran on a version that dropped genuinely-still-relevant lines at a fixed 200-bar mark.
  Fixed and rebuilt (`data/signal-bus/divergence-for-many.db`); all downstream findings re-verified
  and hold (#125) — the qualitative conclusions didn't change, sample sizes grew and magnitudes
  shifted modestly. If this db ever looks stale again (zones "expired" that iapaulo says are still
  live on chart), check `data/historical/binance-btc-*.csv` freshness first (`fetch-coinbase-gapfill.js`
  + `build-aggregated-candles.js` to refresh), then rebuild this db — don't assume the fix regressed.
- **Price tolerance for cross-zone confluence is 1.2% of price in practice, not the coded 0.2%
  default** (#103) — 0.2% was ~5.8x tighter than a live-confirmed spread. `confluence.js`'s
  `computeConfluence` accepts a `pctOverride` for this; the 0.2% default is left alone (an earlier
  finding used it and stays valid at that setting) but any NEW cross-zone confluence check should
  pass the wider, live-calibrated value explicitly, not rely on the default.

### 3. Boom Hunter Pro — `pine/boom-hunter-pro.pine`

- Live-extractable and trustworthy: `Long gray` (weakest, broad recovery), `Long yellow` (Red Wave
  extreme), `Long blue` (fast reversal), `Long Lime` (highest-quality, most-filtered — "QUALITY
  ENTRIES" per source comment), `quotient_1`/`quotient_2` (trigger/oscillator pair), derived
  `momentum_direction`.
- **Ambiguous, flagged, not to be trusted at face value:** `exit_warning_ambiguous` (collapses two
  different underlying conditions to one Data Window key) and `break_ambiguous` (collapses a SHORT
  setup and a bullish continuation signal — source-order analysis suggests "Break" firing most
  likely means bullish continuation, **not** the short setup, but this is still unverified against
  live UI). Never treat `break_ambiguous` as a reliable short trigger.
- **Signal-bus reimplementation + significance testing built 2026-08-09** (`scripts/signal-bus/boom-hunter/`,
  significance-register.md #60/#60a/#61) — Long(any tier)->OB->Continuation "full sequence" is a
  real, tested statistical claim now; see decision-policy.md's trigger-layer quality bonus for the
  scoring rule this replaced. `enter4` graduated to a 5th wired Long tier. Short side
  (`break_short`/`senter3`) was tested and found too weak to wire (#60a) — still live-timing-only,
  not a tested claim.
- **`q5`** (`quotient(X3, K13)` series, `computeBoomHunter`'s `series.q5`) dropping at the moment of
  a Cipher B WT2 extreme is a load-bearing filter in Strategy G (see box above) — q5 declining
  1 bar over the anchor bar meaningfully sharpens the WT-anchor construction (#110). Not tested as
  a standalone Boom Hunter signal on its own, only as this specific cross-indicator filter.

### 4. VuManChu Cipher A (ribbon) — `pine/vmc-cipher-a-ribbon.pine`

- Ribbon direction = **`ema8 < ema2`** exactly (confirmed from source, verified against live
  non-monotonic EMA data). Not a full 8-EMA monotonic stack requirement — that was an earlier,
  wrong, stricter guess.
- `stack_shape` (clean_bullish_stack / clean_bearish_stack / tangled) is a supplementary read, not
  the indicator's own signal — useful for gauging trend cleanliness, not a substitute for direction.
- **Signal-bus built 2026-08-09** (`scripts/signal-bus/vmc-cipher-a/`, `cipher-a.db`) — previously
  only computed ad-hoc, imported inline from Cipher B scripts. `bullCandle` nested cross-timeframe
  confirmation is real and significant (significance-register.md #71) but **trade-construction-
  blocked** at real costs (#74) — do not treat as tradeable, same status as most of this session's
  significance-only findings.
- Nested-confirmation testing extended to the other 6 Cipher A signals (#77): `red_cross` (the
  strongest Cipher A nested result found, stronger than bullCandle's own) and `green_dot` are real
  and significant; `blue_triangle`/`red_diamond` null; `yellow_cross`/`bloodDiamond` too rare to
  test. Both real candidates cost/capacity tested (#78) — **also trade-construction-blocked** at
  every R, though `red_cross` comes closest (gross expectancy turns slightly positive at 2R/3R
  before fees, the first Cipher A signal to do so). A wider-stop sweep on `red_cross` (0.6x-2.0x
  ATR) doesn't unblock it either — improves modestly to ~1.0-1.5x then reverses (#79).
- Cross-indicator confluence with Adaptive SuperTrend's current directional state (not the
  within-indicator nesting above) tested directly (#80) — weaker than nesting on `red_cross`/
  `green_dot`, and `bull_candle`'s one real result (pooled, 3h, 15m) stays blocked; the cells that
  superficially clear costs (1d/1w) were never statistically significant and are small-sample noise,
  not a real edge. No Cipher A signal is tradeable as constructed under any angle tried so far.

### 5. VuManChu B Divergences (Cipher B) — `pine/vmc-cipher-b-divergences.pine`

- Full battery available live: WT1/WT2 + VWAP spread, RSI, MFI, Stoch K/D, Schaff Trend Cycle, 4
  divergence families (WT regular + WT 2nd-range, RSI, Stoch), buy/sell circles, gold warning
  circle, Sommi higher-TF flags/diamonds.
- **Correction, 2026-08-11/13: this is no longer true for WT2.** WT2 hitting an extreme
  (overbought/oversold fractal pivot, whether or not a full 2-point divergence ever confirms —
  `computeWtExtremeFractals`, added 2026-08-11 to `vmc-cipher-b/calc.js`) is the anchor for
  **Strategy G**, the strongest, most rigorously validated cross-indicator construction in this
  entire project — see the box above and `significance-register.md` #106-125. 73-84% of these
  extreme anchors go on to confirm a full divergence within ~20-25 bars, and the anchor ALONE
  (before waiting for confirmation) is what the tradeable construction is built on — waiting for
  the full divergence to print is systematically late.
- Everything else in this card (RSI/MFI/Stoch divergence families, buy/sell circles, Sommi
  flags/diamonds, gold warning circle) remains **supporting context, never a sole trigger** — no
  independent significance test behind any of those specifically. Don't extend WT2's validated
  status to the rest of the indicator by association.

### 6. K-Means Adaptive SuperTrend [AlgoAlpha] — `pine/ml-adaptive-supertrend-algoalpha.pine`

- Independently reimplemented (`scripts/lib/adaptive-supertrend.js`), used both live (headless,
  proxy-fed) and in the full backtest lab — the only indicator with real backtest history.
- Volatility regime (HIGH/MEDIUM/LOW) via K-means clustering on a rolling ATR window feeds an
  ATR-adaptive SuperTrend band. Direction flips are the tradeable signal; regime label is context.
- **Backtest headline: flips alone did not clear a real, costed, multiple-testing-corrected edge**
  (see `significance-register.md`). Use as a confirmation/veto candidate in scoring, never as a
  standalone system.
- Always `[via BTCUSD proxy]` on this instrument.
- **Signal-bus built 2026-08-09** (`scripts/signal-bus/adaptive-supertrend/`, `adaptive-supertrend.db`)
  — first time this indicator entered the calc/store/build-historical pattern (previously
  `scripts/lib/` only). Nested cross-timeframe flip confirmation is a REAL, strong finding
  (significance-register.md #72 — the strongest significance result of this project's whole nested-
  confirmation line of work, p=0.0000 pooled) but is also **trade-construction-blocked** at real
  costs (#73) — the flip-alone verdict above still stands practically, even though nesting rescues
  it statistically.
