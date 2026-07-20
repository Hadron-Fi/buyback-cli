import { exec } from "node:child_process";
import { PublicKey } from "@solana/web3.js";
import {
  ensureOperatorKeypair,
  ensureSol,
  getConnection,
  loadOrCreateConfig,
  loadConfig,
  saveConfig,
  solscanAccount,
} from "../config.js";
import { simPrice } from "../lib/sim.js";
import { initPool, faucetBase } from "../buyback.js";

/**
 * Phase 1: `npm run init`. Creates the wallet/mints if needed and stands up
 * an EMPTY bid-only pool (no orders), then opens the dashboard page for that
 * pool. The page's market line starts immediately: it is the deterministic
 * sim keyed by the pool ID, computed in the browser. Phase 2 is
 * `npm run buyback`, which seeds the orders and starts the crank.
 */
export async function initCommand(opts: { keypair?: string; url?: string }): Promise<void> {
  const cfg = loadOrCreateConfig();
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

  // Anchor at the sim's current value for a fresh pool (the sim is seeded by
  // pool ID, which does not exist yet, so use the neutral seed; the crank
  // re-anchors the mid within seconds of starting anyway).
  const anchor = simPrice("hadron", Date.now());
  console.log(`Standing up an empty bid-only pool anchored at $${anchor.toFixed(4)}...`);
  const r = await initPool(connection, operator, cfg, anchor);

  const link = `${cfg.dashboardUrl}?pool=${r.pool}`;
  console.log(`\nPool ID: ${r.pool}`);
  console.log(`  ${solscanAccount(r.pool, connection.rpcEndpoint)}`);
  console.log(`Page: ${link}`);
  console.log('\nNext: npm run buyback   (paste the pool ID; seeds the orders and starts the crank)');
  const opener = process.platform === "darwin" ? "open" : process.platform === "win32" ? "start" : "xdg-open";
  exec(`${opener} "${link}"`);
}

export async function faucetCommand(opts: { to?: string; amount: string }): Promise<void> {
  const cfg = loadConfig();
  const { keypair: operator } = ensureOperatorKeypair(cfg.keypairPath);
  const connection = getConnection(cfg);
  const recipient = opts.to ? new PublicKey(opts.to) : operator.publicKey;
  await faucetBase(connection, operator, cfg, recipient, Number(opts.amount));
}
