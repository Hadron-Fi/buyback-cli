import { PublicKey } from "@solana/web3.js";
import {
  ensureOperatorKeypair,
  ensureSol,
  getConnection,
  loadConfig,
  saveConfig,
  solscanAccount,
} from "../config.js";
import { PriceFeed } from "../lib/price-feed.js";
import { initBuybacks, faucetBase } from "../buyback.js";

/**
 * Headless "init buybacks" for CLI/testing. The normal flow triggers this from
 * the dashboard via the crank server, but this command lets you set the pool up
 * without a browser. Creates the wallet if needed, funds it, reads the live
 * price, and stands up the pool + ladder.
 */
export async function initCommand(opts: { keypair?: string; url?: string }): Promise<void> {
  const cfg = loadConfig();
  if (opts.keypair) cfg.keypairPath = opts.keypair;
  if (opts.url) cfg.rpcUrl = opts.url;

  const { keypair: operator, path, created } = ensureOperatorKeypair(cfg.keypairPath);
  cfg.keypairPath = path;
  saveConfig(cfg);
  const connection = getConnection(cfg);
  if (created) console.log(`Created a devnet wallet at ${path}`);
  console.log(`Operator: ${operator.publicKey.toBase58()}`);
  console.log(`  ${solscanAccount(operator.publicKey.toBase58(), connection.rpcEndpoint)}`);

  const sol = await ensureSol(connection, operator.publicKey, 1);
  if (sol < 0.5e9) throw new Error("Not enough devnet SOL. Fund the wallet above and re-run.");

  const price = await new PriceFeed(cfg.priceSymbols).fetchPrice().catch(() => cfg.startPrice);
  console.log(`${cfg.baseSymbol}/USD anchor: $${price.toFixed(4)}. Standing up the buyback pool...`);
  const r = await initBuybacks(connection, operator, cfg, price);
  console.log(`\nBuybacks live: pool ${r.pool}`);
  console.log(`  ${solscanAccount(r.pool, connection.rpcEndpoint)}`);
  console.log(`\nWatch it live: ${cfg.dashboardUrl}`);
}

export async function faucetCommand(opts: { to?: string; amount: string }): Promise<void> {
  const cfg = loadConfig();
  const { keypair: operator } = ensureOperatorKeypair(cfg.keypairPath);
  const connection = getConnection(cfg);
  const recipient = opts.to ? new PublicKey(opts.to) : operator.publicKey;
  await faucetBase(connection, operator, cfg, recipient, Number(opts.amount));
}
