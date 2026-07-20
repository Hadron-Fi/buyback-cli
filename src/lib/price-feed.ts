/**
 * Live SOL/USD price for --live mode. Primary source is Orca's public API
 * (the main SOL/USDC whirlpool) — Solana-native, no RPC or API key needed,
 * and CORS-open so a browser could use the same endpoint. Coinbase is the
 * fallback.
 */

const ORCA_SOL_USDC_POOL = "Czfq3xZZDmsdGdUyrNLtRhGc47cXcZtLG4crryfu44zE";

interface PriceSource {
  label: string;
  url: string;
  parse: (json: any) => number;
}

const SOURCES: PriceSource[] = [
  {
    label: "orca SOL/USDC",
    url: `https://api.orca.so/v2/solana/pools/${ORCA_SOL_USDC_POOL}`,
    parse: (j) => Number(j.data.price),
  },
  {
    label: "coinbase SOL-USD",
    url: "https://api.exchange.coinbase.com/products/SOL-USD/ticker",
    parse: (j) => (Number(j.bid) + Number(j.ask)) / 2,
  },
];

export class PriceFeed {
  private active: PriceSource | null = null;
  public lastLabel = "connecting";

  /** Fetch the current price, discovering a working source on first use. */
  async fetchPrice(): Promise<number> {
    if (this.active) {
      const p = await this.tryOne(this.active);
      if (p && p > 0) return p;
      this.active = null; // active source hiccuped; rediscover
    }
    for (const source of SOURCES) {
      const p = await this.tryOne(source);
      if (p && p > 0) {
        this.active = source;
        this.lastLabel = source.label;
        return p;
      }
    }
    throw new Error("No price source reachable (tried Orca, Coinbase). Check network access.");
  }

  private async tryOne(source: PriceSource): Promise<number | null> {
    try {
      const res = await fetch(source.url, {
        headers: { "User-Agent": "buyback-cli" },
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
