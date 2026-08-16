#!/usr/bin/env node
// DOES AN ACTIVE ZONE CONDITION A BOOM HUNTER SIGNAL? -- a CROSS-DOMAIN test.
//
// iapaulo: "the fact that they are still active means something, especially in cooperation with
// boom hunter signals."
//
// WHY THIS IS NOT ANOTHER C-1 REPEAT, WHICH IS THE WHOLE REASON IT IS WORTH RUNNING. #149, #150,
// #151 and #153 all tested domain-1 constructs against domain 1 or against price alone, and all
// four landed on saturation. **#126's C-1 finding says domain 1 is internally exhausted. It says
// nothing about a domain-1 STATE conditioning a domain-2 SIGNAL.** Boom Hunter is an oscillator
// family, not price-derived structure, so this is the first genuinely cross-domain question in the
// sequence and the C-1 prior does not transfer to it.
//
// THE SECOND HALF OF THE OBSERVATION IS THE RARITY POINT. Only 1,653 of 84,050 order blocks are
// unmitigated -- 2%. #147 established the same shape for q5: a condition is informative precisely
// BECAUSE the default is the opposite, so "still active" is a rarity gate rather than a common
// state. #153 also found that ALL significant zone cells were active-state cells; that row framed
// the active result as context for a breaker null, which under-read it.
//
// DESIGN. Anchor on the Boom Hunter signal, not on the zone -- the zone is the CONDITION, the
// oscillator is the trigger. For every signal bar, ask whether an ACTIVE, direction-aligned zone
// sits within BAND ATR on the supporting side:
//   bullish signal -> an unmitigated BULLISH zone whose top is 0..BAND ATR BELOW the close
//   bearish signal -> an unmitigated BEARISH zone whose bottom is 0..BAND ATR ABOVE the close
// Then compare forward return WITH the zone against WITHOUT it, inside the same signal family.
//
// BAND is 0.5 ATR, reused from breaker-polarity-test.js rather than chosen here, so it is not a
// newly tuned parameter. Both order blocks and FVGs are run, kept separate: #153 found the two
// constructs behave OPPOSITELY in the active state, so pooling them would cancel a real effect.
//
// available_at: a zone counts only if created at or before the signal bar and not mitigated at or
// before it. A zone that survives BECAUSE price later respected it must not be visible at signal
// time.
//
// NULL. Circular shift of the zone-state series against the return series, recomputing the
// contrast at the SAME signal bars. This preserves the autocorrelation of the zone state (zones
// persist for many bars) which an i.i.d. label shuffle would destroy. Two-sided.
//
// The bearish mirror is mandatory, as everywhere: crypto rose across this sample, so a bullish-only
// result is drift.

import { DatabaseSync } from "node:sqlite";
import { loadCandles } from "../../backtest/lib/load-candles.js";
import { dbSuffix } from "../lib/instrument.js";

const SHIFTS = 2000;
const HORIZONS = [1, 3, 6, 12];
const TFS = ["4h", "1h", "15m"];
const BAND = 0.5;

const BULL_TYPES = ["continuation", "long_blue", "long_lime", "long_enter4", "long_yellow"];
const BEAR_TYPES = ["break_short", "bearish_continuation"];

