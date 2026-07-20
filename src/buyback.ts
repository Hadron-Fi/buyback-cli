import {
  Connection,
  Keypair,
  PublicKey,
} from "@solana/web3.js";
import {
  createMint,
  getOrCreateAssociatedTokenAccount,
  mintTo,
  createAssociatedTokenAccountIdempotentInstruction,
  getAssociatedTokenAddressSync,
} from "@solana/spl-token";
import { Hadron, HadronOrderbook, PoolState, toQ32 } from "@hadron-fi/sdk-v2";
import {
  BuybackConfig,
  saveConfig,
  sendTx,
  solscanTx,
  usdToAtoms,
  baseToAtoms,
  BASE_DECIMALS,
  USD_DECIMALS,
} from "./config.js";

/**
 * One-shot "init buybacks": create the mock mints if needed, create the
 * bid-only pool anchored at the live price, arm the kill switch, fund the
 * treasury, and post the resting bid ladder. Everything is signed by the
 * operator keypair (the crank's key), so the dashboard button can trigger it
 * through the crank's local server without any browser signing.
 */
export async function initBuybacks(
  connection: Connection,
  operator: Keypair,
  cfg: BuybackConfig,
  livePrice: number
): Promise<{ pool: string; created: boolean }> {
  // Idempotent per step so a failed/partial init can be retried cleanly.
  const alreadyLive = !!cfg.pool;

  // 1. Mock mints (base = the buyback asset, quote = USDC). Operator keeps
  //    mint authority so it can faucet testers and fund the treasury.
  if (!cfg.baseMint || !cfg.usdcMint) {
    const baseMint = await createMint(connection, operator, operator.publicKey, null, BASE_DECIMALS);
    const usdcMint = await createMint(connection, operator, operator.publicKey, null, USD_DECIMALS);
    cfg.baseMint = baseMint.toBase58();
    cfg.usdcMint = usdcMint.toBase58();
    // Treasury USDC to spend on buybacks (ladder total, with headroom).
    const treasuryUsdc = cfg.ladder.reduce((a, r) => a + r.usd, 0) * 4;
    const usdcAta = await getOrCreateAssociatedTokenAccount(connection, operator, usdcMint, operator.publicKey);
    await mintTo(connection, operator, usdcMint, usdcAta.address, operator, usdToAtoms(treasuryUsdc));
    saveConfig(cfg);
  }

  const mintX = new PublicKey(cfg.baseMint);
  const mintY = new PublicKey(cfg.usdcMint);

  // 2. Create the pool anchored at the live market price (if not already made).
  let poolAddress: PublicKey;
  if (cfg.pool) {
    poolAddress = new PublicKey(cfg.pool);
  } else {
    const { instructions, poolAddress: addr, seed } = Hadron.initialize(operator.publicKey, {
      mintX,
      mintY,
      authority: operator.publicKey,
      initialMidpriceQ32: toQ32(livePrice),
      maxPrefabSlots: 1,
      maxCurvePoints: 8,
    });
    await sendTx(connection, [operator], instructions.slice(0, -1), "AllocateCurvePrefabs");
    await sendTx(connection, [operator], [instructions[instructions.length - 1]], "Initialize");
    poolAddress = addr;
    cfg.pool = addr.toBase58();
    cfg.seed = seed.toString();
    cfg.startPrice = livePrice;
    saveConfig(cfg);
  }

  // 3. Arm the kill switch and open the pool (skip whatever is already set).
  const pool = await Hadron.load(connection, poolAddress);
  const stateIxs = [];
  if (pool.config.deltaStaleness !== cfg.deltaStaleness) {
    stateIxs.push(pool.updateDeltaStaleness(operator.publicKey, { deltaStaleness: cfg.deltaStaleness }));
  }
  if (pool.config.state !== PoolState.Initialized) {
    stateIxs.push(pool.setPoolState(operator.publicKey, { newState: PoolState.Initialized }));
  }
  if (stateIxs.length) await sendTx(connection, [operator], stateIxs, "ArmKillSwitch+Open");

  // 4. Deposit the treasury USDC and post the bid ladder in one atomic tx
  //    (skip if a ladder is already on the pool from a prior run).
  const book = await HadronOrderbook.load({ connection, pool: poolAddress });
  if (book.pool.getActiveCurves().riskBid.points.length < 2) {
    // Deposit references the operator's base (X) token account even when only
    // USDC is deposited, so both operator ATAs must exist first.
    await getOrCreateAssociatedTokenAccount(connection, operator, mintX, operator.publicKey);
    await getOrCreateAssociatedTokenAccount(connection, operator, mintY, operator.publicKey);
    const mid = book.pool.getMidprice();
    let totalUsd = 0;
    for (const rung of cfg.ladder) {
      book.placeOrder({ side: "bid", size: rung.usd / mid, spreadBps: rung.spreadBps });
      totalUsd += rung.usd;
    }
    const ladderIxs = [
      book.updateMidprice(operator.publicKey, mid, book.pool.oracle.sequence + 1n),
      book.deposit(operator.publicKey, { amountX: 0n, amountY: usdToAtoms(totalUsd) }),
      ...book.push(operator.publicKey),
    ];
    await sendTx(connection, [operator], ladderIxs, "PlaceLadder");
  }

  return { pool: cfg.pool, created: !alreadyLive };
}

/** Mint mock base tokens (the buyback asset) to any wallet so it can sell. */
export async function faucetBase(
  connection: Connection,
  operator: Keypair,
  cfg: BuybackConfig,
  recipient: PublicKey,
  uiAmount: number
): Promise<string> {
  if (!cfg.baseMint) throw new Error("Base mint not created yet; init buybacks first.");
  const mint = new PublicKey(cfg.baseMint);
  const ata = await getOrCreateAssociatedTokenAccount(connection, operator, mint, recipient);
  const sig = await mintTo(connection, operator, mint, ata.address, operator, baseToAtoms(uiAmount));
  console.log(`Faucet ${uiAmount} ${cfg.baseSymbol} -> ${recipient.toBase58()}: ${solscanTx(sig, connection.rpcEndpoint)}`);
  return sig;
}
