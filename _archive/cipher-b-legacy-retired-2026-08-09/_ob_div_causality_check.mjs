import { DatabaseSync } from "node:sqlite";

const SMC_DB = new URL("../../../data/signal-bus/smc.db", import.meta.url);
const CIPHER_DB = new URL("../../../data/signal-bus/cipher-b.db", import.meta.url);
const LADDER = ["1d","4h","3h","2h","1h","15m","5m"];
const PRICE_TOL = 0.01;
const TIME_WINDOW_BARS = 60;
const BAR_DURATION_SEC = { "1w": 604800, "1d": 86400, "4h": 14400, "3h": 10800, "2h": 7200, "1h": 3600, "15m": 900, "5m": 300 };

function median(vals) {
  const s = [...vals].sort((a,b)=>a-b);
  const m = Math.floor(s.length/2);
  return s.length % 2 ? s[m] : (s[m-1]+s[m])/2;
}

const smcDb = new DatabaseSync(SMC_DB, { readOnly: true });
const cipherDb = new DatabaseSync(CIPHER_DB, { readOnly: true });

for (const tf of LADDER) {
  const windowSec = TIME_WINDOW_BARS * BAR_DURATION_SEC[tf];
  for (const side of ["bullish","bearish"]) {
    const divSide = side === "bullish" ? "bull" : "bear";
    const obs = smcDb.prepare("SELECT id, bar_high as barHigh, bar_low as barLow, origin_bar_idx as originBarIdx, origin_time as originTime FROM order_blocks WHERE timeframe=? AND side=?").all(tf, side);
    const divs = cipherDb.prepare("SELECT prev_bar_idx as prevBarIdx, prev_time as prevTime, bar_idx as barIdx, time, price_val as price, confirm_time as confirmTime FROM divergences WHERE timeframe=? AND side=?").all(tf, divSide);

    const distsToSecondPivot = [], distsToFirstPivot = [];
    let nWithDiv = 0;
    for (const ob of obs) {
      const obPrice = (ob.barHigh + ob.barLow) / 2;
      const nearby = divs.filter((d) => Math.abs(d.confirmTime - ob.originTime) <= windowSec && Math.abs(d.price - obPrice)/obPrice <= PRICE_TOL);
      if (nearby.length === 0) continue;
      nWithDiv++;
      // closest divergence by confirm time
      nearby.sort((a,b)=>Math.abs(a.confirmTime-ob.originTime)-Math.abs(b.confirmTime-ob.originTime));
      const d = nearby[0];
      const barDur = BAR_DURATION_SEC[tf];
      distsToSecondPivot.push(Math.abs(d.time - ob.originTime) / barDur);
      distsToFirstPivot.push(Math.abs(d.prevTime - ob.originTime) / barDur);
    }
    if (nWithDiv === 0) continue;
    console.log(`${tf.padEnd(4)} ${side.padEnd(8)} n=${nWithDiv}  median|OBorigin - div 2nd pivot|=${median(distsToSecondPivot).toFixed(1)} bars  median|OBorigin - div 1st pivot|=${median(distsToFirstPivot).toFixed(1)} bars  pct(2ndPivot<=5bars)=${(distsToSecondPivot.filter(x=>x<=5).length/nWithDiv*100).toFixed(0)}%  pct(1stPivot<=5bars)=${(distsToFirstPivot.filter(x=>x<=5).length/nWithDiv*100).toFixed(0)}%`);
  }
}
smcDb.close(); cipherDb.close();
