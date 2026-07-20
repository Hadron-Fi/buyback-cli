import { statSync } from "node:fs";
import { PublicKey } from "@solana/web3.js";
import { Hadron, decodeMidpriceOracle, toQ32 } from "@hadron-fi/sdk-v2";
import {
  BuybackConfig,
  ensureOperatorKeypair,
  ensureSol,
  getConnection,
  loadOrCreateConfig,
  saveConfig,
  sendTx,
  CONFIG_PATH,
} from "../config.js";
import { PriceFeed, Ema } from "../lib/price-feed.js";
import { simPrice } from "../lib/sim.js";

/**
 * The crank: a pure price loop. The market price is the DETERMINISTIC sim
 * keyed by the pool ID (the dashboard page computes the exact same line
 * independently), or the live exchange feed with --live. It EMA-smooths the
 * price and posts min(EMA, market) as the on-chain pool midprice at a
 * throttled cadence. The chain is the only link between this process and
 * the UI.
 */
export async function runCrank(opts: { interval?: string; live?: boolean }): Promise<void> {
  let cfg: BuybackConfig = loadOrCreateConfig();
  const connection = getConnection(cfg);
  const intervalMs = opts.interval ? Number(opts.interval) : cfg.crank.intervalMs;

  const { keypair: operator, path } = ensureOperatorKeypair(cfg.keypairPath);
  cfg.keypairPath = path;
  saveConfig(cfg);
  console.log(`Operator: ${operator.publicKey.toBase58()}`);
  await ensureSol(connection, operator.publicKey, 1);

  const ema = new Ema(cfg.crank.emaAlpha);
  const feed = opts.live ? new PriceFeed(cfg.priceSymbols) : null;
  console.log(
    `Price source: ${feed ? `live (${cfg.priceSymbols.join(" -> ")})` : "deterministic sim (seeded by pool ID; the page computes the same line)"}`
  );

  function samplePrice(): Promise<number> {
    if (feed) return feed.fetchPrice();
    return Promise.resolve(simPrice(cfg.pool ?? "hadron", Date.now()));
  }

  let pool: Hadron | null = null;
  async function setPool(address: string | undefined): Promise<void> {
    pool = address ? await Hadron.load(connection, new PublicKey(address)) : null;
  }
  if (cfg.pool) await setPool(cfg.pool);

  // The CLI (`close`, `init`, `buyback`) edits buyback.config.json from
  // another process while the crank runs; watch the file so the crank never
  // posts to a stale pool and picks up a fresh one without a restart.
  let cfgMtime = statSync(CONFIG_PATH).mtimeMs;
  async function reloadConfigIfChanged(): Promise<void> {
    let mtime: number;
    try {
      mtime = statSync(CONFIG_PATH).mtimeMs;
    } catch {
      return;
    }
    if (mtime === cfgMtime) return;
    cfgMtime = mtime;
    const prevPool = cfg.pool;
    cfg = loadOrCreateConfig();
    if (cfg.pool !== prevPool) {
      console.log(`Config changed: pool ${prevPool ?? "none"} -> ${cfg.pool ?? "none"}; reloading`);
      await setPool(cfg.pool);
    }
  }

  async function pushMid(oracleMid: number): Promise<void> {
    if (!pool) return;
    const oracleInfo = await connection.getAccountInfo(pool.addresses.midpriceOracle);
    if (!oracleInfo) throw new Error("oracle account missing");
    const oracle = decodeMidpriceOracle(oracleInfo.data);
    await sendTx(
      connection,
      [operator],
      [pool.updateMidprice(operator.publicKey, { midpriceQ32: toQ32(oracleMid), sequence: oracle.sequence + 1n })],
      "updateMidprice"
    );
  }

  // Throttle on-chain pushes: every tick would drown rate-limited RPCs. The
  // heartbeat log keeps full cadence regardless.
  let chainBusy = false;
  let lastPushAt = 0;
  let tickCount = 0;

  async function tick(): Promise<void> {
    try {
      await reloadConfigIfChanged();
      const price = await samplePrice();
      const smoothed = ema.update(price);
      // min(EMA, market): smoothed on the way up, instant on the way down,
      // so the pool never overbids off a lagging EMA.
      const oracleMid = Math.min(smoothed, price);

      tickCount++;
      console.log(
        `price $${price.toFixed(4)}  ema $${smoothed.toFixed(4)}  oracle $${oracleMid.toFixed(4)}` +
          (pool ? "" : "  (no pool)")
      );
      if (!pool && tickCount % 20 === 1) {
        console.log('No pool yet: run "npm run init" in another terminal first.');
      }

      const pushEvery = cfg.crank.pushIntervalMs ?? 4000;
      if (pool && !chainBusy && Date.now() - lastPushAt >= pushEvery) {
        lastPushAt = Date.now();
        chainBusy = true;
        pushMid(oracleMid)
          .catch((err) => {
            console.error(`chain push: ${err instanceof Error ? err.message : err}`);
          })
          .finally(() => {
            chainBusy = false;
          });
      }
    } catch (err) {
      console.error(`tick: ${err instanceof Error ? err.message : err}`);
    }
  }

  await tick();
  setInterval(tick, intervalMs);
}

export async function crankCommand(opts: { interval?: string; live?: boolean }): Promise<void> {
  return runCrank(opts);
}
