# buyback-cli

Hyperliquid-style buybacks on Solana devnet: a bid-only [Hadron](https://docs.hadron.fi) pool posts a ladder of resting bids that chase the market price, driven by this CLI and watched live at [dashboard.hadron.fi/buybacks](https://dashboard.hadron.fi/buybacks).

## Run it

```bash
npm install

# 1. Create an empty bid-only pool and open its dashboard page
#    (prompts for a devnet RPC; creates a devnet wallet if you have none)
npm run init

# 2. Seed the bid ladder and start the price crank
#    (paste the pool ID when prompted)
npm run buyback
```

Then on the page: connect a devnet wallet, faucet test SOL with the shown command, and sell into the bids. Stop the crank (Ctrl-C) to trip the staleness kill switch; restart it to resume.

## Commands

| Command | Description |
| --- | --- |
| `npm run init` | Close any old pool, create a fresh empty one, open the page |
| `npm run buyback` | Seed the resting bid ladder, then run the crank |
| `npm run crank` | Run just the crank (`--live` uses the real Orca price instead of the sim) |
| `npm run cli -- ladder --set "80:1000,200:2000,350:4000"` | Rebuild the bid levels (spreadBps:usd) |
| `npm run cli -- faucet --to <wallet> --amount 10` | Mint test SOL to a wallet |
| `npm run cli -- status` | Pool state, vaults, ladder fills |
| `npm run cli -- close` | Close the pool and sweep the vaults back |

Config lives in `buyback.config.json` (git-ignored): RPC, ladder levels, EMA alpha, push cadence. The dashboard reads everything from the chain by pool ID; the crank posts `min(EMA, market)` as the on-chain midprice.
