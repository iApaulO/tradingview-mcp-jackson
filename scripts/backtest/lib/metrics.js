// Standard backtest metrics from a trade list (scripts/backtest/lib/simulate-trades.js output).
// Equity curve assumes full-equity compounding per trade (no fixed fractional sizing yet).

export function computeMetrics(trades) {
  if (!trades.length) {
    return { trade_count: 0, note: "no trades generated" };
  }

  const wins = trades.filter((t) => t.pnlPct > 0);
  const losses = trades.filter((t) => t.pnlPct <= 0);
  const grossProfit = wins.reduce((s, t) => s + t.pnlPct, 0);
  const grossLoss = Math.abs(losses.reduce((s, t) => s + t.pnlPct, 0));

  let equity = 1;
  const equityCurve = [equity];
  for (const t of trades) {
    equity *= 1 + t.pnlPct;
    equityCurve.push(equity);
  }

  let peak = equityCurve[0];
  let maxDrawdown = 0;
  for (const e of equityCurve) {
    if (e > peak) peak = e;
    const dd = (peak - e) / peak;
    if (dd > maxDrawdown) maxDrawdown = dd;
  }

  return {
    trade_count: trades.length,
    long_trades: trades.filter((t) => t.side === "long").length,
    short_trades: trades.filter((t) => t.side === "short").length,
    win_rate: wins.length / trades.length,
    avg_win_pct: wins.length ? grossProfit / wins.length : 0,
    avg_loss_pct: losses.length ? grossLoss / losses.length : 0,
    profit_factor: grossLoss > 0 ? grossProfit / grossLoss : wins.length ? Infinity : 0,
    net_return_pct: equity - 1,
    max_drawdown_pct: maxDrawdown,
    avg_bars_held: trades.reduce((s, t) => s + t.barsHeld, 0) / trades.length,
    final_equity_multiple: equity,
  };
}