function rngf(s) {
  let a = s >>> 0;
  return () => { a |= 0; a = (a + 0x6d2b79f5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
function atr14(c) {
  const tr = c.map((x, i) => (i === 0 ? x.h - x.l : Math.max(x.h - x.l, Math.abs(x.h - c[i - 1].c), Math.abs(x.l - c[i - 1].c))));
  const out = new Array(c.length).fill(NaN);
  if (c.length < 14) return out;
  let a = tr.slice(0, 14).reduce((s, v) => s + v, 0) / 14;
  out[13] = a;
  for (let i = 14; i < c.length; i++) { a = (a * 13 + tr[i]) / 14; out[i] = a; }
  return out;
}

// zoneState[i] = 1 if an active, direction-aligned zone sits within BAND ATR on the supporting side.
function zoneStateSeries(candles, atr, zones, dir, kind) {
  const n = candles.length;
  const st = new Int8Array(n);
  const byCreate = new Map();
  for (const z of zones) {
    const c = z.created_bar_idx;
    if (c == null || c >= n) continue;
    if (!byCreate.has(c)) byCreate.set(c, []);
    byCreate.get(c).push(z);
  }
  let live = [];
  for (let i = 0; i < n; i++) {
    const add = byCreate.get(i);
    if (add) live.push(...add);
    if (live.length) live = live.filter((z) => z.end_idx == null || z.end_idx > i); // still active
    const a = atr[i];
    if (!Number.isFinite(a) || a <= 0 || !live.length) continue;
    const px = candles[i].c;
    for (const z of live) {
      const top = kind === "ob" ? z.bar_high : z.top;
      const bot = kind === "ob" ? z.bar_low : z.bottom;
      const d = dir === "bull" ? (px - top) / a : (bot - px) / a;
      if (d >= 0 && d < BAND) { st[i] = 1; break; }
    }
  }
  return st;
}

async function main() {
  console.log("CROSS-DOMAIN: does an ACTIVE zone condition a Boom Hunter signal?");
  console.log("Anchor = the oscillator signal. Condition = an unmitigated, aligned zone within 0.5 ATR.");
  console.log(`Contrast = WITH zone minus WITHOUT, inside the same signal family. ${SHIFTS}-shift null, two-sided.`);
  console.log("C-1 saturation is a domain-1 statement and does not cover this.\n");

  for (const inst of ["BTC", "ETH"]) {
    const bh = new DatabaseSync(new URL(`../../../data/signal-bus/boom-hunter${dbSuffix(inst)}.db`, import.meta.url), { readOnly: true });
    const smc = new DatabaseSync(new URL(`../../../data/signal-bus/smc${dbSuffix(inst)}.db`, import.meta.url), { readOnly: true });
    const ict = new DatabaseSync(new URL(`../../../data/signal-bus/ict${dbSuffix(inst)}.db`, import.meta.url), { readOnly: true });

    for (const tf of TFS) {
      const candles = await loadCandles(tf, inst);
      const atr = atr14(candles);
      const n = candles.length;
      const idxOf = new Map(candles.map((c, i) => [c.t, i]));

      const obRows = smc.prepare(`SELECT side, bar_high, bar_low, created_bar_idx, mitigated_bar_idx AS end_idx FROM order_blocks WHERE timeframe = ? AND instrument = ?`).all(tf, inst);
      const fvgRows = ict.prepare(`SELECT side, top, bottom, created_bar_idx, broken_bar_idx AS end_idx FROM fvg_zones WHERE timeframe = ? AND instrument = ?`).all(tf, inst);

      console.log(`===== ${inst} ${tf} -- ${n.toLocaleString()} bars`);
      for (const [famName, types, dir] of [["BULL", BULL_TYPES, "bull"], ["BEAR", BEAR_TYPES, "bear"]]) {
        const ph = types.map(() => "?").join(",");
        const ev = bh.prepare(`SELECT DISTINCT time FROM events WHERE timeframe = ? AND instrument = ? AND type IN (${ph})`).all(tf, inst, ...types);
        const sig = [...new Set(ev.map((r) => idxOf.get(r.time)).filter((v) => v !== undefined))];
        if (sig.length < 60) { console.log(`  ${famName}: only ${sig.length} signal bars, skipped`); continue; }

        for (const [kind, rows] of [["ob", obRows], ["fvg", fvgRows]]) {
          const zs = rows.filter((z) => (dir === "bull" ? z.side === "bullish" : z.side === "bearish"));
          if (!zs.length) continue;
          const st = zoneStateSeries(candles, atr, zs, dir, kind);
          const withN = sig.filter((i) => st[i] === 1).length;
          if (withN < 30 || sig.length - withN < 30) {
            console.log(`  ${famName} ${kind}: n_with=${withN} / n_without=${sig.length - withN}  (below floor, skipped)`);
            continue;
          }
          console.log(`  ${famName} + active ${kind.toUpperCase()}  signals=${sig.length}  with=${withN}  without=${sig.length - withN}`);
          console.log("     H     mean WITH    mean WITHOUT     contrast       p     predicted");
          for (const H of HORIZONS) {
            const ret = new Array(n).fill(NaN);
            for (let i = 0; i < n - H; i++) { const a = atr[i]; if (Number.isFinite(a) && a > 0) ret[i] = (candles[i + H].c - candles[i].c) / a; }
            const contrastAt = (state) => {
              let sw = 0, nw = 0, so = 0, no = 0;
              for (const i of sig) {
                const r = ret[i];
                if (!Number.isFinite(r)) continue;
                if (state[i] === 1) { sw += r; nw++; } else { so += r; no++; }
              }
              return nw && no ? { c: sw / nw - so / no, mw: sw / nw, mo: so / no } : null;
            };
            const obs = contrastAt(st);
            if (!obs) { console.log(`     ${String(H).padStart(2)}  (insufficient)`); continue; }
            const rng = rngf(31337 + H);
            let ge = 0;
            for (let k = 0; k < SHIFTS; k++) {
              const off = 1 + Math.floor(rng() * (n - 2));
              const shifted = { };
              // build a shifted view without materialising a full array copy per iteration
              let sw = 0, nw = 0, so = 0, no = 0;
              for (const i of sig) {
                const r = ret[i];
                if (!Number.isFinite(r)) continue;
                if (st[(i + off) % n] === 1) { sw += r; nw++; } else { so += r; no++; }
              }
              if (nw && no && Math.abs(sw / nw - so / no) >= Math.abs(obs.c)) ge++;
            }
            const p = ge / SHIFTS;
            // A supportive zone should HELP the aligned signal: bull -> more positive, bear -> more negative.
            const pred = dir === "bull" ? "+" : "-";
            const got = obs.c >= 0 ? "+" : "-";
            console.log(
              `     ${String(H).padStart(2)}${obs.mw.toFixed(4).padStart(13)}${obs.mo.toFixed(4).padStart(16)}` +
              `${obs.c.toFixed(4).padStart(13)}${p.toFixed(4).padStart(9)}${p < 0.05 ? "*" : " "}  want ${pred} got ${got}` +
              `${p < 0.05 && got === pred ? "  <== MATCH" : ""}`,
            );
          }
        }
      }
      console.log("");
    }
    bh.close(); smc.close(); ict.close();
  }
}

main().catch((e) => { console.error("Fatal:", e); process.exit(1); });
