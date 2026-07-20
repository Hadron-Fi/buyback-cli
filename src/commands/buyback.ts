import { createInterface } from "node:readline/promises";
import { PublicKey } from "@solana/web3.js";
import {
  ensureOperatorKeypair,
  getConnection,
  loadConfig,
  saveConfig,
} from "../config.js";
import { simPrice } from "../lib/sim.js";
import { seedLadder } from "../buyback.js";
import { runCrank } from "./crank.js";

/**
 * Phase 2: `npm run buyback`. Prompts for the pool ID (Enter accepts the one
 * from init), seeds the pool with the resting bid ladder, and then runs the
 * crank in the same process. On the page: a toast fires when the orders land,
 * and the on-chain oracle line joins the market line on the chart.
 */
export async function buybackCommand(opts: { pool?: string; interval?: string; live?: boolean }): Promise<void> {
  const cfg = loadConfig();

  let poolId = opts.pool;
  if (!poolId) {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    const answer = (await rl.question(`Pool ID${cfg.pool ? ` [${cfg.pool}]` : ""}: `)).trim();
    rl.close();
    poolId = answer || cfg.pool;
  }
  if (!poolId) throw new Error("No pool ID given and none in config. Run npm run init first.");
  new PublicKey(poolId); // validate

  if (cfg.pool !== poolId) {
    cfg.pool = poolId;
    saveConfig(cfg);
  }

  const { keypair: operator } = ensureOperatorKeypair(cfg.keypairPath);
  const connection = getConnection(cfg);

  // Seed the ladder anchored at the sim's current value for this pool, so
  // the on-chain mid lands on the page's market line from the first moment.
  const anchor = simPrice(poolId, Date.now());
  console.log(`Seeding the buyback ladder on ${poolId} at $${anchor.toFixed(4)}...`);
  const seeded = await seedLadder(connection, operator, cfg, anchor);
  console.log(
    seeded
      ? `Ladder seeded: ${cfg.ladder.length} resting bids, $${cfg.ladder.reduce((a, r) => a + r.usd, 0)} of depth.`
      : "Ladder already on the pool; skipping seed."
  );

  console.log("Starting the crank (Ctrl-C stops it; the kill switch then halts buying)...\n");
  await runCrank({ interval: opts.interval, live: opts.live });
}
