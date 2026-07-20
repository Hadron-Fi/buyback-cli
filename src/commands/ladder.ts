import { PublicKey } from "@solana/web3.js";
import { Hadron, Interpolation, RiskMode, Side } from "@hadron-fi/sdk-v2";
import {
  ensureOperatorKeypair,
  getConnection,
  loadConfig,
  saveConfig,
  sendTx,
  usdToAtoms,
  baseToAtoms,
  BASE_DECIMALS,
  LadderRung,
} from "../config.js";

/** Parse "80:1000,200:2000,350:4000" into ladder rungs (bps:usd). */
export function parseLadderSpec(spec: string): LadderRung[] {
  const rungs = spec.split(",").map((part) => {
    const [bps, usd] = part.split(":").map((x) => Number(x.trim()));
    if (!Number.isFinite(bps) || !Number.isFinite(usd) || bps <= 0 || usd <= 0) {
      throw new Error(`Bad ladder entry "${part}" (expected spreadBps:usd, e.g. 80:1000)`);
    }
    return { spreadBps: Math.round(bps), usd };
  });
  if (rungs.length === 0) throw new Error("Empty ladder spec");
  rungs.sort((a, b) => a.spreadBps - b.spreadBps);
  return rungs;
}

/**
 * Rebuild the resting bid ladder to a new set of levels: a FULL risk-curve
 * rewrite anchored at the current fill pointer (the base vault balance), so
 * prior fills stay behind the anchor and the new levels ladder out from it.
 * Tops up the treasury if the new notional exceeds the USDC on hand.
 */
export async function ladderCommand(opts: { set: string }): Promise<void> {
  const cfg = loadConfig();
  if (!cfg.pool) throw new Error("No pool in config; run npm run init first.");
  const rungs = parseLadderSpec(opts.set);

  const { keypair: operator } = ensureOperatorKeypair(cfg.keypairPath);
  const connection = getConnection(cfg);
  const pool = await Hadron.load(connection, new PublicKey(cfg.pool));
  const mid = pool.getMidprice();

  const [vaultXBal, vaultYBal] = await Promise.all([
    connection.getTokenAccountBalance(pool.addresses.vaultX),
    connection.getTokenAccountBalance(pool.addresses.vaultY),
  ]);

  // Anchor at the live fill pointer; sizes convert at the current mid.
  let cum = BigInt(vaultXBal.value.amount);
  const points = rungs.map((r) => {
    const p = { vaultBalance: cum, priceFactor: 1 - r.spreadBps / 10_000, interpolation: Interpolation.Step };
    cum += baseToAtoms(r.usd / mid);
    return p;
  });
  points.push({
    vaultBalance: cum,
    priceFactor: 1 - rungs[rungs.length - 1].spreadBps / 10_000,
    interpolation: Interpolation.Step,
  });

  const ixs = [];
  const totalUsd = rungs.reduce((a, r) => a + r.usd, 0);
  const topUp = Math.max(0, totalUsd - (vaultYBal.value.uiAmount ?? 0));
  if (topUp > 0.01) {
    console.log(`Topping up the treasury with ${topUp.toFixed(2)} USDC to cover the new ladder...`);
    ixs.push(pool.deposit(operator.publicKey, { amountX: 0n, amountY: usdToAtoms(topUp) }));
  }
  ixs.push(
    pool.setRiskCurveAbsolute(operator.publicKey, {
      side: Side.Bid,
      defaultInterpolation: Interpolation.Step,
      points,
      riskMode: RiskMode.Integrated,
    })
  );

  await sendTx(connection, [operator], ixs, "UpdateLadder");
  cfg.ladder = rungs;
  saveConfig(cfg);
  console.log(
    `Ladder updated: ${rungs.map((r) => `$${r.usd}@${r.spreadBps}bps`).join(", ")} (anchored at the current fill pointer).`
  );
}
