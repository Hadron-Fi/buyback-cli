import {
  Connection,
  Keypair,
  PublicKey,
  Transaction,
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
  explainTxError,
  saveConfig,
  sendTx,
  solscanTx,
  usdToAtoms,
  baseToAtoms,
  BASE_DECIMALS,
  USD_DECIMALS,
} from "./config.js";
import { estimateSellOutput } from "./lib/book-math.js";

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

/** Mock-token balances for a wallet (0 when the ATA does not exist yet). */
export async function walletBalances(
  connection: Connection,
  cfg: BuybackConfig,
  wallet: PublicKey
): Promise<{ base: number; usdc: number }> {
  const out = { base: 0, usdc: 0 };
  const entries: Array<[keyof typeof out, string | undefined]> = [
    ["base", cfg.baseMint],
    ["usdc", cfg.usdcMint],
  ];
  for (const [key, mintStr] of entries) {
    if (!mintStr) continue;
    try {
      const ata = getAssociatedTokenAddressSync(new PublicKey(mintStr), wallet);
      const bal = await connection.getTokenAccountBalance(ata);
      out[key] = bal.value.uiAmount ?? 0;
    } catch {
      // no ATA yet -> 0
    }
  }
  return out;
}

/**
 * Demonstrate that buys are structurally impossible: simulate a USDC->base
 * swap against the real program (operator as the buyer, no send, no fee) and
 * return the on-chain rejection. The pool has no ask curve, so the program
 * refuses to sell the base token.
 */
export async function simulateBuy(
  connection: Connection,
  operator: Keypair,
  cfg: BuybackConfig,
  amountUsdc: number
): Promise<{ rejected: boolean; reason: string }> {
  if (!cfg.pool) throw new Error("No pool yet; init buybacks first.");
  const pool = await Hadron.load(connection, new PublicKey(cfg.pool));
  const feeRecipient = pool.feeConfig?.feeRecipient;
  const ixs = [];
  if (feeRecipient) {
    // Fee is taken from the input token (USDC on a buy); its ATA must exist
    // for the simulation to reach the actual curve check.
    ixs.push(
      createAssociatedTokenAccountIdempotentInstruction(
        operator.publicKey,
        getAssociatedTokenAddressSync(pool.config.mintY, feeRecipient, true),
        feeRecipient,
        pool.config.mintY
      )
    );
  }
  ixs.push(pool.swap(operator.publicKey, { isX: false, amountIn: usdToAtoms(amountUsdc), minOut: 0n }));
  const tx = new Transaction().add(...ixs);
  tx.feePayer = operator.publicKey;
  tx.recentBlockhash = (await connection.getLatestBlockhash()).blockhash;
  tx.sign(operator);
  const sim = await connection.simulateTransaction(tx);
  if (sim.value.err) {
    return { rejected: true, reason: explainTxError({ logs: sim.value.logs ?? [] }) };
  }
  return { rejected: false, reason: "buy unexpectedly succeeded" };
}

export interface SellQuote {
  txBase64: string;
  estOutUsdc: number;
  minOutUsdc: number;
  mid: number;
  feePpm: number;
}

/**
 * Build an unsigned sell transaction (seller sells base into the buyback bids)
 * for the browser wallet to sign. Includes idempotent ATA creation for the
 * seller's USDC account and the fee-recipient account. Returns a base64 legacy
 * transaction with the fee payer and a fresh blockhash already set.
 */
export async function buildSellTx(
  connection: Connection,
  cfg: BuybackConfig,
  seller: PublicKey,
  amountBase: number,
  slippageBps: number
): Promise<SellQuote> {
  if (!cfg.pool) throw new Error("No pool yet; init buybacks first.");
  const pool = await Hadron.load(connection, new PublicKey(cfg.pool));
  const mid = pool.getMidprice();
  const feePpm = pool.feeConfig?.feePpm ?? 0;

  const amountIn = baseToAtoms(amountBase);
  const fee = (amountIn * BigInt(feePpm)) / 1_000_000n;
  const vaultXBal = await connection.getTokenAccountBalance(pool.addresses.vaultX);
  const bidPoints = pool.getActiveCurves().riskBid.points;
  if (bidPoints.length < 2) throw new Error("Pool has no bid ladder.");
  const est = estimateSellOutput(bidPoints, BigInt(vaultXBal.value.amount), amountIn - fee, mid);
  const minOut = (est.outAtoms * BigInt(10_000 - slippageBps)) / 10_000n;

  const feeRecipient = pool.feeConfig?.feeRecipient;
  const ixs = [
    createAssociatedTokenAccountIdempotentInstruction(
      seller,
      getAssociatedTokenAddressSync(pool.config.mintY, seller),
      seller,
      pool.config.mintY
    ),
  ];
  if (feeRecipient) {
    ixs.push(
      createAssociatedTokenAccountIdempotentInstruction(
        seller,
        getAssociatedTokenAddressSync(pool.config.mintX, feeRecipient, true),
        feeRecipient,
        pool.config.mintX
      )
    );
  }
  ixs.push(pool.swap(seller, { isX: true, amountIn, minOut }));

  const tx = new Transaction().add(...ixs);
  tx.feePayer = seller;
  tx.recentBlockhash = (await connection.getLatestBlockhash()).blockhash;

  return {
    txBase64: tx.serialize({ requireAllSignatures: false }).toString("base64"),
    estOutUsdc: Number(est.outAtoms) / 10 ** USD_DECIMALS,
    minOutUsdc: Number(minOut) / 10 ** USD_DECIMALS,
    mid,
    feePpm,
  };
}
