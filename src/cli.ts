#!/usr/bin/env node
import { Command } from "commander";
import { initCommand, faucetCommand } from "./commands/init.js";
import { crankCommand } from "./commands/crank.js";
import { statusCommand } from "./commands/status.js";
import { closeCommand } from "./commands/close.js";

// Public RPCs sometimes fail deep inside web3.js (e.g. websocket 429s) on
// paths we don't await; log and keep going instead of crashing the crank.
process.on("unhandledRejection", (err) => {
  console.error(`rpc warning: ${err instanceof Error ? err.message : err}`);
});

const program = new Command();

program
  .name("shfl-buyback")
  .description(
    "SHFL x Hadron buyback demo backend: a live-price crank + local API the dashboard drives (init buybacks, faucet, build swaps)."
  );

program
  .command("crank")
  .description("Run the crank: stream the price and post it on-chain as the pool midprice (the dashboard reads the chain)")
  .option("--interval <ms>", "tick interval in ms (default from config)")
  .option("--sim", "use a simulated random-walk price instead of the live exchange feed")
  .action(run(crankCommand));

program
  .command("init")
  .description("Headless: create the wallet/mints if needed and stand up the pool + ladder at the live price")
  .option("--keypair <path>", "operator keypair path")
  .option("--url <rpc>", "RPC endpoint")
  .action(run(initCommand));

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
