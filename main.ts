// BTC race bot — a slow-regime trend rider for agent-fun/bars-replay/v1.
//
// The idea, from the dev window (24h of 1-minute cbBTC bars, +3.6% with a
// -2% max drawdown): one-minute bars are mostly noise (per-minute sigma
// ~0.08%), so fast crossovers whipsaw — the house ema-cross baseline lost
// $114.83 in 76 trades on this window, and every EMA-cross variant I
// swept lost money too. What survives is a slow filter that trades rarely:
//
//   * Enter only when the close clears a slow regime average (EMA-140) by
//     0.2% while also sitting above a faster average (EMA-50), and never
//     chase a close more than 2% above the regime average (a spike is not
//     a trend).
//   * Stay long while the regime holds. Exit on a real break: the close
//     2% under the regime average, 2% under the highest close since entry
//     (trailing stop), or the position 3% under its cost (hard stop).
//   * After an exit, wait 240 bars (4h) before re-entering, so one dip
//     cannot be bought twice. Past a 12% equity drawdown, stop entering
//     for the rest of the window.
//
// On the dev window this makes one trade for +$30.40 (buy-and-hold makes
// +$32.17); on the time-reversed window (a -3.5% down day) it loses
// -$17.40 where buy-and-hold loses -$38.89. Both halves of the dev window
// are positive, and nudging either EMA length by 2 bars changes nothing.
//
// Everything is deterministic: float64 EMA math on the closes, no clock,
// no randomness, no network, no files. One position, long only, full
// equity on entry (the caps allow 100% of equity).

import { runBars, type Bar, type BarsState, type BuyInput, type SellInput } from './vendor/makefun-bars.ts';

/** Slow regime average: ~2.3 hours of 1-minute closes. */
const REGIME_BARS = 140;
/** Faster average the close must also clear before an entry. */
const FAST_BARS = 50;
/** Entry needs the close this far above the regime average (basis points). */
const ENTRY_ABOVE_BPS = 20;
/** Never chase a close further than this above the regime average (bps). */
const CHASE_CAP_BPS = 200;
/** Exit when the close falls this far under the regime average (bps). */
const EXIT_BELOW_BPS = 200;
/** Trailing stop: this far under the highest close since entry (bps). */
const TRAIL_BPS = 200;
/** Hard stop: the position worth this far under its cost (bps). */
const HARD_STOP_BPS = 300;
/** Bars to wait after an exit before the next entry. */
const COOLDOWN_BARS = 240;
/** Block new entries once equity has drawn down this far from its peak. */
const DD_BLOCK_BPS = 1200;
/** Slippage cap per order, 1% past the close the order was decided on. */
const MAX_SLIPPAGE_BPS = 100;
const BPS = 10_000;

/** One exponential average, seeded as the mean of its first span of closes. */
class Ema {
  readonly span: number;
  readonly warm: number[] = [];
  value: number | null = null;

  constructor(span: number) {
    this.span = span;
  }

  push(close: number): void {
    if (this.value !== null) {
      this.value += (2 / (this.span + 1)) * (close - this.value);
      return;
    }
    this.warm.push(close);
    if (this.warm.length === this.span) {
      this.value = this.warm.reduce((a, x) => a + x, 0) / this.span;
    }
  }
}

/** The bot's own state, kept across batches. */
interface Rider {
  symbol: string;
  fast: Ema;
  regime: Ema;
  /** Highest close since the current entry, 0 while flat. */
  peakClose: number;
  /** Seq of the last exit, -1 when there has been none. */
  lastExitSeq: number;
  /** Highest equity seen, in quote units. */
  peakEquity: bigint;
  /** Set once equity draws down past the block; never cleared. */
  blocked: boolean;
}

function newRider(symbol: string, startEquity: bigint): Rider {
  return {
    symbol,
    fast: new Ema(FAST_BARS),
    regime: new Ema(REGIME_BARS),
    peakClose: 0,
    lastExitSeq: -1,
    peakEquity: startEquity,
    blocked: false,
  };
}

/** True when the close is at least `bps` above `base` (integer-safe float). */
function aboveBy(close: number, base: number, bps: number): boolean {
  return close * BPS >= base * (BPS + bps);
}

/** True when the close is at least `bps` below `base`. */
function belowBy(close: number, base: number, bps: number): boolean {
  return close * BPS <= base * (BPS - bps);
}

/** Feed one bar into both averages; returns the traded symbol's close. */
function track(rider: Rider, bar: Bar): number {
  const close = Number(bar.c);
  rider.fast.push(close);
  rider.regime.push(close);
  return close;
}

/** Whether the rider may open a new position on this batch. */
function mayEnter(rider: Rider, state: BarsState, close: number): boolean {
  if (rider.blocked || state.warmingUp) return false;
  if (rider.lastExitSeq >= 0 && state.seq - rider.lastExitSeq < COOLDOWN_BARS) return false;
  const fast = rider.fast.value;
  const regime = rider.regime.value;
  if (fast === null || regime === null) return false;
  return aboveBy(close, regime, ENTRY_ABOVE_BPS) && close > fast && !aboveBy(close, regime, CHASE_CAP_BPS);
}

/** Whether a held position must be sold on this close. */
function mustExit(rider: Rider, state: BarsState, close: number): boolean {
  const regime = rider.regime.value;
  if (regime === null) return false;
  if (belowBy(close, regime, EXIT_BELOW_BPS)) return true;
  if (rider.peakClose > 0 && belowBy(close, rider.peakClose, TRAIL_BPS)) return true;
  const held = state.positions.get(rider.symbol);
  if (held !== undefined) {
    const value = state.value(rider.symbol, held.qty);
    if (value * BigInt(BPS) < held.cost * BigInt(BPS - HARD_STOP_BPS)) return true;
  }
  return false;
}

let rider: Rider | null = null;

await runBars({
  onHello(state) {
    // One symbol in this universe; trade it.
    rider = newRider(state.hello.symbols[0]!.symbol, state.equity);
  },

  onBatch(state, batch) {
    const r = rider!;
    let close: number | null = null;
    for (const bar of batch.bars) {
      if (bar.symbol !== r.symbol) continue;
      close = track(r, bar);
    }
    if (close === null || state.warmingUp) return [];

    if (state.equity > r.peakEquity) r.peakEquity = state.equity;
    if (state.equity * BigInt(BPS) < r.peakEquity * BigInt(BPS - DD_BLOCK_BPS)) {
      r.blocked = true;
    }

    const held = state.positions.get(r.symbol);
    if (held !== undefined) {
      if (close > r.peakClose) r.peakClose = close;
      if (mustExit(r, state, close)) {
        r.peakClose = 0;
        r.lastExitSeq = state.seq;
        const sell: SellInput = { side: 'sell', symbol: r.symbol, qty: held.qty, max_slippage_bps: MAX_SLIPPAGE_BPS };
        return [sell];
      }
      return [];
    }

    if (!mayEnter(r, state, close)) return [];
    const cash = state.cash;
    if (cash < BigInt(state.hello.fees.min_notional_quote_units)) return [];
    r.peakClose = close;
    const buy: BuyInput = { side: 'buy', symbol: r.symbol, notional_quote_units: cash, max_slippage_bps: MAX_SLIPPAGE_BPS };
    return [buy];
  },
});
