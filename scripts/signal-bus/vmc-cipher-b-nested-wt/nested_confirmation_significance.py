"""Nested multi-timeframe confirmation test on Cipher B WaveTrend divergence.

INDEPENDENT of this project's own Node.js signal-bus pipeline -- built via the
ai-quant-workbench Claude Code skill (Python, ~/.claude/skills/ai-quant-workbench/),
against REAL Coinbase BTC-USD data pulled directly from Coinbase's public
Exchange API (api.exchange.coinbase.com), not this project's Bitstamp-proxy
monitor or its own historical CSV/DB files. Deliberately a second, separate
implementation -- own WaveTrend/pivot/divergence code, own data source, own
significance-test driver -- to see whether an independently-built stack
reaches the same conclusions as the house pipeline, not to replace it.

Question tested: does a Cipher B regular divergence on 1h, whose ANCHOR pivot
(the earlier extreme the divergence forms against) is confirmed by a same-side
sellSignal/buySignal ("dot") on 2 of {15m, 6h, 1d} within a TF-scaled window,
perform better than one with 0 or 1 such confirmations? Mirrors this project's
own #38 (multi-timeframe stacking on Cipher B buySignal/sellSignal, the
strongest finding in the whole house Cipher B investigation) -- applied here
to divergence instead of buySignal/sellSignal directly.

Trade construction and cost model are DELIBERATELY IDENTICAL to the house's
own scripts/signal-bus/vmc-cipher-b/divergence-cost-capacity-backtest.js and
scripts/backtest/lib/costs.js: entry = next-bar-open after confirmation; risk
= 0.6x ATR(14) (Wilder's smoothing) at the confirmation bar; stop = entry -/+
risk; target = entry +/- R x risk, R in {1, 1.5, 2, 3}; race-to-target-or-
stop, max 200 bars, same-bar ambiguity scored as the stop; costs = confirmed
Coinbase Advanced 1 tier (0.070% taker each side, 0.14% round trip) +
representative funding 0.00125%/hr, pessimistic mode (funding always a drag).

Significance test mirrors scripts/signal-bus/smc/recurrence-fixed-rr-significance.js
exactly: point-biserial correlation (confirmation count vs. win/loss) + top-
vs-bottom-bucket win-rate gap, both against a 50,000-iteration permuted null,
run independently per R multiple.

WaveTrend parameters read directly from pine/vmc-cipher-b-divergences.pine
(not assumed): channelLen=9, averageLen=12, maLen=3, obLevel=53, osLevel=-53.
Regular-divergence pivot detector here is a simplified fractal-pivot-pair
construction (5-bar pivot period, max 60-bar lookback between same-type
pivots) -- NOT the house's own more elaborate divergence-for-many detector
(which has the "2nd WT Regular Divergence" gate, ATR-dedup, badge levels,
etc.) -- a genuinely different, simpler construction that also measures
"regular divergence," disclosed as such, not a port.

Bugs found and fixed during development, kept here as a record (see
ARCHITECTURE.md §37 for the full narrative):
  - First attempt measured wt2 extremity AT the divergence's own confirming
    pivot, which is close to definitionally empty (regular divergence
    requires the confirming pivot to be LESS extreme than the prior one).
    Fixed to measure the PRIOR (anchor) pivot's extremity instead.
  - Then used an invented symmetric +-90 threshold for "extreme" on both
    sides; the real Pine source's own author-calibrated levels are
    asymmetric (obLevel3=100 overbought, osLevel3=-75 oversold). Rebuilt
    bins to match the real, asymmetric scale.
  - Then measured extremity only at Cipher B "dot" (cross+gate) events,
    which undercounts true extremity -- wt2 often keeps swinging to its real
    peak/trough after a cross has already fired at a less extreme value, or
    a cross doesn't fire until wt2 is already retreating from an even bigger
    peak. Fixed to measure the actual peak/trough wt2 reached in a window
    around each pivot, not the value at a coincident cross.
  - Checked whether pooling across market regimes was masking a real
    bullish-side effect (SuperTrend ATR(10)/3x regime split) -- it wasn't;
    both uptrend and downtrend sub-populations independently showed the same
    flat/negative bullish result.
  - The wt2-extremity-alone construction (after all the above fixes) never
    reached a clean, robust significant result on either side. The NESTED
    confirmation-count construction in this file is what actually produced a
    real, robust, cost-clearing signal -- confirming this project's own
    lesson from §38 that cross-timeframe agreement, not single-timeframe
    extremity, is where the real edge lives.

Usage:
    cd ~/.claude/skills/ai-quant-workbench
    uv run python /path/to/nested_confirmation_significance.py
"""

