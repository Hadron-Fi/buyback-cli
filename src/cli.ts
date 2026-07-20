#!/usr/bin/env node
import { Command } from "commander";
import { initCommand, faucetCommand } from "./commands/init.js";
import { buybackCommand } from "./commands/buyback.js";
import { crankCommand } from "./commands/crank.js";
import { ladderCommand } from "./commands/ladder.js";
import { statusCommand } from "./commands/status.js";
import { closeCommand } from "./commands/close.js";

// Public RPCs sometimes fail deep inside web3.js on paths we don't await;
// log and keep going instead of crashing the crank.
process.on("unhandledRejection", (err) => {
  console.error(`rpc warning: ${err instanceof Error ? err.message : err}`);
});

const program = new Command();

program
  .name("buyback-cli")
  .description(
    "Hadron buybacks demo. Phase 1: init (empty pool + opens the page). Phase 2: buyback (seed orders + run the crank). The dashboard reads everything from the chain."
  );

program
  .command("init")
  .description("Create the wallet/mints if needed, stand up an EMPTY bid-only pool, open the page")
  .option("--keypair <path>", "operator keypair path")
  .option("--url <rpc>", "RPC endpoint")
  .action(run(initCommand));

program
  .command("buyback")
  .description("Paste a pool ID, seed the resting bid ladder, then run the crank")
  .option("--pool <address>", "pool ID (skips the prompt)")
  .option("--interval <ms>", "crank tick interval in ms (default from config)")
  .option("--live", "use the live exchange feed instead of the deterministic sim")
  .action(run(buybackCommand));

program
  .command("crank")
  .description("Run just the crank against the configured pool (deterministic sim price by default)")
  .option("--interval <ms>", "tick interval in ms (default from config)")
  .option("--live", "use the live exchange feed instead of the deterministic sim")
  .action(run(crankCommand));

program
  .command("ladder")
  .description('Rebuild the resting bid ladder, e.g. --set "80:1000,200:2000,350:4000" (spreadBps:usd)')
  .requiredOption("--set <spec>", "comma-separated spreadBps:usd rungs")
  .action(run(ladderCommand));

program
  .command("faucet")
  .description("Mint mock base tokens to a wallet so it can sell into the buybacks")
  .option("--to <pubkey>", "recipient (default: operator)")
  .option("--amount <n>", "amount of base tokens", "100")
  .action(run(faucetCommand));

program
  .command("status")
  .description("Show pool state, oracle freshness, vaults, and ladder fill progress")
  .action(run(statusCommand));

program
  .command("close")
  .description("Close the pool and sweep both vaults back to the treasury")
  .action(run(closeCommand));

function run<T>(fn: (opts: T) => Promise<void>): (opts: T) => Promise<void> {
  return async (opts: T) => {
    try {
      await fn(opts);
    } catch (err) {
      console.error(err instanceof Error ? err.message : err);
      process.exitCode = 1;
    }
  };
}

program.parseAsync();
