# Hadron Buybacks (devnet demo): backend

Hyperliquid-style buybacks on Solana, built on [Hadron](https://docs.hadron.fi), with a price-chasing crank and a live UI. Runs end to end on devnet.

This repo is the **backend**: the price crank and the ops CLI (init / faucet / status / close). The **UI is a page in the hadron dashboard** at [dashboard.hadron.fi/buybacks](https://dashboard.hadron.fi/buybacks) (intentionally unlinked from the sidebar). The two are tied together only through the CHAIN: init prints a pool ID, the page reads that pool straight from devnet by ID. No local server, no HTTP bridge.

Hyperliquid's Assistance Fund does not market-buy: it posts resting limit orders below the book's midprice and lets sellers come to it. That gets better execution, dampens sell pressure without pulling liquidity, and provides buy support exactly when it is needed. This repo models that flow with a **bid-only Hadron pool**:

- A ladder of resting bids sits below midprice ($1,000 at 80 bps, $2,000 at 200 bps, $4,000 at 350 bps by default).
- A crank chases the live market price (Binance SOL/USD): one tiny oracle instruction re-centers the entire ladder every tick, the equivalent of cancel-and-replace on a whole book of orders in a single atomic update.
- No ask curve exists. The pool is structurally unable to sell the asset back.
- A staleness kill switch stops the pool from buying if the crank dies: after `deltaStaleness` slots without a price update, swaps revert.

Sellers reach the pool the same way they reach any Hadron pool: aggregators (Jupiter, Titan, etc.) route them to the best bid. On mainnet no integration work is needed for that; here, the dashboard page's swap box plays the role of a routed seller.

The demo buys back a **mock SOL token** priced by the real Binance SOL/USD feed (so sells are easy to demo at any size), against a **mock USDC** treasury. Both mints are created on the fly; the operator wallet keeps mint authority and acts as a faucet.

## Architecture

- **This repo (`npm run crank`)** is a pure price loop: it streams the base/USD price (live Binance bookTicker mid, or a `--sim` random walk), EMA-smooths it, and posts `min(EMA, market)` as the on-chain pool midprice at a throttled cadence (`crank.pushIntervalMs`). It serves nothing.
- **The CLI** (`npm run cli -- init|faucet|status|close`) owns the operator key: init stands up the mints, pool, kill switch, and bid ladder, then prints the pool ID and a direct dashboard link (`?pool=<id>`).
- **The page** reads everything from devnet by pool ID: config, oracle mid and its transaction history, vaults, curves, fills. Sells are built and sent in the browser with the connected wallet; the Buy button simulates against the real program and shows the structural rejection; the faucet is a copyable CLI command (it needs the operator key).

Because the chain is the only coupling, the flow is fully deterministic and works identically for a hosted page or a local one: nothing needs HTTPS-to-localhost.

## How it maps to Hadron

| Buyback concept | Hadron mechanism |
| --- | --- |
| Resting bid at X bps below mid, size S | Point on the risk-bid curve (absolute vault-balance x-axis, Step interpolation, Integrated risk mode) via the SDK's `HadronOrderbook` |
| Orders move with the market | `UpdateMidprice`; every bid is priced as `mid × (1 − spread)`, so one oracle write moves the whole ladder |
| Cannot sell the asset back | The ask-side risk curve is never initialized; buy attempts revert |
| Kill switch | `deltaStaleness` on the pool config; swaps revert once the oracle is older than N slots |
| Fill tracking | The base vault balance is a monotonic fill pointer along the bid curve: bids fill tightest-first as sellers push the vault along the ladder |

## Prerequisites

- Node.js 20+
- A Solana wallet in the dashboard set to **Devnet**, to sell from the page.

```bash
npm install
```

**No Solana wallet file needed for the operator.** On first `npm run crank`, if you have no keypair the crank generates a throwaway devnet wallet at `./wallet.json` and airdrops to it. If the public airdrop is rate limited (it often is), it prints the address and a [faucet.solana.com](https://faucet.solana.com) link; fund it and restart the crank. If you already have `~/.config/solana/id.json` it uses that. The RPC defaults to the public devnet endpoint; put a private RPC URL (e.g. Helius) in `buyback.config.json` (gitignored) for better rate limits.

## The flow

1. **`npm run init`** creates the wallet/mints if needed and stands up an EMPTY bid-only pool (no orders yet), then prints the pool ID and opens the page for it. The page's market line starts immediately: the market price is a deterministic sim keyed by the pool ID, computed identically by the CLI and the browser, so there is nothing to connect.

2. **`npm run buyback`** prompts you to paste the pool ID (Enter accepts the one from init), seeds the resting bid ladder, and starts the crank in the same process. On the page: a toast fires the moment the orders land, the book fills in, and the on-chain oracle line joins the market line on the chart. The crank posts `min(EMA, market)` so the oracle trails rallies and tracks drops instantly.

3. **Sell into it.** Connect a devnet wallet on the page, faucet test SOL with the shown CLI command, and sell; the Buy button demonstrates the on-chain rejection. `npm run cli -- status` and `npm run cli -- close` round out ops. Pass `--live` to `buyback`/`crank` to use the real Binance feed instead of the sim (the page's market line stays sim, so expect divergence).

## Page panels (`/buybacks`)

- **Price** (top): the asset midprice (raw Binance SOL/USD) and the EMA best bid (`EMA(price) × (1 − top-spread)`). This is the true market versus where the buyback is resting its best bid.
- **Buyback book** (left): before init, the **Init Buybacks** button; after, the resting bid ladder as an order book (price, spread, size, fill bar).
- **Pool** (right): state, on-chain mid, USDC remaining to spend, base bought, oracle age vs the kill switch, and a Solscan link.
- **Swap box** (bottom): faucet the base token and sell into the bids with your connected wallet.

## Config reference (`buyback.config.json`)

Written on first crank run; edit and restart to change.

| Field | Meaning |
| --- | --- |
| `rpcUrl` | Devnet RPC endpoint. |
| `baseSymbol` | Base asset label shown in the UI (default `SOL`). |
| `priceSymbols` | Feed tickers tried in order: `SOLUSDT` (Binance.com), `SOLUSD` (Binance.US), `SOL-USD` (Coinbase). First reachable one wins. |
| `startPrice` | Fallback price if the feed is unreachable at init. |
| `deltaStaleness` | Kill-switch threshold in slots (default 25, about 10s). 0 disables it. |
| `ladder` | Array of `{ usd, spreadBps }` rungs, tightest first. |
| `crank.intervalMs` | Tick interval (default 2000). |
| `crank.emaAlpha` | EMA smoothing factor, 0..1 (default 0.2). |

## CLI (optional, for ops and headless testing)

The dashboard covers the whole flow; these are for scripting or debugging.

| Command | What it does |
| --- | --- |
| `npm run cli -- init` | Headless equivalent of Init Buybacks (creates wallet/mints if needed, stands up the pool + ladder at the live price). |
| `npm run cli -- faucet --to <pubkey> --amount <n>` | Mint mock base tokens to a wallet so it can sell. |
| `npm run cli -- status` | Pool state, oracle freshness, vaults, per-rung fill progress. |
| `npm run cli -- close` | Close the pool and sweep both vaults back to the treasury. |

## Hosting on a subdomain later

The page is a normal dashboard route reading public chain state, so it deploys with the dashboard and needs nothing else. Optional page params: `?pool=<id>` (which pool to show) and `?rpc=<url>` (use your own devnet RPC for better rate limits; the default is the public endpoint).

## What changes for production

Going to mainnet swaps the edges, not the core:

- **Price feed**: the crank already reads a real exchange feed and EMA-smooths it; point it at your production price source and run it on reliable infrastructure.
- **Mints**: real base asset and USDC; pool creation and the ladder are unchanged.
- **Routing**: aggregators route sellers to the pool automatically once it is listed; the swap box is only for testing.
- **Signing / ops**: here one operator key does everything. In production, split the roles (Hadron supports separate deposit/withdraw/pause and a rotatable quoting authority via `RotateQuotingAuthority`) and hold the quoting-bot key separately from the treasury.
- **Scale**: the two-pool design (a top-of-book chaser plus a slow-decay drawdown backstop) is the same machinery with a second pool and a different mid formula.

## Program and SDK

- Hadron v2 program (devnet + mainnet): `HADRoNbLovyqhCsocfYQYB7QdfCAAinN9HTePvBCVDQ8`
- SDK: [`@hadron-fi/sdk-v2`](https://www.npmjs.com/package/@hadron-fi/sdk-v2)
- Docs: [docs.hadron.fi](https://docs.hadron.fi), in particular [Integrating as an Order Book](https://docs.hadron.fi/examples/order-book)
