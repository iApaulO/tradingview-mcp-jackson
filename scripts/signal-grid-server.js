#!/usr/bin/env node
// Tiny local dashboard for scripts/signal-grid.js. Run this once, leave it open, then run
// `node scripts/signal-grid.js` in another terminal whenever you want a sweep — this page
// polls signal-grid-live.json (written incrementally, per-timeframe, by the grid script)
// and updates as each timeframe finishes. Nothing leaves your machine — plain localhost HTTP.
//
// Usage: node scripts/signal-grid-server.js [--port=4173]

import { createServer } from "http";
import { readFileSync, existsSync } from "fs";

const portArg = process.argv.find((a) => a.startsWith("--port="));
const PORT = portArg ? parseInt(portArg.split("=")[1], 10) : 4173;
const LIVE_PATH = new URL("../signal-grid-live.json", import.meta.url);

const PAGE = `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<title>Signal Grid — live</title>
<style>
  body { font-family: ui-monospace, monospace; background: #0b0e14; color: #e6e6e6; padding: 24px; }
  h1 { font-size: 16px; color: #8fb3ff; }
  #status { color: #999; margin-bottom: 16px; }
  table { border-collapse: collapse; width: 100%; margin-bottom: 24px; }
  th, td { padding: 6px 10px; border-bottom: 1px solid #2a2f3a; text-align: left; }
  th { color: #8fb3ff; }
  .bullish { color: #4caf50; }
  .bearish { color: #ff5252; }
  .mixed, .flat { color: #ffb74d; }
  .na { color: #555; }
  .bar { height: 6px; background: #2a2f3a; border-radius: 3px; overflow: hidden; margin-bottom: 8px; }
  .bar > div { height: 100%; background: #4caf50; transition: width 0.3s; }
</style>
</head>
<body>
<h1>Signal Grid — live</h1>
<div class="bar"><div id="progressbar" style="width:0%"></div></div>
<div id="status">waiting for first sweep...</div>
<div id="tables"></div>
<script>
function cls(v) {
  if (!v || v === 'n/a') return 'na';
  return v.replace('/', ' ').split(' ')[0];
}
async function tick() {
  try {
    const res = await fetch('/status');
    const data = await res.json();
    if (data.status === 'idle') {
      document.getElementById('status').textContent = 'No sweep running yet — run: node scripts/signal-grid.js';
      return;
    }
    const pct = data.total_steps ? Math.round(100 * data.completed_steps / data.total_steps) : 0;
    document.getElementById('progressbar').style.width = pct + '%';
    document.getElementById('status').textContent =
      data.status === 'done'
        ? 'Done — ' + data.completed_steps + '/' + data.total_steps + ' (finished ' + new Date(data.finished_at).toLocaleTimeString() + ')'
        : 'Running — ' + data.completed_steps + '/' + data.total_steps + (data.current ? ' (now: ' + data.current.symbol + ' ' + data.current.timeframe + ')' : '');

    let html = '';
    for (const [symbol, obj] of Object.entries(data.symbols || {})) {
      html += '<h2>' + symbol + '</h2><table><tr><th>TF</th><th>Ribbon</th><th>RSI</th><th>MFI</th><th>Stoch K/D</th><th>STC</th><th>WT</th><th>SMC latest</th><th>Div</th><th>SuperTrend</th></tr>';
      for (const [tf, row] of Object.entries(obj.timeframes || {})) {
        const cb = row.cipher_b;
        const ribbon = row.ribbon?.direction ?? 'n/a';
        const rsi = cb?.found ? cb.rsi.toFixed(1) : 'n/a';
        const mfi = cb?.found ? cb.mfi.toFixed(1) : 'n/a';
        const stoch = cb?.found ? cb.stoch_k.toFixed(0) + '/' + cb.stoch_d.toFixed(0) : 'n/a';
        const stc = cb?.found ? cb.schaff_tc.toFixed(0) : 'n/a';
        const wt = cb?.found ? cb.wt_direction : 'n/a';
        const smc = row.structure?.recent?.[0] ? (row.structure.recent[0].text + ' @ ' + row.structure.recent[0].price) : 'n/a';
        const badges = row.divergence?.active_badge_levels?.length ?? 0;
        const st = row.supertrend && !row.supertrend.error ? row.supertrend.direction : 'n/a';
        html += '<tr><td>' + tf + '</td><td class="' + cls(ribbon) + '">' + ribbon + '</td><td>' + rsi + '</td>' +
                '<td>' + mfi + '</td><td>' + stoch + '</td><td>' + stc + '</td>' +
                '<td class="' + cls(wt) + '">' + wt + '</td><td>' + smc + '</td><td>' + badges + '</td>' +
                '<td class="' + cls(st) + '">' + st + '</td></tr>';
        if (cb?.found && cb.signals_firing.length) {
          html += '<tr><td></td><td colspan="9" style="color:#ffb74d">↳ Cipher B firing: ' + cb.signals_firing.join(', ') + '</td></tr>';
        }
      }
      html += '</table>';
    }
    document.getElementById('tables').innerHTML = html || '<p style="color:#555">no data yet</p>';
  } catch (e) {
    document.getElementById('status').textContent = 'error: ' + e.message;
  }
}
tick();
setInterval(tick, 1000);
</script>
</body>
</html>`;

const server = createServer((req, res) => {
  if (req.url === "/status") {
    res.writeHead(200, { "Content-Type": "application/json" });
    if (!existsSync(LIVE_PATH)) {
      res.end(JSON.stringify({ status: "idle" }));
      return;
    }
    res.end(readFileSync(LIVE_PATH, "utf8"));
    return;
  }
  res.writeHead(200, { "Content-Type": "text/html" });
  res.end(PAGE);
});

server.listen(PORT, () => {
  console.log(`Signal grid dashboard: http://localhost:${PORT}`);
  console.log("Leave this running, then in another terminal: node scripts/signal-grid.js");
});
