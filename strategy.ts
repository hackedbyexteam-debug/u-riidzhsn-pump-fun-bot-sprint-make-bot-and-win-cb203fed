// Momentum breakout rider for the pump.fun replay sprint.
//
// The read that drives everything: a launch sniper buys blind — most new
// coins die in the first minutes, and the sniper pays for every one of
// them. This bot waits instead. It only buys a coin AFTER the tape has
// already proven buyers want it: the price has climbed a real step from
// where it was a little while ago, fresh money is still flowing in, and
// the crowd buying it is broad, not one wallet. It pays a worse entry
// price than the sniper for that proof, and in exchange it skips the
// coins that never move at all.
//
// Entry (decided once a coin has a tape worth reading):
//   * momentum: price up 8–45% against the price ~40 slots ago — a real
//     climb, not noise, and not yet a vertical blow-off;
//   * flow: net SOL in over the last 25 slots is positive, from at least
//     three distinct recent buyers — the climb is still being bought;
//   * honesty: the creator has not sold, the creator's own buy (if any)
//     is under 2 SOL, sells are under 60% of buys, and no single sell
//     took more than a quarter of the real SOL reserve;
//   * room: real SOL between 4 and 55 — big enough to trade, far enough
//     from bonding that the move still has somewhere to go.
//
// Sizing: one buy per coin, up to `stake`, capped at 1% of the curve's
// real SOL reserve (the harness cap) and at least `minBuy` to be worth
// the transaction fee.
//
// Exits: the position is cut at a stop loss against cost, or the moment
// the creator sells. It is banked in full at the take-profit level. In
// between, a trailing stop protects a gain once the position is up a
// little: after rising at least `trailArm`, a fall of `trail` from the
// best value seen exits. A fade in recent flow or a single whale sell
// also exits, and a position held too long is closed unless it is well
// up. Once the curve is near bonding completion (real SOL close to the
// ~85 SOL target) the bot rides it — the harness closes it at the final
// reserves, usually the best exit available — so fade, trail and whale
// exits pause while riding.
//
// Guardrail pacing: the competition ranks below every entry that misses
// it, so the bot must finish with round trips of >= 0.01 SOL on >= 20
// coins and a drawdown <= 50%. The rider trades plenty on its own, but a
// pace check (own fills and coins vs elapsed block time) opens tiny probe
// round trips on liquid curves whenever the bot falls behind pace.
//
// Deterministic by construction: no clock, no randomness, iteration only
// over insertion-ordered maps fed by the batch stream.

import type { Batch, Book, Mint, WireOrder } from "./main.ts";

export interface RiderParams {
  /** Fewest / most trades a coin may have when a first buy is decided. */
  minTapeTrades: number;
  maxTapeTrades: number;
  /** SOL to put into one position in total. */
  stake: number;
  /** Smallest buy worth sending. */
  minBuy: number;
  /** Real SOL reserve window at decision time. */
  minRq: number;
  maxRq: number;
  /** Creator's own buy: at most this many SOL (a bundle about to dump). */
  maxDevBuy: number;
  /** Creator's own buy: at least this many SOL (real skin in the game). */
  minDevBuy: number;
  /** Creator sold before entry: skip the coin. */
  skipDevSold: boolean;
  /** Distinct non-creator buyers before entry: at least this many. */
  minBuyers: number;
  /** Lamports sold by others / lamports bought, at most (as a share). */
  maxSellShare: number;
  /** Largest single non-creator sell, as a share of real SOL before it, at most. */
  maxWhaleShare: number;
  /** Price now over the price `lookback` slots ago, minus 1: window. */
  minClimb: number;
  maxClimb: number;
  /** Slots back the climb is measured over. */
  lookback: number;
  /** Recent-flow window (slots) and what it must show. */
  flowWindow: number;
  minFlow: number;
  minFlowBuyers: number;
  /** Slippage on buys (bps); sells always go out wide open. */
  buySlip: number;
  /** Exits. */
  stopLoss: number;
  /** Take-profit: sell the whole position once it is worth this much over cost. */
  takeProfit: number;
  /** Trailing stop: once up at least trailArm, exit on a fall of trail from the best value. */
  trailArm: number;
  trail: number;
  /** Exit after holding this many slots. */
  maxHold: number;
  /** The time limit does not apply while the position is up at least this much. */
  holdIfUp: number;
  /** Exit when net SOL over fadeWindow slots falls below -fadeNet. */
  fadeWindow: number;
  fadeNet: number;
  /** Exit on any single recorded sell of at least this many SOL. */
  whaleSell: number;
  /** Exit when the creator sells while held. */
  exitOnDevSell: boolean;
  /** Hold on (no fade, trail or whale exit) once the curve's real SOL passes this. */
  rideRq: number;
  /** Slots to wait after an exit before the same curve may be bought again. */
  cooldown: number;
  /** Most entries per curve over the run. */
  maxEntries: number;
  /** Most rider positions open at once (the rest of max_open_positions is for probes). */
  maxMain: number;
  /** Guardrail pacing: pace the run toward at least this many coins / fills. */
  targetCoins: number;
  targetFills: number;
  /** Seconds of block time the pace is measured over. */
  paceSecs: number;
  probeSol: number;
  maxProbes: number;
  /** Most SOL at cost across all positions at once (a drawdown guard). */
  maxExposure: number;
}

