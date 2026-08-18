// Streams a data/historical/binance-btc-{tf}.csv file into an array of candles, shaped to match
// what scripts/lib/adaptive-supertrend.js expects: {t (unix seconds), o, h, l, c, v}.
// Streaming (readline over a read stream) so the large files (1m = 259MB) don't require reading
// the whole file into one giant string first, even though the parsed array itself still ends up
// in memory -- fine for the timeframes this lab actually needs (4H and coarser); 1m/2m/3m would
// need a real streaming backtest loop if ever used, not attempted here.

import { createReadStream } from "fs";
import { createInterface } from "readline";

const DATA_DIR = new URL("../../../data/historical/", import.meta.url);

// Instrument -> raw-file prefix (2026-08-15, ETH scope change).
//
// The prefix encodes SOURCE, not just instrument, and the files are deliberately NOT renamed to a
// clean `btc-15m.csv` scheme: the filename is the only place each series' provenance is recorded,
// and EEH-CITI-1.0 §27 Priority 0 treats raw data as immutable.
//
// UPDATED later the same day: Binance became reachable (VPN), which removed the constraint that
// had forced Coinbase sourcing. BOTH instruments are now Binance USDT-quoted spot, venue-matched
// and quote-matched -- which is what makes cross-market BTC/ETH work sound rather than carrying a
// venue mismatch into every comparison. BTC's Coinbase-spliced tail (2025-01-01 onward, which
// diverged from Binance on 100% of bars with up to 4.90% divergence in the daily LOW) was repaired
// in place by fetch-binance-history.js --mode=repair; its pre-seam bars were already Binance and
// were left untouched.
//
// `coinbase-eth-*.csv` files may still exist on disk from the superseded Coinbase ETH pull. They
// are intentionally NOT referenced here -- kept only as an independent cross-venue reference for
// sanity-checking the Binance series, never as a pipeline input.
const INSTRUMENT_FILE_PREFIX = {
  BTC: "binance-btc",
  ETH: "binance-eth",
  SOL: "binance-sol",
  XRP: "binance-xrp",
};

// `instrument` defaults to BTC while the store layer's requireInstrument() refuses to default at
// all. The asymmetry is deliberate: a wrong instrument on WRITE permanently mixes two populations
// in a shared table and cannot be undone, whereas a wrong instrument on READ produces a wrong
// answer in one run and is fully recoverable. Every analysis script predating 2026-08-15 is
// BTC-only, so the default keeps them correct without a 40-file edit.
export async function loadCandles(timeframeKey, instrument = "BTC") {
  const prefix = INSTRUMENT_FILE_PREFIX[instrument];
  if (!prefix) {
    throw new Error(
      `unknown instrument '${instrument}' -- known: ${Object.keys(INSTRUMENT_FILE_PREFIX).join(", ")}. ` +
        "Add it to INSTRUMENT_FILE_PREFIX with its real source prefix rather than guessing a filename.",
    );
  }
  const path = new URL(`${prefix}-${timeframeKey}.csv`, DATA_DIR);
  const rl = createInterface({ input: createReadStream(path), crlfDelay: Infinity });

  const candles = [];
  let isHeader = true;
  for await (const line of rl) {
    if (isHeader) {
      isHeader = false;
      continue;
    }
    if (!line) continue;
    const [ts, o, h, l, c, v] = line.split(",");
    candles.push({
      t: Math.floor(Date.parse(ts) / 1000),
      o: parseFloat(o),
      h: parseFloat(h),
      l: parseFloat(l),
      c: parseFloat(c),
      v: parseFloat(v),
    });
  }
  return candles;
}
