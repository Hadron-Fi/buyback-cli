import {
  Connection,
  Keypair,
  LAMPORTS_PER_SOL,
  PublicKey,
  Transaction,
  TransactionInstruction,
} from "@solana/web3.js";
import { getHadronErrorMessage } from "@hadron-fi/sdk-v2";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";

export interface LadderRung {
  /** USD notional resting at this rung. */
  usd: number;
  /** Distance below midprice in basis points. */
  spreadBps: number;
}

export interface BuybackConfig {
  rpcUrl: string;
  keypairPath: string;
  /** Base asset symbol shown in the UI (buyback target). */
  baseSymbol: string;
  /** "sim" = dummy random-walk price (demo default); "live" = exchange feed. */
  priceMode: "sim" | "live";
  /** Per-tick volatility of the simulated walk (priceMode "sim"). */
  simVolPerTick: number;
  /** Binance-style ticker symbols to try in order for the base/USD price. */
  priceSymbols: string[];
  /** Mock base mint (the buyback asset, token X). Set on init. */
  baseMint?: string;
  /** Mock USDC mint (quote, token Y). Set on init. */
  usdcMint?: string;
  /** Pool config PDA. Set on init. */
  pool?: string;
  /** Pool seed as a decimal string. Set on init. */
  seed?: string;
  /** Initial midprice in USD per base unit (seeded from the live feed at init). */
  startPrice: number;
  /** Kill switch: max slots since the last oracle update before swaps revert. */
  deltaStaleness: number;
  /** The resting bid ladder, tightest first. */
  ladder: LadderRung[];
  /** Local port the crank's API server listens on. */
  crankApiPort: number;
  crank: {
    /** Milliseconds between crank ticks. */
    intervalMs: number;
    /** EMA smoothing factor (0..1, higher = follows price faster). */
    emaAlpha: number;
  };
}

export const DEFAULT_CONFIG: BuybackConfig = {
  rpcUrl: "https://api.devnet.solana.com",
  keypairPath: "~/.config/solana/id.json",
  baseSymbol: "SOL",
  // Live exchange feed by default; pass --sim to the crank (or set "sim"
  // here) for a dummy random walk when the real market is too quiet to demo.
  priceMode: "live",
  simVolPerTick: 0.0012,
  // Binance.com first (works from most locations), then Binance.US (SOLUSD),
  // then Coinbase as a final fallback. The feed module picks the first live one.
  priceSymbols: ["SOLUSDT", "SOLUSD", "SOL-USD"],
  startPrice: 75,
  // ~10s of slots. The design doc's example is 10 slots (every-block crank on
  // low-latency infra); 25 keeps the pool live at a ~2s tick and still trips
  // within seconds of the crank stopping.
  deltaStaleness: 25,
  ladder: [
    { usd: 1000, spreadBps: 80 },
    { usd: 2000, spreadBps: 200 },
    { usd: 4000, spreadBps: 350 },
  ],
  crankApiPort: 8787,
  // 1s sampling: ticks are cheap (the on-chain push runs decoupled behind a
  // busy flag). EMA alpha 0.08 ≈ 30s of smoothing at 1s ticks, slow enough
  // that the oracle line visibly trails the price on the chart.
  crank: { intervalMs: 1000, emaAlpha: 0.08 },
};

export const CONFIG_PATH = resolve(process.cwd(), "buyback.config.json");

export function loadConfig(): BuybackConfig {
  if (!existsSync(CONFIG_PATH)) {
    throw new Error(
      `No buyback.config.json found at ${CONFIG_PATH}. Start the crank first: npm run crank`
    );
  }
  return { ...DEFAULT_CONFIG, ...JSON.parse(readFileSync(CONFIG_PATH, "utf8")) };
}

/** Load the config, writing a fresh default one if it does not exist yet. */
export function loadOrCreateConfig(): BuybackConfig {
  if (!existsSync(CONFIG_PATH)) {
    saveConfig(DEFAULT_CONFIG);
    return { ...DEFAULT_CONFIG };
  }
  return loadConfig();
}

export function saveConfig(cfg: BuybackConfig): void {
  writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2) + "\n");
}

function expandPath(path: string): string {
  return path.startsWith("~") ? path.replace("~", homedir()) : resolve(path);
}

export function loadKeypair(path: string): Keypair {
  const expanded = expandPath(path);
  if (!existsSync(expanded)) {
    throw new Error(
      `Wallet not found at ${expanded}. Run "npm run cli -- init" (it creates a devnet wallet if you have none), or pass --keypair <path>.`
    );
  }
  const raw = JSON.parse(readFileSync(expanded, "utf8"));
  return Keypair.fromSecretKey(Uint8Array.from(raw));
}

/** Repo-local wallet created when no keypair exists (devnet throwaway). */
export const LOCAL_WALLET_PATH = resolve(process.cwd(), "wallet.json");

/**
 * Resolve the operator wallet for `init`. Order: the requested path if it
 * exists, else a previously created repo-local wallet.json, else a freshly
 * generated wallet.json. Returns the path actually used so it can be saved
 * to the config.
 */
export function ensureOperatorKeypair(preferredPath: string): {
  keypair: Keypair;
  path: string;
  created: boolean;
} {
  const expanded = expandPath(preferredPath);
  if (existsSync(expanded)) {
    return { keypair: loadKeypair(expanded), path: preferredPath, created: false };
  }
  if (existsSync(LOCAL_WALLET_PATH)) {
    return { keypair: loadKeypair(LOCAL_WALLET_PATH), path: LOCAL_WALLET_PATH, created: false };
  }
  const keypair = Keypair.generate();
  writeFileSync(LOCAL_WALLET_PATH, JSON.stringify(Array.from(keypair.secretKey)), {
    mode: 0o600,
  });
  return { keypair, path: LOCAL_WALLET_PATH, created: true };
}