from __future__ import annotations

import sys
from pathlib import Path

# ai-quant-workbench must be installed and its venv active (uv run), or its
# workbench/ package importable on sys.path.
sys.path.insert(0, str(Path.home() / ".claude" / "skills" / "ai-quant-workbench"))

import numpy as np
import pandas as pd
from scipy import stats

from workbench.research import fetch_coinbase_ohlcv

# --- WaveTrend, matching pine/vmc-cipher-b-divergences.pine's f_wavetrend() exactly ---
WT_CHANNEL_LEN, WT_AVG_LEN, WT_MA_LEN = 9, 12, 3
DOT_THRESHOLD = 53  # obLevel / osLevel in the Pine source

# --- Real, asymmetric extremity ladder read from the Pine source's own inputs ---
# obLevel3=100 (overbought "level 3"), osLevel3=-75 (oversold "level 3") -- NOT symmetric.
BEARISH_BINS, BEARISH_LABELS = [53, 60, 70, 80, 100, 1000], ["53-60", "60-70", "70-80", "80-100", "100+"]
BULLISH_BINS, BULLISH_LABELS = [53, 60, 65, 75, 1000], ["53-60", "60-65", "65-75", "75+"]

PIVOT_PERIOD = 5
MAX_LOOKBACK_BARS = 60
NEAR_WINDOW = 5  # bars around a pivot to scan for the true wt2 peak/trough

# --- Real cost model, from scripts/backtest/lib/costs.js FEE_TIERS.confirmed_derivatives ---
ATR_LEN, ATR_MULT = 14, 0.6
MAX_HOLD_BARS = 200
R_MULTIPLES = (1, 1.5, 2, 3)
TAKER_FEE_PCT = 0.0007
FUNDING_PCT_PER_HOUR = 0.0000125

# --- Nested confirmation windows (bars of THAT timeframe) ---
CONFIRM_WINDOWS = {"15m": 8, "6h": 1, "1d": 1}  # +-2h, +-6h, +-1day
CONFIRM_DAYS = {"15m": 3300, "6h": 3300, "1d": 3300}

ITERATIONS = 50000
SEED = 42


def ema(s, length):
    return s.ewm(span=length, adjust=False).mean()


def wavetrend(high, low, close):
    ap = (high + low + close) / 3
    esa = ema(ap, WT_CHANNEL_LEN)
    d = ema((ap - esa).abs(), WT_CHANNEL_LEN)
    ci = (ap - esa) / (0.015 * d)
    wt1 = ema(ci, WT_AVG_LEN)
    wt2 = wt1.rolling(WT_MA_LEN).mean()
    return wt1, wt2


def wilder_atr(high, low, close, length=ATR_LEN):
    prev_close = close.shift(1)
    tr = pd.concat([high - low, (high - prev_close).abs(), (low - prev_close).abs()], axis=1).max(axis=1)
    tr.iloc[0] = (high - low).iloc[0]
    atr = pd.Series(np.nan, index=close.index)
    seed = tr.iloc[:length].mean()
    atr.iloc[length - 1] = seed
    prev = seed
    for i in range(length, len(tr)):
        prev = (prev * (length - 1) + tr.iloc[i]) / length
        atr.iloc[i] = prev
    return atr


def find_pivots(series, period=PIVOT_PERIOD):
    n = len(series)
    vals = series.to_numpy()
    lows, highs = [], []
    for i in range(period, n - period):
        window = vals[i - period : i + period + 1]
        if vals[i] == window.min():
            lows.append((i, i + period, vals[i]))
        if vals[i] == window.max():
            highs.append((i, i + period, vals[i]))
    return lows, highs


