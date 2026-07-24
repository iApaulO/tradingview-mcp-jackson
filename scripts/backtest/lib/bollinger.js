// Standard Bollinger Bands: N-period SMA basis +/- K standard deviations, on close price.
// Classic defaults (20, 2) -- not tuned, not claimed optimal, matching the same "use the
// textbook default, don't hand-pick a flattering setting" posture as the SuperTrend defaults.

export function calcBollingerBands(candles, period = 20, mult = 2) {
  const n = candles.length;
  const basis = new Array(n).fill(NaN);
  const upper = new Array(n).fill(NaN);
  const lower = new Array(n).fill(NaN);

  for (let i = period - 1; i < n; i++) {
    let sum = 0;
    for (let k = i - period + 1; k <= i; k++) sum += candles[k].c;
    const mean = sum / period;

    let variance = 0;
    for (let k = i - period + 1; k <= i; k++) variance += (candles[k].c - mean) ** 2;
    const stdDev = Math.sqrt(variance / period);

    basis[i] = mean;
    upper[i] = mean + mult * stdDev;
    lower[i] = mean - mult * stdDev;
  }

  return { basis, upper, lower };
}
