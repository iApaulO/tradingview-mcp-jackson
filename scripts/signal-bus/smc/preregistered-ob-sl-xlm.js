#!/usr/bin/env node
// PRE-REGISTERED SINGLE RUN — bullish OB inside Strong Low, 4h, on XLM.
// Spec: skills/ict-smc-trader/PREREGISTRATION-ob-strong-low-xlm.md, committed before XLM data existed.
// THIS RUNS ONCE. Every constant hard-coded. Population from ob-strong-low-builder.js and only there.

import { loadCandles } from "../../backtest/lib/load-candles.js";
import { computeSMC } from "./calc.js";
import { buildObStrongLow, OB_SL_REF } from "./ob-strong-low-builder.js";
import { FEE_TIERS, REPRESENTATIVE_FUNDING_PCT_PER_HOUR } from "../../backtest/lib/costs.js";

const INSTRUMENT = "XLM";
const ATR_LEN = 14, ATR_MULT = 2.0, R_MULT = 2, HOLD_BARS = 200, SLIP_STOP_ATR = 0.15;
const MIN_N = 60, SEEDS = 300, BULL = 1;
const TAKER = FEE_TIERS.bitunix_futures_vip1.takerFeePct;
const MAKER = FEE_TIERS.bitunix_futures_vip1.makerFeePct;

const mean = (xs) => (xs.length ? xs.reduce((s, x) => s + x, 0) / xs.length : NaN);
const sd = (xs) => { const m = mean(xs); return Math.sqrt(mean(xs.map((x) => (x - m) ** 2))); };
const tOf = (xs) => { if (xs.length < 2) return NaN; const s = sd(xs) * Math.sqrt(xs.length / (xs.length - 1)); return s > 0 ? mean(xs) / (s / Math.sqrt(xs.length)) : NaN; };
function mulberry32(a){return function(){a|=0;a=(a+0x6D2B79F5)|0;let t=Math.imul(a^(a>>>15),1|a);t=(t+Math.imul(t^(t>>>7),61|t))^t;return ((t^(t>>>14))>>>0)/4294967296}}
function atrSeries(c,L){const tr=c.map((x,i)=>i===0?x.h-x.l:Math.max(x.h-x.l,Math.abs(x.h-c[i-1].c),Math.abs(x.l-c[i-1].c)));const o=new Array(c.length).fill(NaN);let s=0;for(let i=0;i<L;i++)s+=tr[i];o[L-1]=s/L;for(let i=L;i<c.length;i++)o[i]=(o[i-1]*(L-1)+tr[i])/L;return o}
const fund=(c,i,j)=>REPRESENTATIVE_FUNDING_PCT_PER_HOUR*Math.max(0,(c[j].t-c[i].t)/3600);

function sim(c, atr, idx) {
  if (idx >= c.length) return null;
  const a = atr[idx]; if (!Number.isFinite(a) || a <= 0) return null;
  const e = c[idx].o, st = e - ATR_MULT * a, tg = e + R_MULT * ATR_MULT * a;
  const end = Math.min(c.length - 1, idx + HOLD_BARS);
  for (let j = idx; j <= end; j++) {
    const b = c[j];
    if (b.l <= st) return { net: (st - SLIP_STOP_ATR * a - e) / e - MAKER - TAKER - fund(c, idx, j), entry: idx, exit: j };
    if (b.h >= tg) return { net: (tg - e) / e - 2 * MAKER - fund(c, idx, j), entry: idx, exit: j };
  }
  if (end < idx + HOLD_BARS) return null;
  return { net: (c[end].c - e) / e - MAKER - TAKER - fund(c, idx, end), entry: idx, exit: end };
}
function clusters(ts){const o=[];let cur=[];for(const t of [...ts].sort((a,b)=>a.entry-b.entry)){if(cur.length&&t.entry<=cur[cur.length-1].exit)cur.push(t);else{if(cur.length)o.push(mean(cur.map(x=>x.net)));cur=[t]}}if(cur.length)o.push(mean(cur.map(x=>x.net)));return o}

async function main() {
  console.log(`PRE-REGISTERED RUN — bullish OB inside Strong Low, 4h, ${INSTRUMENT}. Executed once.`);
  console.log("Spec: skills/ict-smc-trader/PREREGISTRATION-ob-strong-low-xlm.md");
  console.log(`Reference: phase-averaged ${(OB_SL_REF.net * 100).toFixed(4)}% (#212), NOT the single-grid figure.\n`);

  const { trades } = await buildObStrongLow(INSTRUMENT);
  const done = trades.filter((t) => t.status === "resolved");
  const nets = done.map((t) => t.netPct);
  const wins = done.filter((t) => t.netPct > 0).length;

  // matched random-long null from XLM's own Strong Low population
  const c = await loadCandles("4h", INSTRUMENT);
  const atr = atrSeries(c, ATR_LEN);
  const { swingBias } = computeSMC(c);
  const pool = [];
  for (let i = ATR_LEN + 1; i < c.length - HOLD_BARS - 1; i++) if (swingBias[i] === BULL) pool.push(i);
  const nul = [];
  for (let s = 0; s < SEEDS; s++) {
    const rnd = mulberry32(21000 + s * 7919); const g = [];
    for (let k = 0; k < done.length; k++) { const ix = pool[Math.floor(rnd() * pool.length)]; const r = sim(c, atr, ix + 1); if (r) g.push(r.net); }
    if (g.length) nul.push(mean(g));
  }
  nul.sort((a, b) => a - b);
  const obs = mean(nets);
  const p95 = nul[Math.floor(SEEDS * 0.95)];
  const pct = nul.filter((x) => x < obs).length / nul.length * 100;
  const clT = tOf(clusters(done.map((t, i) => ({ net: t.netPct, entry: i, exit: i }))));

  console.log(`  ${INSTRUMENT} 4h: ${c.length.toLocaleString()} bars, ${new Date(c[0].t*1000).toISOString().slice(0,10)} -> ${new Date(c[c.length-1].t*1000).toISOString().slice(0,10)}`);
  console.log(`  signals resolved: ${done.length}  (in-sample expectation ~310/instrument)`);
  console.log(`  net ${(obs * 100).toFixed(4)}%/trade   win ${((wins / Math.max(1, done.length)) * 100).toFixed(1)}% (breakeven 33.3%)   t ${tOf(nets).toFixed(2)}   cluster t ${clT.toFixed(2)}`);
  console.log(`  matched random-long null: mean ${(mean(nul) * 100).toFixed(4)}%   95th pct ${(p95 * 100).toFixed(4)}%   observed sits at ${pct.toFixed(1)}th percentile`);

  const x3 = done.length >= MIN_N;
  const x1 = x3 && obs > 0;
  const x2 = x3 && obs > p95;
  console.log("\n---- CRITERIA (spec section 4) ----");
  console.log(`  X-3 n >= ${MIN_N} .................. ${x3 ? "MET" : "NOT MET"} (n=${done.length})`);
  console.log(`  X-1 net > 0 ..................... ${x1 ? "MET" : "NOT MET"} (${(obs * 100).toFixed(4)}%)`);
  console.log(`  X-2 beats null 95th pct ......... ${x2 ? "MET" : "NOT MET"} (${(obs * 100).toFixed(4)}% vs ${(p95 * 100).toFixed(4)}%)`);
  console.log(`\n  VERDICT: ${!x3 ? "INCONCLUSIVE (population floor)" : x1 && x2 ? "PASS" : "FAIL"}`);
  console.log("\nRecorded as-is. No partial credit, no amendment, no re-run.");
}
main().catch((e) => { console.error("Fatal:", e); process.exit(1); });