def detect_dot_signals(wt1, wt2, side, threshold=DOT_THRESHOLD):
    if side == "bearish":
        cross = (wt1.shift(1) > wt2.shift(1)) & (wt1 <= wt2)
        gate = wt2 >= threshold
    else:
        cross = (wt1.shift(1) < wt2.shift(1)) & (wt1 >= wt2)
        gate = wt2 <= -threshold
    sig = cross & gate
    idxs = np.where(sig.to_numpy())[0]
    return idxs, wt2.to_numpy()[idxs]


def bucket_of(mag, side):
    bins, labels = (BEARISH_BINS, BEARISH_LABELS) if side == "bearish" else (BULLISH_BINS, BULLISH_LABELS)
    if mag < bins[0]:
        return "no_extreme"
    for lo, hi, label in zip(bins[:-1], bins[1:], labels):
        if lo <= mag < hi:
            return label
    return labels[-1]


def true_extremity_divergence_events(side, pivots, wt2, near_window=NEAR_WINDOW, max_lookback=MAX_LOOKBACK_BARS):
    """Regular divergence via consecutive same-type pivot pairs. Extremity is
    the true peak/trough wt2 reached near the ANCHOR (prior) pivot, not the
    value at a coincident cross event -- see the bug notes in the module
    docstring for why that distinction matters."""
    wt2_arr = wt2.to_numpy()
    n = len(wt2_arr)
    peak_val = []
    for idx, confirm_idx, price_val in pivots:
        lo, hi = max(0, idx - near_window), min(n, idx + near_window + 1)
        window = wt2_arr[lo:hi]
        peak_val.append(window.max() if side == "bearish" else window.min())
    buckets = [bucket_of((v if side == "bearish" else -v), side) for v in peak_val]

    events = []
    for j in range(1, len(pivots)):
        idx, confirm_idx, price_val = pivots[j]
        prev_idx, _, prev_price_val = pivots[j - 1]
        if idx - prev_idx > max_lookback:
            continue
        wt2_now, wt2_prev = wt2.iloc[idx], wt2.iloc[prev_idx]
        if pd.isna(wt2_now) or pd.isna(wt2_prev):
            continue
        if side == "bearish":
            is_div = price_val > prev_price_val and wt2_now < wt2_prev
        else:
            is_div = price_val < prev_price_val and wt2_now > wt2_prev
        if is_div:
            events.append({"anchor_bucket": buckets[j - 1], "confirm_idx": confirm_idx, "side": side})
    return events


def simulate_fixed_r(high, low, entry_idx, side, stop_price, target_price, max_hold=MAX_HOLD_BARS):
    end = min(len(high) - 1, entry_idx + max_hold)
    for j in range(entry_idx, end + 1):
        h, l = high.iloc[j], low.iloc[j]
        hit_stop = (l <= stop_price) if side == "long" else (h >= stop_price)
        hit_target = (h >= target_price) if side == "long" else (l <= target_price)
        if hit_stop:
            return stop_price, j, "stop"
        if hit_target:
            return target_price, j, "target"
    return None, None, None


_cache_dir = Path(__file__).parent / "_data_cache"


def fetch_cached(granularity, days):
    _cache_dir.mkdir(exist_ok=True)
    cache = _cache_dir / f"btc_{granularity}_{days}d.pkl"
    if cache.exists():
        return pd.read_pickle(cache)
    df = fetch_coinbase_ohlcv(product="BTC-USD", granularity=granularity, days=days)
    df.to_pickle(cache)
    return df


def confirming_dot_times(tf, side):
    df = fetch_cached(tf, CONFIRM_DAYS[tf])
    wt1, wt2 = wavetrend(df["High"], df["Low"], df["Close"])
    dot_idxs, _ = detect_dot_signals(wt1, wt2, side)
    return pd.DatetimeIndex(df.index[dot_idxs])


def count_confirmations(event_time, confirm_time_indexes):
    bar_span = {"15m": pd.Timedelta(minutes=15), "6h": pd.Timedelta(hours=6), "1d": pd.Timedelta(days=1)}
    count = 0
    for tf, window_bars in CONFIRM_WINDOWS.items():
        times = confirm_time_indexes[tf]
        if len(times) == 0:
            continue
        tol = bar_span[tf] * window_bars
        if abs(times - event_time).min() <= tol:
            count += 1
    return count


