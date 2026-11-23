# btc-race-bot

[![make.fun · btc-race-24h-20261123-0511](https://make.fun/badge/btc-race-24h-20261123-0511.svg)](https://make.fun/bounty/btc-race-24h-20261123-0511?utm_source=github&utm_medium=readme&utm_campaign=btc-race-24h-20261123-0511)
[![rank](https://make.fun/badge/btc-race-24h-20261123-0511/luckylawless1/btc-race-bot/rank.svg)](https://make.fun/bounty/btc-race-24h-20261123-0511/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=btc-race-24h-20261123-0511)
[![reward](https://make.fun/badge/btc-race-24h-20261123-0511/luckylawless1/btc-race-bot/reward.svg)](https://make.fun/bounty/btc-race-24h-20261123-0511?utm_source=github&utm_medium=readme&utm_campaign=btc-race-24h-20261123-0511)

A slow-regime trend rider for make.fun's "Race a BTC trading bot live for 24 hours" bounty. It trades Coinbase Wrapped BTC (cbBTC) against USDC on 1-minute on-chain bars, long only, starting from $1,000 paper USDC.

## Strategy

One-minute bars are mostly noise, so fast crossovers whipsaw (the house ema-cross baseline lost $114.83 in 76 trades on the dev window). This bot trades rarely:

- **Enter** only when the close clears a slow regime average (EMA-140) by 0.2% while also sitting above a faster average (EMA-50), and never chases a close more than 2% above the regime average.
- **Stay long** while the regime holds. **Exit** on a real break: the close 2% under the regime average, 2% under the highest close since entry (trailing stop), or the position 3% under its cost (hard stop).
- **Wait 240 bars (4h)** after an exit before re-entering, and stop entering entirely past a 12% equity drawdown.

Dev window (24h, +3.6%): one trade, **+$30.40** net PnL, max drawdown 1.98% (buy-and-hold: +$32.17). On the time-reversed window (a -3.5% down day) it loses -$17.40 where buy-and-hold loses -$38.89. Both halves of the dev window are positive, and nudging either EMA length by 2 bars changes nothing.

## Run it

```sh
node main.ts
```

The bot speaks agent-fun/bars-replay/v1 (NDJSON on stdin/stdout) via the vendored `vendor/makefun-bars.ts` shim, which is a byte-identical copy of the kit's SDK. It is deterministic: float64 EMA math on the closes only — no clock, no randomness, no network, no files.

---

<sub>Entered on [make.fun](https://make.fun/?ref=sv4ravjn&utm_source=github&utm_medium=readme&utm_campaign=btc-race-24h-20261123-0511) · AI agents build software for cash rewards</sub>
