# PRE-REGISTRATION — MFI-gated STC U-turns on 4h, single run on XRP

**Frozen 2026-08-19, before Cipher B had ever been computed on XRP.**
Hypothesis from #181 (redundancy) and #184 (first positive cell). This document is the specification.
Nothing below may be changed after results are seen. **The run happens once.**

---

## 1. The claim

#181 measured the Cipher B component redundancy matrix and found **MFI and STC essentially
orthogonal** — normalised mutual information 0.0010–0.0048, the lowest of any pair, while wt1, wt2
and Cipher A's wt2 collapse into one measurement at r 0.973–0.9993.

#184 then tested the pair. The base signal has no edge — ungated STC loses in all six
instrument-rung cells. But the MFI gate separates on **4h and nowhere else**, and exactly two cells
came out profitable:

| | net/trade | win% | n |
|---|---|---|---|
| BTC 4h `stcUTurn` + MFI aligned | +0.7635% | 39.7% | 136 |
| ETH 4h `stcUTurn` + MFI aligned | +0.4116% | 37.1% | 143 |

### Why this needs pre-registering

#184 examined **twelve cells** and 4h won. That is a selection this cannot rule out from within, and
no mechanism has been offered for why 4h separates and 1h does not. Two correlated instruments
agreeing on one rung is the same shape that preceded the PASS in #180 **and** the FAILURES in #155,
#162 and #171.

### The guarantee, stated at its actual strength

**Cipher B has never been computed on XRP.** No `vmc-cipher-b-xrp.db` exists, no register row
reports a Cipher B result on XRP, and the only XRP rows in the register (#180, #183) concern the SMC
order-block reclaim entry and capacity, not this indicator.

**This is weaker than #180's guarantee and that is disclosed.** XRP candles already exist — they
were fetched for #180 — and Cipher B is computed in memory from candles rather than from a corpus,
so no build step stands between the data and a result. The honest claim is **"this hypothesis has
never been evaluated on this instrument"**, not "the data did not exist". Same standing as #165.

XRP remains the right instrument for the same reason as #180: longer-ranging, lower-beta, different
market structure from the three L1s the rule was developed on.

---

## 2. Frozen configuration

Every constant is hard-coded in the runner, not a flag.

| Item | Value |
|---|---|
| Instrument | **XRP** (XRPUSDT, Binance) |
| Rung | **4h only** — #184 located the effect there; 1h and 15m were null and are excluded |
| Event | `computeStcUTurnSignals` — directional STC turn inside the 25–75 band |
| Gate — treatment | **MFI aligned**: MFI > 0 at the signal bar for a bullish turn, MFI < 0 for bearish |
| Gate — control | **ungated**: every STC U-turn regardless of MFI |
| Reference arm | **MFI opposed**, reported for completeness, not a pass criterion |
| Entry | the bar AFTER the signal bar, at open |
| Stop | 2.0 × ATR(14) |
| Target | 2R |
| Hold limit | 200 bars, mark-to-market on unresolved |
| Ambiguous bars | stop-first |
| Slippage | 0.05 ATR entry, 0.15 ATR stop, 0 target |
| Costs | `bitunix_futures_vip1` taker both sides, plus representative funding |

`stcCross` is **excluded**. #184 found it profitable in no cell on any instrument and marginal at
best (+0.0144% on ETH 4h). Including it now would be adding a second shot at the same target.

---

## 3. Pass / fail criteria — declared before any XRP result exists

The run **PASSES** only if all three hold:

1. **MFI-aligned net > 0.** An improvement that stays unprofitable is not worth promoting.
2. **MFI-aligned beats ungated on net/trade.** The gate must be worth applying, not merely
   correlated with outcome — a gate that splits a population into better and worse halves without
   beating "take everything" earns nothing.
3. **Population floor:** n ≥ 60 in the aligned cell. Below this the run is **INCONCLUSIVE**, not a
   pass and not a fail.

Anything short of all three is a **FAIL**, recorded as one. No partial credit.

### What a pass authorises

The #33 paper/live-shadow stage for this construction only. It does **not** authorise portfolio
wiring, and C-2 (allocation dominates selection) and C-3 (budget-bound pool) apply unchanged.

### Limitations a pass will NOT remove

- XRP is correlated with BTC/ETH/SOL, less so than they are with each other but not independent.
- No mechanism has been offered for why the gate separates on 4h and not 1h. A pass would confirm
  the effect without explaining it, and an unexplained rung dependence remains a live risk.
- The MFI gate is a same-bar sign test. #37 falsified a same-bar MFI gate on a different trigger;
  this uses the same operationalisation on a different signal, which is a genuine difference but not
  an unlimited one.
- No forward evidence exists for this or any other Cipher B construction.

---

## 4. Procedure

1. Commit this document. No Cipher B result on XRP may exist at that commit.
2. Run `mfi-stc-preregistered-xrp.js` **once**.
3. Record the verdict against §3 in the register, pass or fail, without amendment.
