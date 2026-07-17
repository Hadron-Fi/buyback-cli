import { Hadron, PoolState, fromQ32 } from "@hadron-fi/sdk-v2";
import {
  getConnection,
  loadConfig,
  requirePool,
  solscanAccount,
  BASE_DECIMALS,
} from "../config.js";
import { ladderStatus, totalFilledShfl } from "../lib/book-math.js";

/** Pool state, oracle freshness (kill switch), vaults, and ladder fill progress. */
export async function statusCommand(): Promise<void> {
  const cfg = loadConfig();
  const connection = getConnection(cfg);
  const pool = await Hadron.load(connection, requirePool(cfg));
  const base = cfg.baseSymbol;

  const [slot, vaultXBal, vaultYBal] = await Promise.all([
    connection.getSlot("confirmed"),
    connection.getTokenAccountBalance(pool.addresses.vaultX),
    connection.getTokenAccountBalance(pool.addresses.vaultY),
  ]);

  const mid = pool.getMidprice();
  const slotsSinceUpdate = BigInt(slot) - pool.oracle.lastUpdateSlot;
  const staleness = pool.config.deltaStaleness;
  const stale = staleness > 0 && slotsSinceUpdate > BigInt(staleness);

  console.log(`Pool ${pool.poolAddress.toBase58()}`);
  console.log(`  ${solscanAccount(pool.poolAddress.toBase58(), connection.rpcEndpoint)}`);
  console.log(`  state:          ${PoolState[pool.config.state]}`);
  console.log(`  midprice:       $${mid.toFixed(6)} (oracle seq ${pool.oracle.sequence})`);
  console.log(`  base spread:    factor ${fromQ32(pool.oracle.spreadFactorQ32)}`);
  console.log(
    `  oracle age:     ${slotsSinceUpdate} slots (kill switch at ${staleness || "disabled"})` +
      (stale ? "  << KILL SWITCH ACTIVE: swaps revert until the crank updates the mid >>" : "")
  );
  console.log(
    `  vaults:         ${vaultXBal.value.uiAmountString} ${base} bought / ${vaultYBal.value.uiAmountString} USDC remaining to spend`
  );

  const bidPoints = pool.getActiveCurves().riskBid.points;
  if (bidPoints.length < 2) {
    console.log("  ladder:         not placed yet");
    return;
  }

  const vaultX = BigInt(vaultXBal.value.amount);
  const rungs = ladderStatus(bidPoints, vaultX, BASE_DECIMALS, mid);
  console.log(`  bought so far:  ${totalFilledShfl(bidPoints, vaultX, BASE_DECIMALS).toFixed(4)} ${base}`);
  console.log("\n  bid ladder (moves with mid):");
  console.log(`    rung  spread   price        size ${base}     filled        remaining`);
  rungs.forEach((r, i) => {
    const pct = r.sizeShfl > 0 ? ((r.filledShfl / r.sizeShfl) * 100).toFixed(1) : "0.0";
    console.log(
      `    ${i + 1}     ${String(r.spreadBps).padEnd(4)} bps $${r.price.toFixed(6)}   ` +
        `${r.sizeShfl.toFixed(4).padEnd(12)} ${r.filledShfl.toFixed(4).padEnd(12)} ${r.remainingShfl.toFixed(4)} (${pct}% filled)`
    );
  });
}
