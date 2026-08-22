# SOURCE EXTRACT — Photon Trading, MTF Market Structure (part 2 of series)

**Status: UNTESTED SOURCE MATERIAL.** Every claim here is the presenter's, not this project's. Per
the `yt-transcript` skill's rule, a video claim enters as a **hypothesis** and earns status the same
way everything else does. Nothing below has been validated against our data.

Source: `https://youtu.be/iYbevTXtejc` — full transcript read (1,859 segments, ~59 min). Timestamps
cited so any rule can be checked at source. Rules restated in our own terms.

**Notable for what it does NOT contain:** no order blocks, no FVG, no premium/discount as mechanics,
no inducement. Purely structure + timeframe relationships. (Counts: weekly 52, daily 80, 4h 31,
HTF/LTF 66, swing 58, strong/weak 30, order block 0, FVG 0.)

---

## 1. The central thesis

> **"A run on a higher timeframe is a trend on a lower timeframe."** [6:07, 8:23, 13:02]

An HTF trend decomposes into alternating **runs** (impulse) and **pullbacks** — described as "the
heartbeat of the market." A trend is simply multiple runs collectively. [5:34–5:53]

Each single HTF run, viewed lower, is a **complete LTF trend** with its own HH/HL sequence.
[8:31–8:46] The LTF is therefore a **timing instrument for HTF events**, never an independent signal.

## 2. Why higher timeframes dominate — "time is power"

A weekly candle contains ~5 daily candles (FX; 7 in crypto — he notes this explicitly), ~34 4h
candles, ~120 1h candles. [2:47–3:23] The longer a level takes to form, the more order flow went into
it, so higher-timeframe levels are more prominent. [3:48–4:14]

**Analysis is always top-down**: start at the highest timeframe for the overarching trend, then drill
down for confirmation and refinement of turning points. [4:18–4:29]

## 3. The base structure model

- Bullish = successive HH/HL; the higher lows are "continuously protected." [5:12–5:25]
- The bullish expectation fails when a higher low is broken → lower low → **confirmed bearish**. [7:15–7:22]
- A high that **caused** the break (took out a strong low) becomes a **strong high** — expected to be
  protected, because of the capital required to cause the trend change. [7:27–7:38]
- Trading then occurs **within the swing range**: pull back to a strong high, target the weak low. [7:40–7:57]

## 4. Strong vs weak — the classification rule

| | Definition | Expectation |
|---|---|---|
| **Strong low** | *Caused* a BOS — price rallied from it and took out a prior high | **Protected**; "vested interest" in it holding [13:48–14:03] |
| **Weak high** | *Failed* to break structure — "failed to do its job" | **Taken** [15:29–15:32] |

**A higher low is not confirmed until a BOS occurs** — until then you don't know where it is.
[13:41–13:48] Classification is therefore strictly **retroactive**.

## 5. The single-timeframe cycle

After an HTF BOS, a pullback on that timeframe is **expected**. [8:53–9:00] Reading one chart only:
watch **internal** structure — the first minor low taken out is the earliest sign of weakness (their
"change of character"), signalling the swing run is finished while swing structure is still bullish.
[14:23–14:51]

## 6. The multi-timeframe cycle — the operating procedure

| # | Question | Rule | Cite |
|---|---|---|---|
| 1 | HTF breaks structure → new HH | Expect a pullback on that timeframe | 16:24–16:27 |
| 2 | **When does the pullback start?** | LTF switches **bearish** — takes its higher low to form a lower low. The HTF's minor low is usually a *swing* low on the LTF | 16:31–17:34 |
| 3 | During the pullback | Trade counter-trend, but the HTF higher low **should hold** — that's the invalidation boundary | 17:56–18:21 |
| 4 | **When does the HTF higher low form?** | LTF switches **bullish** — breaks its lower high to form a higher high | 18:43–19:00 |
| 5 | Entry timing | **Do not buy the LTF break.** Wait for the LTF pullback to catch its higher low — poor risk-reward otherwise | 19:02–19:14 |
| 6 | Final refinement | Drop to execution timeframe; it switches bearish to facilitate the LTF pullback, then bullish to confirm the LTF higher low | 19:16–20:16 |
| 7 | Target | The **weak high**, at minimum | 15:26–15:34 |

**The structure is explicitly recursive** — the same rule applied at each level. [19:57–20:02]

## 7. Timeframe selection — stated concretely

