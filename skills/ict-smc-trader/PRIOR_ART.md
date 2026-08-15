# Prior Art Inventory — `tradingview-mcp-jackson`

Compiled 2026-07-26, Phase 0 of the `ict-smc-trader` skill commission. Every row below was read
fresh from the repo this pass (not recalled from memory of an earlier session) unless marked
otherwise. Significance labels are the six defined in the commission:

- **descriptive-significant** — pattern real under our tests; not yet tradeable
- **trade-construction-blocked** — signal real; our trade rule loses
- **falsified** — narrative failed our significance tests
- **engineering-complete** — pipeline/reliability; not an edge claim
- **stub / outdated** — exists but superseded or too thin for the board
- **unknown / untested**

Nothing here is hallucinated. Where a claim couldn't be verified against a real file or a real
result JSON, it's marked `missing` rather than guessed.

---

## 1. Docs / policy

| Artifact | What it is | Significance label | Must enter skill as… | Must NOT claim… |
|---|---|---|---|---|
| `ARCHITECTURE.md` | Living design doc, §1–10 + changelog. Source of truth for everything below. | engineering-complete | The skill's own footnotes should point back to specific §s, not restate history | That reading this skill substitutes for reading §6/§9/§10 when precision is needed |
| `rules.json` | **Live, active** advisory config. Watchlist `["COINBASE:BIPZ2030"]`, `default_timeframe: "240"`, `supertrend_proxy` mapping, generic `bias_criteria` ("Ribbon direction," "20 EMA," "RSI below 60") | **stub / outdated** | The *current* thin state, explicitly — bias_criteria doesn't reference any of the 5-indicator/8-TF/signal-bus work built since. `decision-policy.md` defines the *target* policy this should grow into, not a rewrite of the file itself | That `rules.json` already reflects the house stack — it doesn't, and the skill must say so every time it's consulted |
| `rules.example.json` | Template, near-identical to `rules.json` minus the Coinbase-specific watchlist/proxy | stub / outdated | Background only | Nothing — it's a template, not a finding |
| `CLAUDE.md` | Pure MCP tool decision-tree (which of ~68 tools for which task). No strategy/grammar content. | engineering-complete | Reference for tool names only, if the skill needs to call out a specific extraction tool | No overlap with decision-policy — this file has zero trading logic |
| `RESEARCH.md` | Meta-research notes on the MCP *project itself* (context management, agent latency, tool granularity) | engineering-complete | Not cited in the trading skill at all | Not a source of trading findings |
| `skills/chart-analysis`, `skills/strategy-report`, `skills/multi-symbol-scan`, `skills/replay-practice`, `skills/pine-develop` | Five existing project skills. All are mechanical MCP-tool workflows (which tools, what order) — zero discretionary grammar, zero decision policy, zero reference to the 5-indicator stack or signal-bus findings. | engineering-complete | No overlap — `ict-smc-trader` owns grammar/policy, these own tool sequencing. Safe to coexist, nothing to merge or deprecate | That these skills already provide MTF bias grading — they don't attempt it |

---

## 2. Pine sources (canonical indicator behavior)

