/**
 * Live base/USD spot price for the crank to chase.
 *
 * Tries a list of public spot endpoints in order and sticks with the first one
 * that answers. Binance.com is preferred (it is what the design doc names);
 * Binance.US and Coinbase are fallbacks for locations where .com is blocked.
 */

export interface PriceSource {
  label: string;
  url: (symbol: string) => string;
  parse: (json: any) => number;
  /** Which of the configured symbols this source expects. */
  match: (symbol: string) => boolean;
}

// All sources use the order-book mid ((bid+ask)/2) rather than the last-trade
// ticker: the trade price quantizes to whole cents and freezes in quiet
// markets, while the book mid moves sub-cent tick to tick.
const SOURCES: PriceSource[] = [
  {
    label: "binance.com",
    match: (s) => s.endsWith("USDT"),
    url: (s) => `https://api.binance.com/api/v3/ticker/bookTicker?symbol=${s}`,
    parse: (j) => (Number(j.bidPrice) + Number(j.askPrice)) / 2,
  },
  {
    label: "binance.us",
    match: (s) => s.endsWith("USD") && !s.includes("-"),
    url: (s) => `https://api.binance.us/api/v3/ticker/bookTicker?symbol=${s}`,
    parse: (j) => (Number(j.bidPrice) + Number(j.askPrice)) / 2,
  },
  {
    label: "coinbase",
    match: (s) => s.includes("-"),
    url: (s) => `https://api.exchange.coinbase.com/products/${s}/ticker`,
    parse: (j) => (Number(j.bid) + Number(j.ask)) / 2,
  },
];

export class PriceFeed {
  private symbols: string[];
  private active?: { source: PriceSource; symbol: string };
  public lastLabel = "connecting";

  constructor(symbols: string[]) {
    this.symbols = symbols;
  }

  /** Fetch the current price, discovering a working source on first use. */
  async fetchPrice(): Promise<number> {
    if (this.active) {
      const p = await this.tryOne(this.active.source, this.active.symbol);
      if (p && p > 0) return p;
      // Active source hiccuped; fall through to rediscovery.
      this.active = undefined;
    }
    for (const symbol of this.symbols) {
      const source = SOURCES.find((s) => s.match(symbol));
      if (!source) continue;
      const p = await this.tryOne(source, symbol);
      if (p && p > 0) {
        this.active = { source, symbol };
        this.lastLabel = `${source.label} ${symbol}`;
        return p;
      }
    }
    throw new Error(
      `No price source reachable (tried ${this.symbols.join(", ")}). Check network access.`
    );
  }

  private async tryOne(source: PriceSource, symbol: string): Promise<number | null> {
    try {
      const res = await fetch(source.url(symbol), {
        headers: { "User-Agent": "shfl-hadron-buybacks" },
        signal: AbortSignal.timeout(6000),
      });
      if (!res.ok) return null;
      const price = source.parse(await res.json());
      return Number.isFinite(price) && price > 0 ? price : null;
    } catch {
      return null;
    }
  }
}

/** Exponential moving average, the manipulation-resistant smoothed price. */
export class Ema {
  private ema: number | null = null;
  constructor(private alpha: number) {}

  update(x: number): number {
    this.ema = this.ema === null ? x : this.alpha * x + (1 - this.alpha) * this.ema;
    return this.ema;
  }

  get value(): number | null {
    return this.ema;
  }
}
