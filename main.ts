// Pump.fun Bot Sprint — replay client for agent-fun/replay/v2.
//
// This file is only the wire: it reads the harness NDJSON stream from
// stdin, keeps the bot's view of curves, cash and lots up to date, hands
// each batch to the strategy in strategy.ts, and prints exactly one reply
// per batch. Nothing here touches the network, the disk or the clock, and
// nothing is random, so the same batch stream always yields the same
// replies and the harness's two runs agree byte for byte.
//
// Wire shape (kit protocol.schema.json):
//   harness -> bot: {"type":"hello",...} then {"type":"batch",...} then {"type":"done",...}
//   bot -> harness: {"type":"reply","seq":N,"orders":[...]} — one line per batch.
//   buy:  {side:"buy",  client_id, mint, quote_lamports:"<u64>", max_slippage_bps}
//   sell: {side:"sell", client_id, mint, token_amount:"<u64>", max_slippage_bps}
//   u64 values travel as decimal strings. Client ids never start with "_"
//   (those are reserved for the harness's own closes). Replies cap at 65536 bytes.

export type Mint = string;

/** One bonding curve at its latest known reserves. */
export interface Curve {
  mint: Mint;
  /** Slot of the CreateEvent; null when first seen via a trade or a mark. */
  born: number | null;
  vTokens: bigint;
  vQuote: bigint;
  rTokens: bigint;
  rQuote: bigint;
  /** Slot of the trade these reserves follow. */
  seen: number;
  /** TradeEvents counted on it. */
  trades: number;
  /** Its CompleteEvent arrived: no further orders on it. */
  done: boolean;
}

/** A position from the latest account report. */
export interface Lot {
  tokens: bigint;
  cost: bigint;
}

/** An order sent and not yet answered by a fill. */
export interface Flying {
  side: "buy" | "sell";
  mint: Mint;
  amount: bigint;
  slot: number;
}

export interface WireOrder {
  side: "buy" | "sell";
  mint: Mint;
  /** Buy: SOL to spend, in lamports. Sell: tokens to sell. */
  amount: bigint;
  maxSlippageBps: number;
}

export interface Hello {
  protocol: string;
  seed: string;
  capital: { lamports: string };
  caps: {
    max_open_positions: number;
    max_order_bps_of_real_reserve: number;
    max_orders_per_batch: number;
    shorts: boolean;
    leverage: boolean;
  };
  latency_slots: number;
  fees: {
    protocol_bps_fallback: number;
    creator_bps_fallback: number;
    base_fee_lamports: string;
    priority_fee_lamports: string;
    failed_tx_bps: number;
  };
}

export interface Batch {
  type: "batch";
  seq: number;
  slot: number;
  events: Array<Record<string, unknown>>;
  marks: Array<{
    mint: string;
    slot: number;
    virtual_token_reserves: string;
    virtual_quote_reserves: string;
    real_token_reserves: string;
    real_quote_reserves: string;
  }>;
  fills: Array<{
    client_id: string;
    mint: string;
    side: string;
    status: string;
    reason: string | null;
    decided_slot: number;
    slot: number;
    quote_lamports: string;
    token_amount: string;
    fee_lamports: string;
    tx_fee_lamports: string;
    fee_fallback: boolean;
  }>;
  account: {
    cash_lamports: string;
    positions: Array<{ mint: string; token_amount: string; cost_lamports: string }>;
  };
}

const BPS = 10_000n;
const U64 = /^(0|[1-9][0-9]{0,19})$/;
const MINT = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const CLIENT_ID = /^[A-Za-z0-9-][A-Za-z0-9_-]{0,63}$/;

/** A decimal-string u64, checked strictly; throws on anything else. */
function asU64(value: unknown, label: string): string {
  let n: bigint | null = null;
  if (typeof value === "bigint") n = value;
  else if (typeof value === "number" && Number.isSafeInteger(value)) n = BigInt(value);
  else if (typeof value === "string" && U64.test(value)) n = BigInt(value);
  if (n === null || n < 0n) throw new Error(`${label} must be a u64, got ${String(value)}`);
  return n.toString();
}

/**
 * The bot's picture of the replay, refreshed before every strategy call.
 * Also usable standalone in a test: build one from a hello, feed it batches.
 */
export class Book {
  readonly hello: Hello;
  seq = -1;
  slot = -1;
  cash = 0n;
  readonly lots = new Map<Mint, Lot>();
  readonly curves = new Map<Mint, Curve>();
  readonly flying = new Map<string, Flying>();
  #usedIds = new Set<string>();
  #next = 1;