| Artifact | What it is | Significance label | Must enter skill as… | Must NOT claim… |
|---|---|---|---|---|
| `pine/smart-money-concepts-luxalgo.pine` | LuxAlgo SMC, CC BY-NC-SA. Full source obtained and read twice this project (initial pass + the deep §10 signal-bus pass). | engineering-complete (source + live extraction + full offline reimplementation) | The canonical reference for `grammar.md` — colors, BOS/CHoCH mechanics, order block anchoring, EQH/EQL threshold logic, all confirmed from source, not blog lore | That the live chart's SMC labels currently expose direction reliably — see §3 below, they don't |
| `pine/divergence-for-many-relevance-gated.pine` | LonesomeTheBlue's indicator, "Commander default profile" (prd=10, showlimit=3, 4 of 11 indicators enabled: MACD/MACD Hist/RSI/Stoch). Fully reimplemented. | engineering-complete | Canonical reference for promoted-zone mechanics (ATR dedup, 200-bar expiry, capacity eviction) | That hidden divergence contributes to zone promotion — confirmed it does not, under Commander defaults |
| `pine/boom-hunter-pro.pine` | veryfid's indicator, CC BY-NC-SA. Source obtained; live extractor (`signal-grid.js`) updated; **signal-bus reimplementation built 2026-08-09** (`scripts/signal-bus/boom-hunter/`, all 8 ladder timeframes, including the "dead code" enter/enter2/enter4 and a not-from-source bearish_continuation mirror). | engineering-complete (live extraction + full offline reimplementation + significance-tested, see significance-register.md #60/#60a/#61) | Live-readable fields only: `Long gray/yellow/blue/Lime`, `quotient_1/quotient_2`, `momentum_direction`. `enter4` graduated to a 5th wired Long tier 2026-08-09; `enter2`/`enter`/short side remain untested-for-live-extraction | That Boom Hunter's Long tiers should be scored by raw identity (Lime>blue/yellow>gray) — #60 found lime/blue/yellow statistically indistinguishable; decision-policy.md's weighting was rewritten accordingly |
| `pine/vmc-cipher-a-ribbon.pine` | Full source. `ribbonDir = ema8 < ema2` confirmed and fixed (was a stricter, wrong, guessed monotonic-stack heuristic). | engineering-complete (formula verified against live non-monotonic data) | The ribbon direction rule, exactly as coded — not a general "8 EMA stack" heuristic | That ribbon direction has been backtested for edge — it hasn't; this is a verified *extraction*, not a *finding* |
| `pine/vmc-cipher-b-divergences.pine` | Full source. Extractor pulls the whole battery: WT1/WT2/VWAP spread, MFI, RSI, Stoch K/D, Schaff TC, 4 divergence families, buy/sell circles, gold warning, Sommi flags/diamonds. | engineering-complete (extraction only) | Full field list in `house-stack.md`; treat as supporting context layer, not a standalone signal — no independent backtest exists | That any individual Cipher B sub-signal has been tested for predictive value |
| `pine/ml-adaptive-supertrend-algoalpha.pine` | AlgoAlpha K-Means adaptive SuperTrend. Independently reimplemented in JS (`scripts/lib/adaptive-supertrend.js`), used both live (headless monitor) and in the full backtest lab (§6). | engineering-complete, and the **only** indicator with real backtest history | The most load-bearing indicator in the stack — but see §4 below, its backtest results did not clear costed + multiple-testing-corrected significance as a standalone edge | That SuperTrend flips are a proven edge on their own — the backtest program's own headline conclusion is that nothing currently clears that bar |

---

## 2a. Wider-literature context (ARCHITECTURE.md §7 — added on audit, initially missed in Phase 0)

Separate from every house-specific test above: ARCHITECTURE.md §7 documents public-literature
research on the underlying methodologies, done 2026-07-24, before any of this house's own
signal-bus testing existed. Worth carrying forward because it bears on how confidently the skill
should ever speak about ICT/SMC *in general*, independent of our own results:

| Finding | Significance label | Must enter skill as… |
|---|---|---|
| AlgoAlpha's specific Adaptive SuperTrend indicator: no published validation exists anywhere (checked TradingView script page, a derivative strategy port, general search) | unknown/untested (absence of external data) | Background — matches this house's own finding that nothing clears a real edge yet |
| Classic (non-ML) SuperTrend: real academic parameter research exists (arXiv:2405.14262, Bayesian-optimized ATR/multiplier across 5 assets) — headline finding is that optimal parameters vary sharply by asset, and blind optimization can make results *worse* (Infosys: −28%) | descriptive-significant (as literature, not as a house finding) | A reason for skepticism toward any universal "best settings" claim for BIPZ specifically |
| ICT/SMC methodology broadly (order blocks, BOS/CHoCH, liquidity, FVG): **genuine, unresolved controversy in public literature**, not just an absence of data. A skeptical critique argues SMC/ICT is close to unfalsifiable by design (a failed application gets blamed on misapplication, not the framework) and ran a 5-million-path Monte Carlo simulation of pure-chance trading that produced outcomes exceeding $1M on variance alone in 15 paths — offered as an explanation for why "ICT success stories" exist without implying real edge. Community-reported win rates (50–65%, PF>1.5) for specific SMC rule sets exist but are forum-level claims, not peer-reviewed. Academic literature on SMC/ICT specifically is sparse. | **contested / unknown, not merely under-researched** | State plainly, especially when a user asks "does ICT/SMC actually work": this is genuinely disputed in the outside literature, before any house-specific result is even considered — the most epistemically unsettled indicator family in the whole stack |