- His set: **4H = higher, M15 = medium, M1 = execution.** 4H and M15 are on screen ~98% of the time;
  M1 only at the final moment. [16:05–16:14, 28:56–29:03]
- **Also daily/4H**: the daily is used to anticipate when the **4H trend** will turn — a daily
  pullback is when the 4H switches bearish. [27:01–27:20]
- **Weekly/daily**: a weekly change of character corresponds to a **daily trend change**. Explicitly
  hedged — *"not a hard and fast rule."* [39:53, 40:08–41:10]
- **Guidance: pick a higher, a medium, and an execution timeframe, evenly spaced, and stick to
  them.** [28:46–28:54, 57:06–57:23]

## 8. The simplifying question

At the higher timeframe, only one question matters: **am I trading the continuation (pro-trend run)
or the pullback (counter-trend)?** The medium timeframe then confirms when the pullback starts and
when it ends. [27:22–28:09]

## 9. Risk management as stated

Targets are taken **aggressively, not swung for the fences** — because the HTF higher low can form at
any point. [57:43–57:48] Weekly/daily context is what allows pushing reward-to-risk further, by
targeting weekly and daily runs. [58:21–58:29]

## 10. Stated caveats — his own hedges

- The LTF "**doesn't have to** but a lot of the time will" switch to facilitate the HTF pullback. [17:28–17:34]
- LTF confirmation is "**not a guarantee but a good signal**." [11:36–11:38]
- The HTF minor low is "**not always** but most likely" an LTF swing low. [16:50–16:56]
- The weekly↔daily correspondence is "**not a hard and fast rule**." [39:53]

**Every core mechanic is hedged probabilistically by the presenter himself.** That is unusually
honest for the genre and it is also exactly why each needs measuring rather than adopting.

---

## Referent warnings — READ BEFORE CODING ANY OF THIS

The vocabulary collides with ours. This is the failure that cost #157 and #169.

| Their term | Their meaning | Our object | Same? |
|---|---|---|---|
| CHoCH | first minor low taken; internal pullback starting | body close flipping trend bias | **NO** |
| strong / weak high-low | caused-vs-failed-to-cause a BOS | LuxAlgo `swingTrend.bias` | **NO** |
| internal structure | minor swings inside the swing range | our `scope='internal'` (5-bar legs) | close, **unverified** |
| BOS | body close beyond a swing point | body close beyond pivot | **yes** |
| "run" | one impulse leg between pullbacks | *(no equivalent object)* | **we don't have this** |

## What is testable, ranked by value

1. ~~**Strong-low protection**~~ — **TESTED 2026-08-21 (#227): REFUTED AND INVERTED.** Strong lows are
   breached **54.9%** within 100 bars versus **52.2%** for distance-matched random levels (n=4,667
   each, **z = +2.59**) — breached *more*, not less. The clock started at the BOS bar and the control
   was distance-matched, so the usual circularity is neutralised. **The strong/weak protection premise
   does not hold in this market.** Note this does NOT bear on our regime gate, which uses the same
   words for a different claim.
2. **The pairing claim** — does an HTF CHoCH coincide with an LTF trend change? Direct co-occurrence
   measurement; #204's episode de-duplication applies.
3. ~~**The timing claim**~~ — **TESTED 2026-08-21 (#228): HOLDS.** At the LTF bearish switch,
   **66.9%** of the pullback is still ahead on his 4h/15m pairing (n=3,972) versus **51.6%** for a
   random bar (t=32.67); 56.6% on 4h/1h. **The finer LTF is materially better, validating his 16x
   ratio**, and it beats our own HTF internal break, which sits at chance (49.3%/50.0%). **Follow-ups:** false-positive
   rate measured in #229 (not a problem — 77.3% vs 52.3% random, and 0.70 switches per episode on
   4h/1h); momentum confound defeated in #230 (residual **+23.0pp** over a frequency-matched momentum
   signal, z=40.65). **Three independent controls passed. Tradeability still untested.**
4. **The recursion claim** — is an HTF run really a complete LTF trend? Measurable as HH/HL count on
   the LTF within one HTF run.

**Point of contact with our own work:** the HTF-dominance premise is the same shape as #224's
finding that every surviving construction has a **regime gate** — a higher-order state constraining a
lower-order signal. That is encouraging for the *framework*, not for any specific rule.

**Cost caution** (`market-microstructure-foundations` Module 4): retail-visible structure proxies
should be expected to deliver **less** than Osler's 4.5-point edge, not more. And #224's standing
result is that level-reaction effects here are real and are *not* edges.
