# Hadron Buybacks (devnet demo): backend

Hyperliquid-style buybacks on Solana, built on [Hadron](https://docs.hadron.fi), with a price-chasing crank and a live UI. Runs end to end on devnet.

This repo is the **backend**: the price crank, a small local API, and the ops CLI (init / faucet / status / close). The **UI is a page in the hadron dashboard** (neutron repo, `frontend/hadron-dashboard`, route `/buybacks`, intentionally unlinked from the sidebar). Run the crank here, init via the CLI here, open that page there.

Hyperliquid's Assistance Fund does not market-buy: it posts resting limit orders below the book's midprice and lets sellers come to it. That gets better execution, dampens sell pressure without pulling liquidity, and provides buy support exactly when it is needed. This repo models that flow with a **bid-only Hadron pool**:

- A ladder of resting bids sits below midprice ($1,000 at 80 bps, $2,000 at 200 bps, $4,000 at 350 bps by default).
- A crank chases the live market price (Binance SOL/USD): one tiny oracle instruction re-centers the entire ladder every tick, the equivalent of cancel-and-replace on a whole book of orders in a single atomic update.
- No ask curve exists. The pool is structurally unable to sell the asset back.
- A staleness kill switch stops the pool from buying if the crank dies: after `deltaStaleness` slots without a price update, swaps revert.

Sellers reach the pool the same way they reach any Hadron pool: aggregators (Jupiter, Titan, etc.) route them to the best bid. On mainnet no integration work is needed for that; here, the dashboard page's swap box plays the role of a routed seller.

The demo buys back a **mock SOL token** priced by the real Binance SOL/USD feed (so sells are easy to demo at any size), against a **mock USDC** treasury. Both mints are created on the fly; the operator wallet keeps mint authority and acts as a faucet.

## Architecture

- **This service (`npm run crank`)** runs the price crank and a small local API (default `http://localhost:8787`). It holds an unattended operator keypair, streams the live price, posts it on-chain as the pool midprice every tick, and exposes endpoints the dashboard page calls to init the buybacks, faucet the base token, build sell transactions, and broadcast them.
- **The UI** lives in the neutron repo: `frontend/hadron-dashboard` at `/buybacks` (`components/buybacks/buyback-dashboard.tsx`). It polls this service's `/api/state` and drives it, using the dashboard's own wallet connection as the **seller**. Pool init is CLI-only (`npm run cli -- init` here); the page shows each init step flipping live as the CLI progresses.

Privileged actions (create pool, deposit, curve, midprice) are signed by the crank's operator key, so there is never a wallet-popup storm and midprice updates run unattended. Sells are built by the crank, signed by the connected wallet in the browser, and broadcast by the crank on its devnet RPC (so the send does not depend on the wallet's cluster).

The dashboard page finds this service at `http://localhost:8787` by default; override with `NEXT_PUBLIC_BUYBACK_API` in the dashboard's env to point at a hosted crank.

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

1. **Start the crank.** From this directory:
   ```bash
   npm run crank            # live Binance SOL/USD feed (default)
   npm run crank -- --sim   # simulated random-walk price, for demos when the market is quiet
   ```
   It funds its operator wallet, connects to the price source, and starts serving the API on `http://localhost:8787`. The posted oracle mid is `min(EMA, market)`: smoothed on the way up, instant on the way down, so the pool never overbids off a lagging EMA during a dump.

2. **Open the page.** The crank opens [dashboard.hadron.fi/buybacks](https://dashboard.hadron.fi/buybacks) for you (the page is intentionally unlinked from the sidebar; demo only). For local dashboard development, run `npm run dev` in the dashboard repo and go to `/buybacks` instead. It shows the **asset midprice** with the **best bid** below it, and the price chart runs. No pool exists yet.

3. **Init the buybacks.** From this repo run `npm run cli -- init`. The page shows each step flip live (mints, pool, kill switch, ladder). It creates the mock USDC treasury, opens the bid-only Hadron pool anchored at the live price, deposits, and posts the resting bid ladder. Within a couple of seconds the book fills in as an order book, and the crank starts posting the midprice on-chain so the ladder chases the market.

4. **Sell into the buybacks.** Connect your wallet. In the swap box, click **Get 10 test SOL** to faucet the mock base token, enter an amount, and **Sell**. The wallet signs; the crank broadcasts; the fill shows up in the book and the pool stats.

5. **Kill switch.** Stop the crank (Ctrl-C). After `deltaStaleness` slots (~10s) the oracle goes stale: sells revert and the page flips the kill-switch badge to red. Restart the crank and sells work again.

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
| `crankApiPort` | Local API port the page polls (default 8787). |
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

## Crank API (what the page calls)

`GET /api/state` (price, EMA, best bid, pool + ladder state, history), `POST /api/init`, `POST /api/faucet {wallet, amount}`, `POST /api/build-swap {seller, amountBase}` (returns an unsigned tx), `POST /api/send {signedTxBase64}` (broadcasts on devnet). CORS-open so the dashboard can call it.

## Hosting on a subdomain later

The page is a normal route in the dashboard, so it deploys with the dashboard. To run it against a hosted crank instead of localhost:

- Run this crank on a small always-on box (it holds the operator key and needs devnet SOL). Expose its API port behind a URL over HTTPS.
- Set `NEXT_PUBLIC_BUYBACK_API` in the dashboard's env to that URL. CORS is already open; nothing else changes.

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
