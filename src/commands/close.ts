import {
  createAssociatedTokenAccountIdempotentInstruction,
  getAssociatedTokenAddressSync,
} from "@solana/spl-token";
import { Hadron } from "@hadron-fi/sdk-v2";
import { getConnection, loadConfig, loadKeypair, requirePool, saveConfig, sendTx } from "../config.js";

/**
 * Close the pool. ClosePool sweeps both vaults to the withdraw authority's
 * ATAs itself and reclaims rent, so no separate withdraw is needed.
 */
export async function closeCommand(): Promise<void> {
  const cfg = loadConfig();
  const operator = loadKeypair(cfg.keypairPath);
  const connection = getConnection(cfg);
  const pool = await Hadron.load(connection, requirePool(cfg));

  const withdrawAuthority = pool.config.withdrawAuthority;
  const ataX = getAssociatedTokenAddressSync(pool.config.mintX, withdrawAuthority, true);
  const ataY = getAssociatedTokenAddressSync(pool.config.mintY, withdrawAuthority, true);

  await sendTx(
    connection,
    [operator],
    [
      createAssociatedTokenAccountIdempotentInstruction(operator.publicKey, ataX, withdrawAuthority, pool.config.mintX),
      createAssociatedTokenAccountIdempotentInstruction(operator.publicKey, ataY, withdrawAuthority, pool.config.mintY),
      pool.closePool(operator.publicKey, ataX, ataY),
    ],
    "close-pool"
  );

  delete cfg.pool;
  delete cfg.seed;
  saveConfig(cfg);
  console.log("Pool closed, vaults swept back to the treasury.");
  console.log("Click Init Buybacks in the dashboard (or run the init command) to start a fresh pool.");
}