export const DEFAULT_RIDER: RiderParams = {
  minTapeTrades: 20,
  maxTapeTrades: 80,
  stake: 0.2,
  minBuy: 0.005,
  minRq: 4.0,
  maxRq: 55,
  maxDevBuy: 1.0,
  minDevBuy: 0.05,
  skipDevSold: true,
  minBuyers: 3,
  maxSellShare: 0.6,
  maxWhaleShare: 0.25,
  minClimb: 0.08,
  maxClimb: 0.3,
  lookback: 40,
  flowWindow: 25,
  minFlow: 0.1,
  minFlowBuyers: 4,
  buySlip: 10_000,
  stopLoss: 0.1,
  takeProfit: 0.25,
  trailArm: 0.15,
  trail: 0.15,
  maxHold: 300,
  holdIfUp: 0.5,
  fadeWindow: 30,
  fadeNet: 1.5,
  whaleSell: 3,
  exitOnDevSell: true,
  rideRq: 70,
  cooldown: 150,
  maxEntries: 1,
  maxMain: 5,
  targetCoins: 40,
  targetFills: 160,
  paceSecs: 86_400,
  probeSol: 0.02,
  maxProbes: 1,
  maxExposure: 3,
};

const LAMPORTS = 1e9;
/** Protocol + creator fee per side, as a share of the trade (95 + 30 bps). */
const CURVE_FEE = 0.0125;

interface Fill {
  slot: number;
  buy: boolean;
  sol: number;
  user: string;
}

interface PriceMark {
  slot: number;
  price: number;
}

interface Tape {
  created: number | null;
  creator: string | null;
  createPrice: number;
  devBuy: number;
  devSold: boolean;
  buyers: Set<string>;
  bought: number;
  soldByOthers: number;
  whaleShare: number;
  fills: Fill[];
  marks: PriceMark[];
  entries: number;
  lastExit: number;
  /** Never buy it again (exited, filtered out for good, or completed). */
  done: boolean;
}

interface Held {
  opened: number;
  peak: number;
  invested: number;
  leaving: boolean;
  filled: boolean;
  devSoldAtOpen: boolean;
  lastValue: number;
}

