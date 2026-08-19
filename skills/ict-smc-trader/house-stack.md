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

> **Each card carries a LIVE TV SIGNAL INVENTORY** — every signal the indicator actually emits to
> TradingView (`plot` / `plotshape` / `plotchar` / `barcolor` / `bgcolor` / `hline` / `alertcondition`
> / drawing objects), taken from the Pine source by enumeration rather than from memory, with the
> **title TradingView actually reports** and the source line. Enumerated 2026-08-19.
>
> **Read the "TV title" column before trusting any live extraction.** Titles are the vendor's, not
> ours, and several are wrong or duplicated in the source — Boom Hunter reports FOUR different series
> as `Quotient 1`. A signal marked **untested** has no register row: it exists on the chart and has
> never been evaluated here. That is a to-do list, not a set of endorsements.

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
  LOWS are the bullish/green one, equal HIGHS are the bearish/red one. **The COLOURS above are
  right; an earlier version of this card attached the wrong liquidity SIDE to them and that is
  corrected here (2026-08-19).**
  - **CORRECTION — buyside/sellside were inverted.** This card previously read equal LOWS as
    "buy-side liquidity/support" and equal HIGHS as "sell-side liquidity/resistance". **That is
    backwards.** Buyside liquidity rests ABOVE equal highs (buy stops from shorts + breakout buys);
    sellside liquidity rests BELOW equal lows. Confirmed four independent ways: the ICT Concepts
    source colours `cLIQ_B` "Buyside Liquidity" and clusters it from pivot HIGHS (`ict-concepts-
    luxalgo.pine:66,373-374`); our own port does the same (`scripts/signal-bus/ict/liquidity.js:121`,
    `[1, ph, "buyside"]`); the ICT literature is unambiguous; and the mechanics only work that way.
    **This matters because iapaulo's core standing hypothesis is phrased "price above buyside
    liquidity" — under the old wording that would have resolved to equal LOWS and inverted the
    test.** The port was always correct; only this card's prose was wrong. Bullish/bearish COLOUR
    and liquidity SIDE are orthogonal and must not be conflated: red EQH = bearish-coloured =
    BUYSIDE liquidity.
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


**LIVE TV SIGNAL INVENTORY — 17 emitting calls + all drawing objects (`smart-money-concepts-luxalgo.pine`, 848 lines).**
This indicator emits almost nothing through `plot`. Everything visible is a **drawing object** —
9 `label.new`, 7 `line.new`, 4 `box.new` — which is why the live path is `data_get_pine_labels` /
`data_get_pine_lines` / `data_get_pine_boxes` and NOT `data_get_study_values`. One `plotcandle`
(L768) repaints the candle bodies; 3 `bgcolor` calls shade the premium/discount zones.

| # | Alert title (TV) | Line | Extracted / tested here |
|---|---|---|---|
| 1-4 | `Internal Bullish BOS` / `Internal Bullish CHoCH` / `Internal Bearish BOS` / `Internal Bearish CHoCH` | 827-830 | yes — `smc/calc.js`, internal scope |
| 5-8 | `Bullish BOS` / `Bullish CHoCH` / `Bearish BOS` / `Bearish CHoCH` (swing scope) | 832-835 | yes — swing scope |
| 9-12 | `Bullish/Bearish Internal OB Breakout`, `Bullish/Bearish Swing OB Breakout` | 837-840 | partly — we model OB **mitigation**; the vendor's "breakout" alert is a different event and is **untested** |
| 13-14 | `Equal Highs` / `Equal Lows` | 842-843 | yes — and the sweep-reversal reading is FALSIFIED (see above) |
| 15-16 | `Bullish FVG` / `Bearish FVG` | 845-846 | **no — untested.** FVG display is off by default but **the alerts fire regardless of the display toggle** |

- **SOURCE BUG worth knowing: two swing alerts carry INTERNAL message text.** `swingBullishBOS`
  (L832) and `swingBullishCHoCH` (L833) send `'Internal Bullish BOS formed'` /
  `'Internal Bullish CHoCH formed'`. The bearish pair is correct. **Any alert routing keyed on
  message text rather than alert title will mislabel two swing events as internal.** Ours keys on
  neither (we recompute offline), so no finding here is affected — but do not build a webhook on
  those strings.