Sources cited in ARCHITECTURE.md §7: arXiv:2405.14262 (SuperTrend); "Dumb Money Concepts and Stat
Test Limitations" (Sentient Trading Society, Medium) for the SMC/ICT critique; arXiv:1212.4890
("Bollinger Bands Thirty Years Later") for the Bollinger research, not house-stack-specific.

---

## 3. Live extraction / reliability (`scripts/signal-grid.js` + `src/core/`)

| Artifact | What it is | Significance label | Must enter skill as… | Must NOT claim… |
|---|---|---|---|---|
| `signal-grid.js` TIMEFRAMES ladder | **Still 5 timeframes: 15m/1H/4H/1D/1W.** Does not include 3H/2H/5m. | **stub / outdated** | Explicit gap: the live sweep tool has not been updated to the corrected 8-TF ladder (W,D,4H,3H,2H,1H,15m,5m) established for the signal-bus work. `decision-policy.md`'s TF ladder is the target; this file hasn't caught up to it yet | That a live `signal-grid.js` sweep already covers the full 8-TF board — it covers 5 of 8 |
| `extractRibbon` (Cipher A) | Live pull of 8 EMAs + fired signals, using the corrected `ribbonDirection` formula | engineering-complete | Trustworthy as-is for ribbon direction | — |
| `extractCipherB` | Full battery pull, `isFiring()`/`findVal()` pattern | engineering-complete | Trustworthy as-is | — |
| `extractBoomHunter` | Quotient 1/2, 4 unique-title Long signals, `exit_warning_ambiguous`/`break_ambiguous` explicitly named as such | engineering-complete for what it reports; **unknown/untested** for the ambiguous fields | Long gray/yellow/blue/Lime are safe; Quotient1/2 mapping is an *inference* about TV's duplicate-plot-title resolution, never verified against live UI; `break_ambiguous` most likely means bullish continuation, **not** the short setup (`senter3`) its name implies | That "Break" firing means a short signal — the source-order analysis says the opposite, and it's still unverified either way |
| `extractStructure` (SMC, live) | Returns raw recent labels only — **does not decode BOS/CHoCH direction.** | **stub / outdated, known unfixed bug** | Explicit standing warning: live SMC structure reads are direction-blind at the label-text level; direction must be inferred from price context (which pivot, high or low, was crossed) exactly as ARCHITECTURE.md §3 describes. The offline `scripts/signal-bus/smc/calc.js` **solved** this (tracks trend bias explicitly) but that fix was never ported back into the live extractor | That live SMC structure reads reliably show bullish/bearish — they do not, without manual price-context cross-check |
| Order block color decoding (ABGR, not ARGB) | Resolved and confirmed programmatically (`#3179f5`/`#f77c80` internal, `#1848cc`/`#b22833` swing) | engineering-complete offline; **stub / outdated live** | The confirmed color table lives in `grammar.md`; note it is **not wired into `signal-grid.js`'s live extraction** (still just raw box zones, no bias field) | That the live tool surfaces order-block bias automatically — it doesn't yet |
| `extractDivergence` (Divergence-for-Many, live) | Only pulls raw `horizontal_levels` | **stub / outdated** | None of the promoted-zone lifecycle, touch history, or cross-TF confluence richness discovered in §9 is available live | That live divergence reads carry any confluence information — they don't; confluence is an offline-only computation right now |
| Data Window hidden-toggle bug | Self-healing fix (`ensureDataWindowVisible()`, `getStudyValuesEnsured()`) | engineering-complete | Background only | — |
| Bitstamp proxy for independent SuperTrend | `COINBASE:BIPZ2030` → `BTCUSD` spot, because Bitstamp has no Coinbase Derivatives listing | engineering-complete, but a **standing accuracy caveat, not resolved away** | Every SuperTrend reading in a brief must carry `[via BTCUSD proxy]` | That the SuperTrend reading is exact for the traded instrument — it's a close-tracking proxy, not the real contract |
| Multi-pane parallelism | Tested and closed: not viable (plan-capped at 2 panes, no real concurrent reads) | engineering-complete (closed question) | Background only — explains why the sweep is sequential | That a faster multi-pane sweep is available — it was tested and rejected |

---

## 4. Signal buses / labs (highest priority for "significance")

### `scripts/signal-bus/divergence-for-many/` — ARCHITECTURE.md §9