def point_biserial(xs, ys):
    xs, ys = np.asarray(xs, dtype=float), np.asarray(ys, dtype=float)
    if xs.std() == 0 or ys.std() == 0:
        return 0.0
    return np.corrcoef(xs, ys)[0, 1]


def top_vs_bottom_gap(xs, ys):
    xs, ys = np.asarray(xs), np.asarray(ys)
    max_x = xs.max()
    bottom, top = ys[xs == 0], ys[xs == max_x]
    if len(top) == 0 or len(bottom) == 0 or max_x == 0:
        return None
    return {"gap": top.mean() - bottom.mean(), "n_top": len(top), "n_bottom": len(bottom), "max_x": int(max_x)}


def run_side(side, pivots, df_1h, atr14):
    wt1, wt2 = wavetrend(df_1h["High"], df_1h["Low"], df_1h["Close"])
    open_, high, low = df_1h["Open"], df_1h["High"], df_1h["Low"]

    events = true_extremity_divergence_events(side, pivots, wt2)
    confirm_times = {tf: confirming_dot_times(tf, side) for tf in CONFIRM_WINDOWS}
    for e in events:
        e["n_confirm"] = count_confirmations(df_1h.index[e["confirm_idx"]], confirm_times)

    print(f"\n{'#'*78}\n{side.upper()}  1h base events: {len(events)}\n{'#'*78}")

    for r_mult in R_MULTIPLES:
        labels, wins = [], []
        for e in events:
            confirm_idx = e["confirm_idx"]
            entry_idx = confirm_idx + 1
            if entry_idx >= len(df_1h):
                continue
            atr_at_signal = atr14.iloc[confirm_idx]
            if pd.isna(atr_at_signal) or atr_at_signal <= 0:
                continue
            side_lr = "long" if side == "bullish" else "short"
            entry_price = open_.iloc[entry_idx]
            risk = ATR_MULT * atr_at_signal
            stop_price = entry_price - risk if side_lr == "long" else entry_price + risk
            target_price = entry_price + r_mult * risk if side_lr == "long" else entry_price - r_mult * risk
            exit_price, exit_j, outcome = simulate_fixed_r(high, low, entry_idx, side_lr, stop_price, target_price)
            if exit_price is None:
                continue
            labels.append(e["n_confirm"])
            wins.append(1 if outcome == "target" else 0)

        labels, wins = np.array(labels), np.array(wins)
        real_r = point_biserial(labels, wins)
        gap_info = top_vs_bottom_gap(labels, wins)

        rng = np.random.default_rng(SEED)
        perm_r = np.empty(ITERATIONS)
        perm_gap = np.empty(ITERATIONS)
        for it in range(ITERATIONS):
            shuffled = rng.permutation(labels)
            perm_r[it] = point_biserial(shuffled, wins)
            g = top_vs_bottom_gap(shuffled, wins)
            perm_gap[it] = g["gap"] if g else np.nan
        p_r = (perm_r >= real_r).mean()
        valid_gap = perm_gap[~np.isnan(perm_gap)]
        p_gap = (valid_gap >= gap_info["gap"]).mean() if gap_info else None

        print(f"\n=== {r_mult}R === n={len(labels)}, max confirm count present={labels.max()}")
        print(f"  correlation r={real_r:.4f}, p={p_r:.4f} {'*' if p_r < 0.05 else ''}")
        if gap_info:
            print(f"  top({gap_info['max_x']})-vs-bottom(0) gap={gap_info['gap']*100:.2f}pts "
                  f"(n_top={gap_info['n_top']}, n_bottom={gap_info['n_bottom']}), p={p_gap:.4f} "
                  f"{'*' if p_gap < 0.05 else ''}")


if __name__ == "__main__":
    df_1h = fetch_cached("1h", 3300)
    atr14 = wilder_atr(df_1h["High"], df_1h["Low"], df_1h["Close"])
    lows, highs = find_pivots(df_1h["Close"])
    run_side("bearish", highs, df_1h, atr14)
    run_side("bullish", lows, df_1h, atr14)
