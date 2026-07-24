// Streams a data/historical/binance-btc-{tf}.csv file into an array of candles, shaped to match
// what scripts/lib/adaptive-supertrend.js expects: {t (unix seconds), o, h, l, c, v}.
// Streaming (readline over a read stream) so the large files (1m = 259MB) don't require reading
// the whole file into one giant string first, even though the parsed array itself still ends up
// in memory -- fine for the timeframes this lab actually needs (4H and coarser); 1m/2m/3m would
// need a real streaming backtest loop if ever used, not attempted here.

import { createReadStream } from "fs";
import { createInterface } from "readline";

const DATA_DIR = new URL("../../../data/historical/", import.meta.url);

export async function loadCandles(timeframeKey) {
  const path = new URL(`binance-btc-${timeframeKey}.csv`, DATA_DIR);
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