export function createRider(p: RiderParams = DEFAULT_RIDER) {
  const tapes = new Map<Mint, Tape>();
  const held = new Map<Mint, Held>();
  /** Probe round trips in flight, by mint: false while buying, true once selling. */
  const probes = new Map<Mint, boolean>();
  /** The bot's own filled orders and the coins they were on (harness closes excluded). */
  let myFills = 0;
  const myCoins = new Set<Mint>();
  let firstTime: number | null = null;
  let lastTime: number | null = null;

  const tapeOf = (mint: Mint): Tape => {
    let t = tapes.get(mint);
    if (t === undefined) {
      t = {
        created: null,
        creator: null,
        createPrice: 0,
        devBuy: 0,
        devSold: false,
        buyers: new Set(),
        bought: 0,
        soldByOthers: 0,
        whaleShare: 0,
        fills: [],
        marks: [],
        entries: 0,
        lastExit: -1e12,
        done: false,
      };
      tapes.set(mint, t);
    }
    return t;
  };

  /** Net recorded SOL (buys minus sells) and distinct buyers over the last `w` slots. */
  const flow = (t: Tape, now: number, w: number): { net: number; buyers: number } => {
    let net = 0;
    const buyers = new Set<string>();
    for (let i = t.fills.length - 1; i >= 0; i--) {
      const tr = t.fills[i]!;
      if (tr.slot <= now - w) break;
      net += tr.buy ? tr.sol : -tr.sol;
      if (tr.buy) buyers.add(tr.user);
    }
    return { net, buyers: buyers.size };
  };

  /** Price `w` slots ago, from the sampled marks (oldest mark at or before now - w). */
  const priceAgo = (t: Tape, now: number, w: number): number => {
    const target = now - w;
    let best = 0;
    for (let i = t.marks.length - 1; i >= 0; i--) {
      const m = t.marks[i]!;
      if (m.slot <= target) {
        best = m.price;
        break;
      }
    }
    return best;
  };

  return {
    onBatch(book: Book, batch: Batch): WireOrder[] {
      const now = batch.slot;
      const whale = new Set<Mint>();
      const touched = new Set<Mint>();
      for (const f of batch.fills) {
        if (f.status === "filled" && !f.client_id.startsWith("_")) {
          myFills++;
          myCoins.add(f.mint);
        }
      }
      for (const e of batch.events) {
        if (e.block_time !== null && typeof e.block_time === "number") {
          if (firstTime === null) firstTime = e.block_time;
          if (lastTime === null || e.block_time > lastTime) lastTime = e.block_time;
        }
        if (e.event === "CreateEvent") {
          const t = tapeOf(e.mint as string);
          t.created = e.slot as number;
          t.creator = e.creator as string;
          t.createPrice =
            Number(e.virtual_quote_reserves as string) / Number(e.virtual_token_reserves as string);
        } else if (e.event === "TradeEvent") {
          const t = tapeOf(e.mint as string);
          const sol = Number(e.sol_amount as string) / LAMPORTS;
          const isDev = t.creator !== null && e.user === t.creator;
          t.fills.push({
            slot: e.slot as number,
            buy: e.is_buy as boolean,
            sol,
            user: e.user as string,
          });
          touched.add(e.mint as string);
          if (e.is_buy) {
            t.bought += sol;
            if (isDev) t.devBuy += sol;
            else t.buyers.add(e.user as string);
          } else if (isDev) {
            t.devSold = true;
          } else {
            t.soldByOthers += sol;
            const rqBefore = Number(e.real_quote_reserves as string) / LAMPORTS + sol;
            if (rqBefore > 0) {
              const share = sol / rqBefore;
              if (share > t.whaleShare) t.whaleShare = share;
            }
          }
          if (!e.is_buy && sol >= p.whaleSell) whale.add(e.mint as string);
        }
      }
      // Sample the price on every touched curve, and prune old tape:
      // only the flow/fade windows and the lookback are ever read.
      const keep = Math.max(p.flowWindow, p.fadeWindow, p.lookback) + 5;
      for (const mint of touched) {
        const t = tapes.get(mint)!;
        const curve = book.curves.get(mint);
        if (curve !== undefined && curve.vTokens > 0n) {
          const price = Number(curve.vQuote) / Number(curve.vToken);
          const last = t.marks[t.marks.length - 1];
          if (last === undefined || last.slot < now) t.marks.push({ slot: now, price });
        }
        let cut = 0;
        while (cut < t.fills.length && t.fills[cut]!.slot <= now - keep) cut++;
        if (cut > 0) t.fills.splice(0, cut);
        let mcut = 0;
        while (mcut < t.marks.length && t.marks[mcut]!.slot <= now - keep) mcut++;
        if (mcut > 0) t.marks.splice(0, mcut);
      }
      const marks = new Map(batch.marks.map((m) => [m.mint, m] as const));
      const flyingByMint = new Map<Mint, number>();
      for (const f of book.flying.values()) {
        flyingByMint.set(f.mint, (flyingByMint.get(f.mint) ?? 0) + 1);
      }

      const orders: WireOrder[] = [];
      const cap = book.hello.caps.max_orders_per_batch;
      const tx = Number(book.orderFee()) / LAMPORTS;

      // Exits first: a position that must go outranks any new entry.
      for (const [mint, o] of held) {
        const lot = book.lots.get(mint);
        const curve = book.curves.get(mint);
        if (lot === undefined) {
          if (!flyingByMint.has(mint)) {
            held.delete(mint);
            const t = tapeOf(mint);
            if (o.filled) t.lastExit = now;
            else t.entries--;
          }
          continue;
        }
        o.filled = true;
        if (curve === undefined || curve.done) continue;
        const mk = marks.get(mint);
        const vq = mk ? Number(mk.virtual_quote_reserves) : Number(curve.vQuote);
        const vt = mk ? Number(mk.virtual_token_reserves) : Number(curve.vToken);
        const rqSol = (mk ? Number(mk.real_quote_reserves) : Number(curve.rQuote)) / LAMPORTS;
        const tokens = Number(lot.tokens);
        // Value of selling the whole position now, curve fee and tx fee deducted.
        const value = ((tokens * vq) / (vt + tokens) / LAMPORTS) * (1 - CURVE_FEE) - tx;
        const cost = Number(lot.cost) / LAMPORTS;
        if (value > o.peak) o.peak = value;
        o.lastValue = value;
        const t = tapeOf(mint);
        const riding = rqSol >= p.rideRq;
        let exit = o.leaving;
        if (!exit && value < cost * (1 - p.stopLoss)) exit = true;
        if (!exit && p.exitOnDevSell && t.devSold && !o.devSoldAtOpen) exit = true;
        if (!exit && !riding && o.peak >= cost * (1 + p.trailArm) && value < o.peak * (1 - p.trail)) exit = true;
        // Breakeven guard: once the position has been up at least 5%, never
        // let it turn into a loss — a winner that gives it all back exits at cost.
        if (!exit && !riding && o.peak >= cost * 1.05 && value < cost) exit = true;
        if (!exit && !riding && flow(t, now, p.fadeWindow).net < -p.fadeNet) exit = true;
        if (!exit && !riding && whale.has(mint)) exit = true;
        if (!exit && now - o.opened > p.maxHold && value < cost * (1 + p.holdIfUp)) exit = true;
        // Loser time-stop: a position still under water after 100 slots is
        // bleeding, not basing — cut it early and let winners use the full hold.
        if (!exit && !riding && now - o.opened > 100 && value < cost) exit = true;
        if (exit) {
          o.leaving = true;
          if (flyingByMint.has(mint)) {
            let sellFlying = false;
            for (const f of book.flying.values()) {
              if (f.mint === mint && f.side === "sell") sellFlying = true;
            }
            if (sellFlying) continue;
          }
          if (orders.length >= cap) break;
          orders.push({ side: "sell", mint, amount: lot.tokens, maxSlippageBps: 10_000 });
          continue;
        }
        // Take-profit: bank the whole position once it is worth this much over cost.
        if (cost > 0 && value >= cost * (1 + p.takeProfit)) {
          if (flyingByMint.has(mint)) continue;
          if (orders.length >= cap) break;
          orders.push({ side: "sell", mint, amount: lot.tokens, maxSlippageBps: 10_000 });
          o.leaving = true;
        }
      }

      // Probe round trips: sell the whole probe as soon as its buy has landed.
      for (const [mint, selling] of probes) {
        const lot = book.lots.get(mint);
        const curve = book.curves.get(mint);
        if (lot === undefined) {
          if (!flyingByMint.has(mint)) probes.delete(mint);
          continue;
        }
        if (curve === undefined || curve.done || flyingByMint.has(mint)) continue;
        if (orders.length >= cap) break;
        orders.push({ side: "sell", mint, amount: lot.tokens, maxSlippageBps: 10_000 });
        if (!selling) probes.set(mint, true);
      }

      // Entries: coins whose tape already proves buyers want them.
      let free = Number(book.spendable()) / LAMPORTS;
      let slotsLeft = book.hello.caps.max_open_positions - book.usedSlots();
      let mainLeft = p.maxMain - held.size;
      let exposure = 0;
      for (const [mint, o] of held) {
        exposure += Math.max(o.invested, Number(book.lots.get(mint)?.cost ?? 0n) / LAMPORTS);
      }
      for (const mint of touched) {
        if (orders.length >= cap) break;
        const t = tapes.get(mint)!;
        const curve = book.curves.get(mint);
        if (curve === undefined || curve.done) continue;
        if (flyingByMint.has(mint) || probes.has(mint)) continue;
        if (slotsLeft <= 0 || mainLeft <= 0) break;
        if (t.done || held.has(mint)) continue;
        if (t.created === null) continue;
        // A tape worth reading: enough trades to judge, not so many the move is over.
        if (t.fills.length < p.minTapeTrades || t.fills.length > p.maxTapeTrades) {
          if (t.fills.length > p.maxTapeTrades) t.done = true;
          continue;
        }
        if (t.entries >= p.maxEntries || now - t.lastExit < p.cooldown) continue;
        const rqSol = Number(curve.rQuote) / LAMPORTS;
        if (rqSol < p.minRq || rqSol > p.maxRq) continue;
        // Honesty filter on the tape so far.
        if (t.devBuy < p.minDevBuy || t.devBuy > p.maxDevBuy) {
          t.done = true;
          continue;
        }
        if (p.skipDevSold && t.devSold) {
          t.done = true;
          continue;
        }
        if (t.buyers.size < p.minBuyers) continue;
        if (t.bought > 0 && t.soldByOthers > p.maxSellShare * t.bought) continue;
        if (t.whaleShare > p.maxWhaleShare) continue;
        // Momentum: the climb over the lookback must be real but not a blow-off.
        const price = Number(curve.vQuote) / Number(curve.vToken);
        const old = priceAgo(t, now, p.lookback);
        const base = old > 0 ? old : t.createPrice;
        if (base <= 0) continue;
        const climb = price / base - 1;
        if (climb < p.minClimb || climb > p.maxClimb) continue;
        const fl = flow(t, now, p.flowWindow);
        if (fl.net < p.minFlow || fl.buyers < p.minFlowBuyers) continue;
        const capSol = Math.floor(Number(book.buyCap(mint))) / LAMPORTS;
        let amount = Math.min(capSol, p.stake, p.maxExposure - exposure);
        if (amount > free - tx) amount = free - tx;
        if (amount < p.minBuy) continue;
        const lamports = BigInt(Math.floor(amount * LAMPORTS));
        orders.push({ side: "buy", mint, amount: lamports, maxSlippageBps: p.buySlip });
        free -= amount + tx;
        exposure += amount;
        held.set(mint, {
          opened: now,
          peak: 0,
          invested: amount,
          leaving: false,
          filled: false,
          devSoldAtOpen: t.devSold,
          lastValue: 0,
        });
        t.entries++;
        slotsLeft--;
        mainLeft--;
      }

      // Guardrail pacing: open a probe when the bot's fills or coins lag the pace.
      if (probes.size < p.maxProbes && slotsLeft > 0 && firstTime !== null && lastTime !== null) {
        const pace = Math.min(1, (lastTime - firstTime) / p.paceSecs);
        const needCoins = myCoins.size < Math.ceil(p.targetCoins * pace);
        const needFills = myFills < Math.ceil(p.targetFills * pace);
        if (needCoins || needFills) {
          const minRq = (p.probeSol * 10_000) / book.hello.caps.max_order_bps_of_real_reserve;
          for (const mint of touched) {
            if (orders.length >= cap || probes.size >= p.maxProbes) break;
            if (held.has(mint) || probes.has(mint) || flyingByMint.has(mint) || book.lots.has(mint)) continue;
            if (needCoins && !needFills && myCoins.has(mint)) continue;
            const curve = book.curves.get(mint);
            if (curve === undefined || curve.done) continue;
            if (Number(curve.rQuote) / LAMPORTS < minRq * 1.5) continue;
            if (free < p.probeSol + 2 * tx) break;
            orders.push({ side: "buy", mint, amount: BigInt(Math.floor(p.probeSol * LAMPORTS)), maxSlippageBps: p.buySlip });
            probes.set(mint, false);
            free -= p.probeSol + tx;
          }
        }
      }
      return orders;
    },
  };
}