/**
 * Make sure the wallet has enough devnet SOL, requesting an airdrop when it
 * does not. Airdrops on public devnet are rate limited, so failure is
 * reported with a manual faucet fallback instead of aborting.
 */
export async function ensureSol(
  connection: Connection,
  wallet: PublicKey,
  minSol = 1
): Promise<number> {
  let balance = await connection.getBalance(wallet);
  if (balance >= minSol * LAMPORTS_PER_SOL) return balance;

  console.log(
    `Balance is ${(balance / LAMPORTS_PER_SOL).toFixed(3)} SOL; requesting a 2 SOL devnet airdrop...`
  );
  try {
    const sig = await connection.requestAirdrop(wallet, 2 * LAMPORTS_PER_SOL);
    for (let i = 0; i < 30; i++) {
      const st = (await connection.getSignatureStatuses([sig])).value[0];
      if (st?.confirmationStatus === "confirmed" || st?.confirmationStatus === "finalized") break;
      await new Promise((r) => setTimeout(r, 1000));
    }
    balance = await connection.getBalance(wallet);
    console.log(`Airdrop landed: ${(balance / LAMPORTS_PER_SOL).toFixed(3)} SOL`);
    console.log(`  ${solscanTx(sig, connection.rpcEndpoint)}`);
  } catch (err) {
    console.log(
      `Airdrop failed (${err instanceof Error ? err.message.split("\n")[0] : err}). ` +
        `Fund the wallet manually at https://faucet.solana.com (address ${wallet.toBase58()}), then re-run.`
    );
  }
  return balance;
}

function clusterSuffix(rpcUrl: string): string {
  if (rpcUrl.includes("devnet")) return "?cluster=devnet";
  if (rpcUrl.includes("testnet")) return "?cluster=testnet";
  return "";
}

/** Solscan link for a transaction on whichever cluster the RPC points at. */
export function solscanTx(sig: string, rpcUrl: string): string {
  return `https://solscan.io/tx/${sig}${clusterSuffix(rpcUrl)}`;
}

/** Solscan link for an account/mint. */
export function solscanAccount(address: string, rpcUrl: string): string {
  return `https://solscan.io/account/${address}${clusterSuffix(rpcUrl)}`;
}

export function getConnection(cfg: BuybackConfig, urlOverride?: string): Connection {
  return new Connection(urlOverride ?? cfg.rpcUrl, "confirmed");
}

export function requirePool(cfg: BuybackConfig): PublicKey {
  if (!cfg.pool) {
    throw new Error('No pool in config. Run "npm run cli -- create-pool" first.');
  }
  return new PublicKey(cfg.pool);
}

/** Extract a Hadron program error from a failed-send error, if present. */
export function explainTxError(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err);
  const logs: string[] = (err as { logs?: string[] })?.logs ?? [];
  const haystack = [msg, ...logs].join("\n");
  const m = haystack.match(/custom program error: (0x[0-9a-fA-F]+)/);
  if (m) {
    const code = parseInt(m[1], 16);
    const known = getHadronErrorMessage(code);
    if (known) return `Hadron error ${code}: ${known}`;
    return `Program error code ${code}`;
  }
  return msg;
}

/**
 * Send instructions as one legacy transaction and confirm it by polling
 * signature statuses. Polling (instead of websocket subscriptions) keeps the
 * crank loop alive on rate-limited public RPCs, where the websocket path can
 * fail with 429s outside our control.
 */
export async function sendTx(
  connection: Connection,
  signers: Keypair[],
  ixs: TransactionInstruction[],
  label: string
): Promise<string> {
  const tx = new Transaction().add(...ixs);
  tx.feePayer = signers[0].publicKey;
  const { blockhash } = await connection.getLatestBlockhash();
  tx.recentBlockhash = blockhash;
  tx.sign(...signers);
  try {
    const sig = await connection.sendRawTransaction(tx.serialize(), {
      skipPreflight: false,
    });
    for (let i = 0; i < 40; i++) {
      const st = (await connection.getSignatureStatuses([sig])).value[0];
      if (st?.err) {
        throw new Error(`transaction failed on-chain: ${JSON.stringify(st.err)}`);
      }
      if (
        st?.confirmationStatus === "confirmed" ||
        st?.confirmationStatus === "finalized"
      ) {
        console.log(`  ${label}: ${solscanTx(sig, connection.rpcEndpoint)}`);
        return sig;
      }
      await new Promise((r) => setTimeout(r, 750));
    }
    throw new Error(`timed out waiting for confirmation of ${sig}`);
  } catch (err) {
    throw new Error(`${label} failed: ${explainTxError(err)}`);
  }
}

export const USD_DECIMALS = 6;
export const BASE_DECIMALS = 6;

export function usdToAtoms(usd: number): bigint {
  return BigInt(Math.round(usd * 10 ** USD_DECIMALS));
}

export function baseToAtoms(base: number): bigint {
  return BigInt(Math.round(base * 10 ** BASE_DECIMALS));
}

export function atomsToUi(atoms: bigint, decimals: number): number {
  return Number(atoms) / 10 ** decimals;
}