  constructor(hello: Hello) {
    this.hello = hello;
    this.cash = BigInt(hello.capital.lamports);
  }

  nextId(): string {
    for (;;) {
      const id = `r${this.#next++}`;
      if (!this.#usedIds.has(id)) {
        this.#usedIds.add(id);
        return id;
      }
    }
  }

  /** Base + priority fee charged on every order sent, filled or not. */
  orderFee(): bigint {
    return BigInt(this.hello.fees.base_fee_lamports) + BigInt(this.hello.fees.priority_fee_lamports);
  }

  /** Most this batch's buys on one mint may spend together (1% of its real SOL). */
  buyCap(mint: Mint): bigint {
    const c = this.curves.get(mint);
    if (c === undefined || c.done) return 0n;
    return (c.rQuote * BigInt(this.hello.caps.max_order_bps_of_real_reserve)) / BPS;
  }

  /** Mints held plus mints with a buy in flight: counts toward max_open_positions. */
  usedSlots(): number {
    const mints = new Set<Mint>(this.lots.keys());
    for (const f of this.flying.values()) if (f.side === "buy") mints.add(f.mint);
    return mints.size;
  }

  /** Cash minus what in-flight orders would take if they fill (amounts + every tx fee). */
  spendable(): bigint {
    const fee = this.orderFee();
    let free = this.cash;
    for (const f of this.flying.values()) {
      free -= fee;
      if (f.side === "buy") free -= f.amount;
    }
    return free;
  }

  /** Current price of one token in SOL (virtual quote / virtual token), as a float. */
  price(mint: Mint): number {
    const c = this.curves.get(mint);
    if (!c || c.vTokens === 0n) return 0;
    return Number(c.vQuote) / Number(c.vTokens);
  }

  /** Fold a batch in: fills first, then account, marks, then events. */
  absorb(batch: Batch): void {
    this.seq = batch.seq;
    this.slot = batch.slot;
    for (const f of batch.fills) this.flying.delete(f.client_id);
    this.cash = BigInt(batch.account.cash_lamports);
    this.lots.clear();
    for (const p of batch.account.positions) {
      const tokens = BigInt(p.token_amount);
      if (tokens > 0n) {
        this.lots.set(p.mint, { tokens, cost: BigInt(p.cost_lamports) });
      }
    }
    for (const m of batch.marks) {
      const c = this.curves.get(m.mint);
      if (c !== undefined && m.slot < c.seen) continue;
      const curve = c ?? this.spawn(m.mint, null, m.slot);
      curve.vTokens = BigInt(m.virtual_token_reserves);
      curve.vQuote = BigInt(m.virtual_quote_reserves);
      curve.rTokens = BigInt(m.real_token_reserves);
      curve.rQuote = BigInt(m.real_quote_reserves);
      curve.seen = m.slot;
    }
    for (const e of batch.events) {
      if (e.event === "CreateEvent") {
        const curve = this.spawn(e.mint as string, e.slot as number, e.slot as number);
        curve.vTokens = BigInt(e.virtual_token_reserves as string);
        curve.vQuote = BigInt(e.virtual_quote_reserves as string);
        curve.rTokens = BigInt(e.real_token_reserves as string);
        curve.rQuote = 0n;
      } else if (e.event === "TradeEvent") {
        const curve = this.curves.get(e.mint as string) ?? this.spawn(e.mint as string, null, e.slot as number);
        curve.vTokens = BigInt(e.virtual_token_reserves as string);
        curve.vQuote = BigInt(e.virtual_quote_reserves as string);
        curve.rTokens = BigInt(e.real_token_reserves as string);
        curve.rQuote = BigInt(e.real_quote_reserves as string);
        curve.seen = e.slot as number;
        curve.trades += 1;
      } else if (e.event === "CompleteEvent") {
        const curve = this.curves.get(e.mint as string) ?? this.spawn(e.mint as string, null, e.slot as number);
        curve.done = true;
      }
    }
  }

  private spawn(mint: Mint, born: number | null, slot: number): Curve {
    const curve: Curve = {
      mint,
      born,
      vTokens: 0n,
      vQuote: 0n,
      rTokens: 0n,
      rQuote: 0n,
      seen: slot,
      trades: 0,
      done: false,
    };
    this.curves.set(mint, curve);
    return curve;
  }