| Finding | Significance label | Must enter skill as… | Must NOT claim… |
|---|---|---|---|
| Hold rate by timeframe, ~50–55%, stable band from D to 5m (post touch-detection-bug-fix) | descriptive-significant | A baseline reference number in `significance-register.md`; not a trading signal by itself | That any single timeframe's hold rate is "better" — the band is deliberately described as stable, not ranked |
| Support (bullish zone) holds more than resistance (bearish zone), corrected number smaller than an earlier buggy read | descriptive-significant | Directional footnote — consistent with BTC's secular uptrend over the tested window, not assumed to hold in all regimes | That this generalizes to a down-trending regime — untested |
| Polarity-flip retest (level tested from the side opposite its creation) holds less than a fresh approach | descriptive-significant | A real, distinct pattern — a level that already broke and is being retested from the far side is weaker, not equally reliable | — |
| Confluence-vs-hold-rate gradient: 53.4% (isolated) → 60.6% (3-way), **p=0.0002 (correlation) / p=0.0001 (gap)**, 50,000-iteration zone-level permutation test | **descriptive-significant** | The core weighting justification for cross-TF confluence in `decision-policy.md` — real, tested at the correct unit of analysis (zones, not touches) | That this is tradeable — **no cost/capacity test has been run on this finding** (unlike SMC's, below, which was tested and failed). Do not imply it's in the same state as the SMC result |
| Indicator-sweep (6 disabled indicators: CCI, Momentum, OBV, VW-MACD, CMF, MFI) | **unknown / untested (hypothesis only)** | Individual additions swing hold rate ±0.1–1.2pts, noise-level, inconsistent direction across timeframes. "All 10 enabled, threshold unchanged" showed a modest, consistent lead (+1.5/+2.1pts) but **16 comparisons were run with zero multiple-testing correction** | That enabling more indicators is validated — it is explicitly flagged as an untested lead, not a recommendation |

### `scripts/signal-bus/smc/` — ARCHITECTURE.md §10

| Finding | Significance label | Must enter skill as… | Must NOT claim… |
|---|---|---|---|
| Structure (BOS/CHoCH, internal+swing), EQH/EQL, order-block reimplementation, verified against real historical price levels (Dec 2024 $100k run, Jan 2018 crash) | engineering-complete | The computational reference for what "confluence degree" and "hold rate" mean in this house's usage | — |
| Order-block confluence-vs-hold-rate: 34.7% (isolated) → 68.0% (confluence=8), **p<0.00001** (real correlation never approached by 200,000-iteration null) | **descriptive-significant — the strongest-tested classification result in the whole project** | The primary justification for weighting cross-TF/cross-signal confluence in scoring. Note explicitly: confluence pool is dense (68,781 structure events alone), so ~97% of order blocks show *some* confluence — the informative signal is **degree** (1–8), not presence | That 97% "some confluence" means confluence is common/unremarkable — the gradient by *degree* is what's real |
| Order-block confluence **cost/capacity-tested**: real trades constructed from touch data, run through the confirmed Coinbase derivatives cost model | **trade-construction-blocked** | Negative gross P&L in *every* confluence bucket, including the best one (high confluence: 53.6% win rate, **-0.78x gross, before any fees**). Diagnosed: avg_loss runs 1.7–2.8x avg_win because this trade rule caps wins at "zone just cleared" while losses ride the full zone width to the boundary stop. **This is a trade-construction failure, not primarily a cost failure** (costs make it modestly worse, -0.78x→-0.90x, not decisively) | That the confluence finding is false — the classification is still real (see row above). Do not conflate "our exit rule loses money" with "the pattern isn't real." A different exit design (symmetric R-multiple, ride to next opposing zone) is an untested next step, not assumed to fix it |
| EQH/EQL liquidity-sweep → reversal rate | **FALSIFIED** | ~81% aggregate reversal-after-sweep looked like the classic ICT stop-hunt pattern, consistent across all 8 timeframes. **Tested against a random-level baseline (3,000-iteration permutation, corrected after an initial test-construction bug) — real rate sits BELOW the entire null range (81.15% vs. null [83.81%, 85.98%]), p=1.0000.** Arbitrary price-level crossings reverse *more* reliably than genuine liquidity sweeps, not less | **Do not teach "liquidity sweep precedes reversal" as edge in this house's grammar.** This is the single most important negative result for the skill to encode as a rule, not a footnote — see the commission's explicit instruction |
| Internal vs. swing order block reliability split (internal ~56–57% hold, swing ~50–54%) | unknown / untested (observational only) | Reportable as a descriptive note; **not independently significance-tested** the way the confluence gradient was — don't imply equal evidentiary weight | That this split has been proven — only the confluence-vs-hold-rate claim received the formal permutation test |

**Results JSON actually present** (`scripts/signal-bus/smc/results/`): `confluence_backtest_combined_2026-07-26T15-04-00-732Z.json` — the trade-construction-blocked finding above, confirmed on disk, not just in commit messages.

---

## 5. Backtest lab (`scripts/backtest/`) — ARCHITECTURE.md §6

| Finding | Significance label | Must enter skill as… | Must NOT claim… |
|---|---|---|---|
| SuperTrend flip, long-short, 4H: real cost model applied (confirmed Coinbase derivatives tier, both funding-sign assumptions) | Net-profitable at real costs (1.45x–4.19x depending on funding-sign assumption) | Background context only | — |
| Same finding, multiple-testing corrected across the 5 variants actually tested this session (Bonferroni/Holm/Benjamini-Hochberg) | **falsified as a standalone significant claim** (downgraded Supported→Hypothesized per epistemology.md) | **Headline honesty anchor: nothing currently clears "real, costed, family-wise-corrected edge" for the SuperTrend program.** Raw p=0.022 fails Bonferroni's n=5 threshold (p<0.01) | That SuperTrend flips are a validated edge — explicitly not, and the skill must not contradict this without citing new evidence |
| Bollinger Bands as SuperTrend trend-filter | falsified / negative | Redundant with SuperTrend's own trend logic — filters out ~0 trades on long-only, changes nothing meaningful | That BB adds value as a same-direction filter here |
| Bollinger Bands as mean-reversion trigger (SuperTrend-gated) | falsified / negative | Actively harmful — worse than random baseline, p=0.859 | That mean-reversion-at-the-bands works when SuperTrend-gated — tested and it lost |
| Cost model (confirmed Coinbase Advanced 1 tier: 0.070%/0.065% taker/maker; hourly funding, signed-vs-pessimistic modes) | engineering-complete | The real, confirmed fee reference for any future cost/capacity test in this house — reuse `scripts/backtest/lib/costs.js`, do not re-derive | That funding *magnitude* is confirmed — only the fee tier and the funding *mechanism* (hourly, basis-driven) are confirmed; funding magnitude remains a cross-exchange placeholder |
| Multiple-testing correction framework (`scripts/backtest/lib/multiple-testing.js`) | engineering-complete | Reusable machinery — the same discipline should gate any new house-stack claim before it's called significant | — |

---

## 6. Personal skills already installed (not touched, not rewritten)

| Artifact | What it is | Note |
|---|---|---|
| `~/.claude/skills/institutional-quant/` (+ Cursor twin) | Evidence hierarchy, research protocol, epistemology, output contracts, empirical canon, curriculum map. Owns proof gates and claim-labeling vocabulary (the six labels used throughout this document are lifted directly from its `epistemology.md` conventions, generalized per the commission). | Invoked in Phase 4 as auditor. Not modified. `ict-smc-trader` explicitly does not redefine evidence tiers or claim labels — it inherits them and applies them to discretionary/SMC-specific content. |

---

## 7. Summary — what this means for the skill

1. **`rules.json` is a stub.** The skill must say so plainly every time it's consulted, and `decision-policy.md` must define the *target* state, not pretend the file already reflects the house stack.
2. **The live tool (`signal-grid.js`) lags the offline signal-bus work on two fronts**: the 5-TF ladder (should be 8) and SMC direction-blindness (solved offline, not ported live). The skill must warn about both rather than assume live reads are as rich as the analytics pages.
3. **Exactly one finding is fully tested end-to-end and survives** (real classification → real significance test → real cost/capacity test → still real): the SMC order-block confluence-degree-vs-hold-rate gradient is descriptive-significant, but its most obvious trade construction is trade-construction-blocked. These are two different facts and the skill must never merge them into one verdict.
4. **Exactly one finding was falsified outright** after looking dramatic on first pass: the EQH/EQL liquidity-sweep reversal narrative. This must be an explicit rule in `decision-policy.md` ("do not weight a liquidity sweep as a reversal signal"), not just a historical footnote.
5. **No finding in this entire inventory currently constitutes a proven, costed, statistically-corrected trading edge.** The skill's `SKILL.md` persona must reflect that honestly at the top level, matching institutional-quant's own hard refusal against certainty language.