- **The FVG alerts fire even with FVG display off** — two live signals that would never appear on
  the chart and have never been tested.

### 2. Divergence for Many Indicators v4 — `pine/divergence-for-many-touch-refresh-intensity.pine`

> **File correction 2026-08-19:** this card previously pointed at
> `pine/divergence-for-many-relevance-gated.pine` while its own text (below) says the LIVE indicator
> is the touch-refresh fork. Both files exist; the touch-refresh one is what is on the chart and what
> `divergence-for-many/calc.js` was rebuilt against in #124. The relevance-gated file is the older
> variant and is retained for reference only.

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


**LIVE TV SIGNAL INVENTORY — 10 emitting calls (`divergence-for-many-touch-refresh-intensity.pine`, 587 lines).**
Like SMC this is mostly a drawing indicator (2 `label.new`, 4 `line.new`).

| # | Signal | Kind | Line | Extracted / tested here |
|---|---|---|---|---|
| 1-2 | SMA 50 / SMA 200 overlay (`showmas`, off by default) | `plot` | 109-110 | no — cosmetic, **untested** |
| 3-4 | pivot-high / pivot-low markers (`showpivot`, white) | `plotshape` | 157-158 | internal to zone construction |
| 5 | `Positive Regular Divergence Detected` | alert | 581 | yes — the promotion input |
| 6 | `Negative Regular Divergence Detected` | alert | 582 | yes |
| 7 | `Positive Hidden Divergence Detected` | alert | 583 | **no — untested.** Hidden div is off by default AND per source does not affect zone promotion |
| 8 | `Negative Hidden Divergence Detected` | alert | 584 | **no — untested**, same |
| 9-10 | `Positive Divergence Detected` / `Negative Divergence Detected` | alert | 586-587 | **no — untested.** These fire on regular **OR hidden**, so they cover events our corpus deliberately excludes — do not treat them as equivalent to 5/6 |

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


**LIVE TV SIGNAL INVENTORY — 45 emitting calls (`boom-hunter-pro.pine`, 423 lines). The largest and by
far the most mislabelled surface in the stack.**

**READ THIS FIRST — THE PLOT TITLES IN THIS INDICATOR ARE WRONG AND THEY COLLIDE.** Enumerating every
`plot`:

| Pine var | actually plots | **title TradingView reports** | colour | line |
|---|---|---|---|---|
| `Plot33` | **q3** | `Quotient 1` | red (50 transp) | 238 |
| `Plot44` | **q4** | `Quotient 2` | red (50 transp) | 239 |
| `Plot54` | **q6** | `Quotient 1` | **blue**, hardcoded | 263 |
| `Plot55` | **q5** | `Quotient 1` | **yellow** | 264 |
| `Plot` | **q1** | `Quotient 2` | state-dependent | 368 |
| `Plot4` | **q1** (again) | `Quotient 2` | `osccol` input, **default blue** | 369 |
| `Plot3` | **trigger** | `Quotient 1` | `trigcol`, default white | 371 |

- **FOUR different series report as `Quotient 1`** (q3, q6, q5, trigger) and **three report as
  `Quotient 2`** (q4, q1, q1). Not one title is correct. The variable actually named `Quotient1` is
  titled `Quotient 2` where it is plotted. **Live extraction by Data Window title cannot separate
  these series and must not be attempted** — use `REFERENTS.md` and the offline port.
- **q1 is plotted TWICE, overlapping.** `Plot` (L368) carries the informative state colour —
  `#00ffaa` when `cross==1`, purple on `drag>=dragno`, yellow on `Quotient1<=-0.8`, white on
  `Quotient3<=-0.9`, red on `cross==0`, else gray. `Plot4` (L369) redraws the SAME series in flat
  `osccol` **on top of it**, so that state colour is invisible on the chart. That is why q1 simply
  looks blue.
- **This is the structural cause of the "blue line" failure** (#189): two blue objects (`Plot54`=q6
  hardcoded blue, `Plot4`=q1 via a blue-defaulted colour input), four colliding titles, and a hidden
  state-colour plot underneath. See `REFERENTS.md`.
