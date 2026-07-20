import { exec } from "node:child_process";
import { createInterface } from "node:readline/promises";
import { PublicKey } from "@solana/web3.js";
import {
  createAssociatedTokenAccountIdempotentInstruction,
  getAssociatedTokenAddressSync,
} from "@solana/spl-token";
import { Hadron } from "@hadron-fi/sdk-v2";
import {
  ensureOperatorKeypair,
  ensureSol,
  getConnection,
  loadOrCreateConfig,
  loadConfig,
  saveConfig,
  sendTx,
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

  // Ask for the devnet RPC (Enter keeps the current one). A private RPC
  // (e.g. Helius) avoids the public endpoint's rate limits.
  if (!opts.url && process.stdin.isTTY) {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    const answer = (await rl.question(`Devnet RPC URL [${cfg.rpcUrl}]: `)).trim();
    rl.close();
    if (answer) cfg.rpcUrl = answer;
  }
  saveConfig(cfg);

  const { keypair: operator, path, created } = ensureOperatorKeypair(cfg.keypairPath);
  cfg.keypairPath = path;
  saveConfig(cfg);
  const connection = getConnection(cfg);
  if (created) console.log(`Created a devnet wallet at ${path}`);
  console.log(`Operator: ${operator.publicKey.toBase58()}`);
  console.log(`  ${solscanAccount(operator.publicKey.toBase58(), connection.rpcEndpoint)}`);

  const sol = await ensureSol(connection, operator.publicKey, 1);
  if (sol < 0.5e9) throw new Error("Not enough devnet SOL. Fund the wallet above and re-run.");

  // init means START FRESH: if a previous pool is configured, close it
  // (sweeps its vaults back to the treasury) and create a brand-new empty
  // one, so the page always opens on an empty book.
  if (cfg.pool) {
    console.log(`Closing previous pool ${cfg.pool}...`);
    try {
      const prev = await Hadron.load(connection, new PublicKey(cfg.pool));
      const withdrawAuthority = prev.config.withdrawAuthority;
      const ataX = getAssociatedTokenAddressSync(prev.config.mintX, withdrawAuthority, true);
      const ataY = getAssociatedTokenAddressSync(prev.config.mintY, withdrawAuthority, true);
      await sendTx(
        connection,
        [operator],
        [
          createAssociatedTokenAccountIdempotentInstruction(operator.publicKey, ataX, withdrawAuthority, prev.config.mintX),
          createAssociatedTokenAccountIdempotentInstruction(operator.publicKey, ataY, withdrawAuthority, prev.config.mintY),
          prev.closePool(operator.publicKey, ataX, ataY),
        ],
        "close-previous-pool"
      );
    } catch (err) {
      console.log(`  (could not close it: ${err instanceof Error ? err.message.slice(0, 80) : err}; continuing)`);
    }
    delete cfg.pool;
    delete cfg.seed;
    saveConfig(cfg);
  }

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