  /** Check strategy orders and stamp client ids on them; throws on a protocol violation. */
  encode(asks: readonly WireOrder[] | void | null | undefined): Array<Record<string, unknown>> {
    if (asks === undefined || asks === null) return [];
    if (!Array.isArray(asks)) throw new Error(`batch ${this.seq}: strategy must return an array of orders`);
    const cap = this.hello.caps.max_orders_per_batch;
    if (asks.length > cap) {
      throw new Error(`batch ${this.seq}: ${asks.length} orders over max_orders_per_batch (${cap})`);
    }
    const out: Array<Record<string, unknown>> = [];
    for (let i = 0; i < asks.length; i++) {
      const o = asks[i]!;
      if (o.side !== "buy" && o.side !== "sell") throw new Error(`batch ${this.seq} order ${i}: bad side`);
      if (typeof o.mint !== "string" || !MINT.test(o.mint)) {
        throw new Error(`batch ${this.seq} order ${i}: bad mint`);
      }
      if (!Number.isInteger(o.maxSlippageBps) || o.maxSlippageBps < 0 || o.maxSlippageBps > 10_000) {
        throw new Error(`batch ${this.seq} order ${i}: bad max_slippage_bps`);
      }
      const id = this.nextId();
      if (!CLIENT_ID.test(id)) throw new Error("bad client id");
      const amount = asU64(o.amount, `batch ${this.seq} order ${i} amount`);
      out.push(
        o.side === "buy"
          ? { side: "buy", client_id: id, mint: o.mint, quote_lamports: amount, max_slippage_bps: o.maxSlippageBps }
          : { side: "sell", client_id: id, mint: o.mint, token_amount: amount, max_slippage_bps: o.maxSlippageBps },
      );
      this.flying.set(id, { side: o.side, mint: o.mint, amount: o.amount, slot: this.slot });
    }
    return out;
  }
}

export interface Strategy {
  onBatch(book: Book, batch: Batch): readonly WireOrder[] | void;
}

/** Split stdin into \n-terminated lines (handles lines up to 1 MiB). */
async function* lines(): AsyncGenerator<string> {
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let buf = new Uint8Array(0);
  for await (const chunk of process.stdin as AsyncIterable<Uint8Array>) {
    const joined = new Uint8Array(buf.length + chunk.length);
    joined.set(buf, 0);
    joined.set(chunk, buf.length);
    buf = joined;
    let start = 0;
    for (;;) {
      const nl = buf.indexOf(0x0a, start);
      if (nl === -1) break;
      let line = buf.subarray(start, nl);
      if (line.length > 0 && line[line.length - 1] === 0x0d) line = line.subarray(0, line.length - 1);
      yield decoder.decode(line);
      start = nl + 1;
    }
    buf = buf.slice(start);
  }
  if (buf.length > 0) yield decoder.decode(buf);
}

export async function run(strategy: Strategy): Promise<{ batches: number }> {
  let book: Book | null = null;
  let batches = 0;
  for await (const line of lines()) {
    if (line.trim() === "") continue;
    const msg = JSON.parse(line) as { type?: unknown };
    if (msg.type === "hello") {
      if (book !== null) throw new Error("second hello");
      const hello = msg as unknown as Hello;
      if (hello.protocol !== "agent-fun/replay/v2") throw new Error(`unsupported protocol ${hello.protocol}`);
      book = new Book(hello);
    } else if (msg.type === "batch") {
      if (book === null) throw new Error("batch before hello");
      const batch = msg as unknown as Batch;
      book.absorb(batch);
      const orders = book.encode(strategy.onBatch(book, batch));
      const text = JSON.stringify({ type: "reply", seq: batch.seq, orders });
      if (new TextEncoder().encode(text).byteLength > 65536) {
        throw new Error(`batch ${batch.seq}: reply over 65536 bytes`);
      }
      process.stdout.write(`${text}\n`);
      batches++;
    } else if (msg.type === "done") {
      if (book === null) throw new Error("done before hello");
      return { batches };
    } else {
      throw new Error(`unknown message type ${String(msg.type)}`);
    }
  }
  throw new Error(book === null ? "input ended before hello" : `input ended before done (after ${batches} batches)`);
}

// ---------------------------------------------------------------- entrypoint

import { createRider } from "./strategy.ts";

const result = await run(createRider());
process.stderr.write(`done after ${result.batches} batches\n`);