- `theme` (L10) is **hardcoded to `'Dark'`** — its input is commented out — so `Plot55`'s Light-theme
  orange branch is unreachable. **q5 is always yellow.**

**Entry / exit shapes** (`plotshape`), all live:

| Title (TV) | Condition | Colour / text | Line | Status |
|---|---|---|---|---|
| `Long gray` | `enter6 and q1<=60` | silver "Long" | 388 | wired tier |
| `Long yellow` | `enter7` (`Quotient3<=-0.9` + q1/trigger cross) | yellow "Long" | 389 | wired tier |
| `Long blue` | `enter5` | blue "Long" | 390 | wired tier |
| `Long Lime` | `enter3` — source comment "QUALITY ENTRIES" | lime "Long" | 391 | wired tier |
| `Break` | **`senter3`** — the SHORT setup | red, text "Short" | 393 | tested, too weak to wire (#60a) |
| `Break` | **`crossover(q1, highUsePivot) and dbreak>=1 and ubreak<=1`** | `#00ffaa` triangle, text "Continuation" | 396 | tested (#60/#61) |
| `Exit Warning` | **`over`** = `cross(Quotient5, Quotient6) and Q5>0.5` | orange circle | 274 | **untested** |
| `Exit Warning` | **`over3`** = `cross(Quotient3, Quotient4) and Q3>0` | red circle, text "Overbought" | 275 | **untested** |
| *(untitled)* | `wt2` crosses back under 80 within 1 bar | **yellow** triangle-down | 403 | **untested — absent from this card until 2026-08-19** |
| *(untitled)* | `wt2` crosses back over 20 within 1 bar | **yellow** triangle-up | 404 | **untested — absent from this card until 2026-08-19** |

- **`break_ambiguous` and `exit_warning_ambiguous` are RESOLVED from source and the old "unverified
  against live UI" caveat can be retired.** Both are genuine title collisions: two `plotshape` calls
  share the title `Break` (L393 the short setup / L396 bullish continuation) and two share
  `Exit Warning` (L274 orange q5×q6 / L275 red q3×q4). The earlier guess that "Break" most likely
  means bullish continuation was **half right** — both exist, and the shape title genuinely cannot
  separate them. **The alertconditions CAN**: `Short` (L423) vs `Continuation` (L418), and
  `Orange - Overbought` (L419) vs `Red - Overbought` (L420). If these are ever wired live, route on
  the ALERT, never on the shape title.
- The two **untitled yellow "Bounce" shapes** (L403/404) were never in this card. They are driven by
  an embedded WaveTrend (`wt2 = ta.sma(wt1,6)`, L228) that is **separate from Cipher B's** WT. They
  render as yellow triangles — a live referent hazard sitting next to the yellow q5 line. Untested.

**16 alertconditions** (L407-423), the only reliable naming surface in this indicator:
`Crossover`, `Crossunder`, `Long` (any of the four tiers), **`Entry Zone` = `crossunder(Quotient5, -0.9)`**,
`Break Resistance`, `Break Support`, `Crossover - Market Low`, `Crossunder - Market High`,
`Crossover With Pressure` (`wt2<=20`), `Crossunder With Pressure` (`wt2>=80`), `Continuation`,
`Orange - Overbought`, `Red - Overbought`, `Bounce down`, `Bounce up`, `Short`.

- **`Entry Zone` is q5 hitting its FLOOR, and it has never been tested** despite q5 carrying more
  register work than any other series in this indicator. #147 measured q5 as ceiling-pinned ~68% of
  bars, so a floor crossunder is the rare tail — exactly the shape #147 argues is worth testing.
- Also present and never documented here: **5 blue fib `hline`s** at 84/64/50/36/18 (`showfib`,
  L62-66); **2 `barcolor` rules** (L400 purple `drag>=dragno`, white `Quotient3<=-0.9`, yellow
  `Quotient1<=-0.9`; L401 pump colours); and **LuxAlgo support/resistance break lines** —
  `Resistance` (red) plus **two plots both titled `Support`** (L295 silver, L296 blue) — all off by
  default via `toggleBreaks`.

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


**LIVE TV SIGNAL INVENTORY — 22 emitting calls (`vmc-cipher-a-ribbon.pine`, 151 lines).**

| # | Title (TV) | Var | Colour | Line | Alert? | Status here |
|---|---|---|---|---|---|---|
| 1-6 | `EMA 3` … `EMA 8` (the ribbon) | ema3-ema8 | ribbon | 121-126 | no | direction = `ema8 < ema2` (above) |
| 7-8 | ribbon fills | — | `#1573d4` / `#363a45` | 128-129 | no | cosmetic |
| 9 | `Long EMA Signal` (the "green dot") | `longEma` | `#00ff00` | 133 | **yes** | real + significant nested (#77), trade-blocked (#78) |
| 10 | **`Short EMA Signal`** | `shortEma` | `#ff0000` | 134 | **NO** | **untested — and absent from this card until 2026-08-19** |
| 11 | `Red cross` | `redCross` | `#ff0000` | 135 | yes | strongest Cipher A nested result (#77), still blocked (#78/#79) |
| 12 | `Blue Triangle` | `blueTriangle` | `#0064ff` | 136 | yes | null (#77) |
| 13 | `Red Diamond` | `redDiamond` | `#ff0000` | 137 | yes | null (#77) |
| 14 | `Bull candle` | `bullCandle` | `color.yellow` | 138 | **NO** | real, significant (#71), trade-blocked (#74) |
| 15 | `Blood Diamond` | `bloodDiamond` | `#ff0000` | 139 | yes | too rare to test (#77) |
| 16 | `Yellow Cross` | `yellowCross` | `color.yellow` | 140 | yes | too rare to test (#77) |

- **`Short EMA Signal` (L134) is the direct bearish counterpart of the `Long EMA Signal` this house
  HAS tested, and it has never been evaluated.** The nested-confirmation battery (#77) covered seven
  signals and this was not one of them. Given that "do we have a reliable short signal" is an open
  question in this project, that is a concrete, cheap gap to close.
- **Only 6 of the 8 shapes have alerts.** `shortEma` and `bullCandle` emit no `alertcondition` — and
  `bullCandle` is the one with a real significance result, so it cannot be alerted on live without
  editing the source.
- Two shapes are yellow (`Bull candle`, `Yellow Cross`) and three share `#ff0000` (`Red cross`,
  `Red Diamond`, `Blood Diamond`) — **colour alone does not identify a Cipher A signal.**

### 5. VuManChu B Divergences (Cipher B) — `pine/vmc-cipher-b-divergences.pine`

- Full battery available live: WT1/WT2 + VWAP spread, RSI, MFI, Stoch K/D, Schaff Trend Cycle, 4
  divergence families (WT regular + WT 2nd-range, RSI, Stoch), buy/sell circles, the GOLD buy
  circle, Sommi higher-TF flags/diamonds.
- **Correction, 2026-08-11/13: this is no longer true for WT2.** WT2 hitting an extreme
  (overbought/oversold fractal pivot, whether or not a full 2-point divergence ever confirms —
  `computeWtExtremeFractals`, added 2026-08-11 to `vmc-cipher-b/calc.js`) is the anchor for
  **Strategy G**, the strongest, most rigorously validated cross-indicator construction in this
  entire project — see the box above and `significance-register.md` #106-125. 73-84% of these
  extreme anchors go on to confirm a full divergence within ~20-25 bars, and the anchor ALONE
  (before waiting for confirmation) is what the tradeable construction is built on — waiting for
  the full divergence to print is systematically late.
- **CORRECTION 2026-08-19: there is no "gold warning circle".** `wtGoldBuy` (L403) is a BULLISH
  confluence signal — source title `Gold  buy gold circle`, alert `GOLD Buy (Big GOLDEN circle)` —
  requiring a WT or RSI bull divergence plus WT oversold. This card called it a warning for months.
  It has never been tested here either way.
- Everything else in this card (RSI/MFI/Stoch divergence families, buy/sell circles, Sommi
  flags/diamonds, the GOLD buy circle) remains **supporting context, never a sole trigger** — no
  independent significance test behind any of those specifically. Don't extend WT2's validated
  status to the rest of the indicator by association.


**LIVE TV SIGNAL INVENTORY — 46 emitting calls (`vmc-cipher-b-divergences.pine`, 523 lines).**
The widest surface in the stack, grouped by pane role:

| Group | Signals | Lines | Status here |
|---|---|---|---|
| Oscillators | zero line, **WT1** (blue), **WT2** (purple), WT VWAP, RSI, RSI+MFI area (the `-95`/`-99` band fill) | 414-436, 449 | WT2 extremes anchor Strategy G (#106-125); **MFI confirmed independent and directionally useful on three instruments (#181/#186)** |
| Stochastic | `stochK` / `stochD` + fill | 459-462 | context only |
| Schaff | `Schaff Trend Cycle 1` / `Schaff Trend Cycle 2` | 469-470 | dose-response runs INVERTED to stated logic (#58); construction **closed** (#186) |
| Levels | OB level 2/3, OS level 2 | 479-483 | context |
| Divergence dots | WT bear/bull, **WT 2nd-range bear/bull (`_add`)**, RSI bear/bull, Stoch bear/bull | 441-446, 452-453, 465-466 | WT regular tested; **the `_add` 2nd-range pair, the RSI pair and the Stoch pair are all untested** |
| Circles | buy (green `-107`), sell (red `105`), buy div (`-106`), sell div (`106`), **`Gold  buy gold circle`** (orange `-106`) | 495-503 | buy/sell used in the #38 multi-TF stack; **GOLD buy untested** |
| Sommi | higher-TF flags (pink bear `108` / light-blue bull `-108`), diamonds, Sommi VWAP EMA (yellow) | 486-492 | **all untested** |

**9 alertconditions** (L511-521): `Buy`, `Buy Div`, **`GOLD Buy (Big GOLDEN circle)`**, Sommi bullish
(flag or diamond), WT cross up / Sommi bearish, `Sell`, `Sell Div`, WT cross down.

- **There is no gold SELL.** The gold construction is bullish-only and asymmetric — worth knowing
  before anyone reaches for it as a two-sided signal.
- **The `_add` divergence family (L445-446) is a genuinely separate second-range WT divergence** with
  its own fractal pair and its own colours, not a redraw of the primary pair. Untested here.
- `darkMode` forces a black `bgcolor` (L413), so this pane does not follow the chart theme.

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

**LIVE TV SIGNAL INVENTORY — 13 emitting calls + a 22-cell table (`ml-adaptive-supertrend-algoalpha.pine`, 135 lines).**

| # | Signal | Kind | Line | Status here |
|---|---|---|---|---|
| 1-2 | SuperTrend band, up (green) / down (red) | `plot` | 91-92 | flips are the tradeable signal — **not a standalone edge** (above) |
| 3-5 | body-middle plot + 2 gradient fills | `plot`/`fill` | 93-95 | cosmetic |
| 6-7 | flip markers (crossunder / crossover of `dir`) | `plotshape` | 96-97 | same event as the alerts below |
| 8-9 | bearish / bullish flip, `barstate.isconfirmed` | alert | 130-131 | tested — nested confirmation real (#72), trade-blocked (#73) |
| 10-12 | **volatility-regime transition into cluster 0 / 1 / 2** | alert | 132-134 | **untested as EVENTS.** The regime label is used as CONTEXT here; its transitions have never been evaluated as signals in their own right |
| 13 | byte-identical duplicate of #12 | alert | 135 | **SOURCE BUG** |
| — | on-chart K-means stats table (centroids + cluster sizes) | `table.cell` ×22 | — | readable via `data_get_pine_tables`; **never extracted here** |

- **SOURCE BUG: L134 and L135 are byte-identical alertconditions** (`cluster == 2 and cluster[1] != 2
  and barstate.isconfirmed`). Cluster 2 is therefore listed twice in the alert dropdown; wiring
  regime alerts naively will double-fire on that regime.
- The K-means centroid table is live-readable and never has been read here. It exposes the actual ATR
  centroids and cluster populations — the only direct view into whether the regime labelling is
  stable across a rebuild, which matters because every regime-split finding assumes it is.


### 7. ICT Concepts [LuxAlgo] — `pine/ict-concepts-luxalgo.pine`

> **NEW CARD, 2026-08-19. This indicator had NO card at all, despite being the source behind every
> liquidity, order-block, MSS and FVG finding from #143 onward.** 1,144 lines, the largest source in
> the stack. That documentation gap is a direct cause of the #185 "yellow zone marker" still being
> unresolved — there was nothing to look it up in.

- **Purely a drawing indicator: ZERO `alertcondition`, zero `alert()`.** Everything it produces is a
  drawing object — 22 `line.new`, 9 `box.new`, 8 `label.new`, 21 `bgcolor` — so the ONLY live path is
  `data_get_pine_lines` / `data_get_pine_boxes` / `data_get_pine_labels` with a `study_filter`.
  **Nothing in this indicator can be alerted on without editing the source.**
- **Box colours are packed ABGR, not ARGB** (the same trap as SMC, #152) — decode accordingly.

**Nine feature groups, with the source's own default colours:**

| Group | Signals | Default colours | On by default | Ported here |
|---|---|---|---|---|
| **Market Structures** | `MSS` (what we call CHoCH, #185), `BOS`, swing `len` | bullish `#00e6a1` green, bearish `#e60400` red — **the same pair for BOTH MSS and BOS** | yes | yes — `smc/structure_events` |
| **Order Blocks** | last N bullish / bearish OB **plus BREAK colours** | bull `#3e89fa` blue, **bull break `#4785f9` @85**, bear `#FF3131` red, **bear break `#f9ff57` @85 (yellow)** | yes | yes |
| **Liquidity** | buyside / sellside pools, `margin` (ATR divisor), # visible boxes | **buyside `#fa451c` orange-red, sellside `#1ce4fa` cyan** | yes | yes — `ict/liquidity.js`, verified live to 0.06% |
| **Fair Value Gaps** | FVG or IFVG (selectable), Balance Price Range | bull `#00e676` green, **bull break `#808000` olive**, bear `#ff5252`, bear break `#FF0000` | yes | partial |
| **NWOG/NDOG** | New Week / New Day Opening Gap | NWOG `#ff5252`+`#b2b5be`, NDOG `#ff9800`+`#4dd0e1` | NWOG yes, NDOG **no** | **no — untested** |
| **Volume Imbalance** | VI boxes | `#06b2d0` cyan | yes | **no — untested** |
| **Displacement** | displacement legs | — | **no** | **no — untested** |
| **Fibonacci** | retracement between last FVG / BPR / OB / Liq / VI / NWOG | — | **no** (`NONE`) | **no** |
| **Killzones** | NY `0700-0900`, London open `0700-1000`, London close `1500-1700`, Asia `1000-1400` | ny `#ff5d00`, lo `#00bcd4`, lc `#2157f3`, asia `#e91e63`, all @93 | **no** | **no — untested** |

- **`MSS` here is the bullish/bearish CHoCH**, bound in `REFERENTS.md` from #185. This indicator uses
  ICT vocabulary ("MSS") where the SMC indicator uses SMC vocabulary ("CHoCH") for the same event
  class. They are separate indicators with separate pivot lengths, so **do not assume their events
  coincide bar-for-bar** — that is an empirical question nobody has checked.
- **The "yellow zone marker" candidates live here.** The only yellow-family defaults in the entire
  source are the **bearish-OB break `#f9ff57`** and the **bullish-FVG break `#808000`** (olive). Both
  are BREAK / polarity-change colours — the "becomes the opposite of what it was" behaviour iapaulo
  described. Consistent with #185, **but not sufficient to bind the referent**; it still needs a live
  read. Left UNRESOLVED in `REFERENTS.md` rather than guessed.
- `showLabels` ("Show Historical Polarity Changes") is **off by default** — the breaker/polarity
  labels exist but are not drawn unless enabled. Turn it on before trying to resolve any
  polarity-change referent live.
- **Killzones are off by default and completely untested.** Four session windows with explicit times,
  already implemented and free to read. **Nothing in the register conditions on time-of-day at all** —
  this is the single cheapest untouched conditioning variable in the stack.
