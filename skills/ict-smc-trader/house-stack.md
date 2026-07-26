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

- Traded instrument: `COINBASE:BIPZ2030` (nano BTC Perp Style Futures).
- Independent SuperTrend calc pulls from Bitstamp (no Coinbase Derivatives listing there) →
  proxies through `BTCUSD` spot (`rules.json`'s `supertrend_proxy` map). **Always label
  `[via BTCUSD proxy]`** when reporting a SuperTrend reading for BIPZ.
- Backtest lab's historical data is Binance BTC spot, 2017–2024 — a second proxy layer, used only
  for offline signal-bus/backtest work, not live reads.
- Confirmed real trading costs (from iapaulo's own Coinbase Advanced dashboard): Advanced 1 tier,
  **0.070% taker / 0.065% maker** on derivatives volume. Funding settles **hourly** (confirmed
  mechanism: basis-driven peer-to-peer transfer, contract-above-spot → longs pay shorts). Funding
  *magnitude* is still an unconfirmed cross-exchange placeholder — don't quote a precise funding
  number as confirmed.

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
- No independent backtest or signal-bus exists for Boom Hunter — treat as a live timing/trigger
  input only, not a source of any tested statistical claim.

### 4. VuManChu Cipher A (ribbon) — `pine/vmc-cipher-a-ribbon.pine`

- Ribbon direction = **`ema8 < ema2`** exactly (confirmed from source, verified against live
  non-monotonic EMA data). Not a full 8-EMA monotonic stack requirement — that was an earlier,
  wrong, stricter guess.
- `stack_shape` (clean_bullish_stack / clean_bearish_stack / tangled) is a supplementary read, not
  the indicator's own signal — useful for gauging trend cleanliness, not a substitute for direction.

### 5. VuManChu B Divergences (Cipher B) — `pine/vmc-cipher-b-divergences.pine`

- Full battery available live: WT1/WT2 + VWAP spread, RSI, MFI, Stoch K/D, Schaff Trend Cycle, 4
  divergence families (WT regular + WT 2nd-range, RSI, Stoch), buy/sell circles, gold warning
  circle, Sommi higher-TF flags/diamonds.
- Treat as **supporting context, never a sole trigger** — no sub-signal here has an independent
  significance test behind it. Useful for confirming/questioning what SMC/Boom Hunter/Divergence
  are already saying, not for originating a call on its own.

### 6. K-Means Adaptive SuperTrend [AlgoAlpha] — `pine/ml-adaptive-supertrend-algoalpha.pine`

- Independently reimplemented (`scripts/lib/adaptive-supertrend.js`), used both live (headless,
  proxy-fed) and in the full backtest lab — the only indicator with real backtest history.
- Volatility regime (HIGH/MEDIUM/LOW) via K-means clustering on a rolling ATR window feeds an
  ATR-adaptive SuperTrend band. Direction flips are the tradeable signal; regime label is context.
- **Backtest headline: flips alone did not clear a real, costed, multiple-testing-corrected edge**
  (see `significance-register.md`). Use as a confirmation/veto candidate in scoring, never as a
  standalone system.
- Always `[via BTCUSD proxy]` on this instrument.
