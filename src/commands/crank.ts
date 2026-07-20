import { createServer, IncomingMessage, ServerResponse } from "node:http";
import { exec } from "node:child_process";
import { statSync } from "node:fs";
import { PublicKey } from "@solana/web3.js";
import bs58 from "bs58";
import { Hadron, PoolState, decodeMidpriceOracle, toQ32, fromQ32 } from "@hadron-fi/sdk-v2";
import {
  ensureOperatorKeypair,
  ensureSol,
  getConnection,
  loadOrCreateConfig,
  saveConfig,
  sendTx,
  solscanTx,
  CONFIG_PATH,
  BASE_DECIMALS,
  USD_DECIMALS,
} from "../config.js";
import { PriceFeed, Ema } from "../lib/price-feed.js";
import { ladderStatus } from "../lib/book-math.js";
import { faucetBase, buildSellTx, walletBalances, simulateBuy } from "../buyback.js";

/** SPL token account balance lives at byte offset 64 (u64 LE). */
function tokenAmount(data: Buffer): bigint {
  return new DataView(data.buffer, data.byteOffset, data.length).getBigUint64(64, true);
}

interface PriceSample {
  t: number;
  price: number;
}
interface OracleSample {
  t: number;
  mid: number;
}

const UPDATE_MIDPRICE_DISC = 5;
const UPDATE_MID_AND_SPREAD_DISC = 10;

/**
 * The crank AND the dashboard's backend. On startup it makes sure the operator
 * wallet exists and is funded, streams the base/USD price (live feed, or a
 * random walk with --sim), keeps an EMA, and (once the pool is live) posts
 * min(EMA, market) as the on-chain midprice every tick. It also serves a small
 * JSON API the dashboard drives: read state, init buybacks, faucet the base
 * token, and build/broadcast sell transactions.
 *
 * The oracle-mid chart series is derived from ON-CHAIN transactions (backfilled
 * from the oracle account's history and appended as each push confirms), not
 * from crank memory, so it survives restarts and reflects what the pool
 * actually quoted.
 */
export async function crankCommand(opts: {
  interval?: string;
  port?: string;
  sim?: boolean;
}): Promise<void> {
  let cfg = loadOrCreateConfig();
  const connection = getConnection(cfg);
  const intervalMs = opts.interval ? Number(opts.interval) : cfg.crank.intervalMs;
  const port = opts.port ? Number(opts.port) : cfg.crankApiPort;

  const { keypair: operator, path } = ensureOperatorKeypair(cfg.keypairPath);
  cfg.keypairPath = path;
  saveConfig(cfg);
  console.log(`Operator: ${operator.publicKey.toBase58()}`);
  await ensureSol(connection, operator.publicKey, 1);

  const ema = new Ema(cfg.crank.emaAlpha);
  const priceHistory: PriceSample[] = [];
  let oracleHistory: OracleSample[] = [];
  const bestSpread = () => (cfg.ladder.length ? cfg.ladder[0].spreadBps / 10_000 : 0);

  // Price source: live exchange feed by default; --sim (or priceMode "sim"
  // in the config) switches to a dummy random walk for demos.
  const simMode = opts.sim || cfg.priceMode === "sim";
  const feed = simMode ? null : new PriceFeed(cfg.priceSymbols);
  console.log(`Price source: ${simMode ? "simulated random walk" : `live (${cfg.priceSymbols.join(" -> ")})`}`);
  let simPrice = cfg.startPrice;
  const simVol = cfg.simVolPerTick ?? 0.0012;
  function samplePrice(): Promise<number> {
    if (feed) return feed.fetchPrice();
    const u1 = Math.max(Math.random(), 1e-12);
    const u2 = Math.random();
    const z = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
    simPrice *= Math.exp(simVol * z - (simVol * simVol) / 2);
    return Promise.resolve(simPrice);
  }

  let pool: Hadron | null = null;
  let ladderReady = false;
  let lastError: string | null = null;
  let state: any = { baseSymbol: cfg.baseSymbol, operator: operator.publicKey.toBase58(), hasPool: false };

  // Init runs via the CLI (`npm run cli -- init`); the dashboard just watches
  // these steps flip as the CLI writes config + chain state and the crank's
  // config watcher picks them up.
  function initSteps() {
    return [
      { label: "Create mock SOL + USDC mints", done: !!(cfg.baseMint && cfg.usdcMint) },
      { label: "Create the bid-only pool", done: !!pool },
      { label: "Open pool + arm kill switch", done: !!pool && pool.config.state === PoolState.Initialized },
      { label: "Deposit treasury + post bid ladder", done: ladderReady },
    ];
  }

  /**
   * Rebuild the oracle-mid series from the chain: every UpdateMidprice tx on
   * the pool's oracle account, decoded from raw instruction data.
   */
  async function backfillOracleHistory(p: Hadron): Promise<void> {
    try {
      const sigs = await connection.getSignaturesForAddress(p.addresses.midpriceOracle, { limit: 100 });
      const ok = sigs.filter((s) => !s.err && s.blockTime);
      const txs = await connection.getParsedTransactions(
        ok.map((s) => s.signature),
        { maxSupportedTransactionVersion: 0 }
      );
      const samples: OracleSample[] = [];
      txs.forEach((tx, i) => {
        const bt = ok[i].blockTime;
        if (!tx || !bt) return;
        for (const ix of tx.transaction.message.instructions) {
          if (!("data" in ix) || !ix.programId.equals(p.programId)) continue;
          const data = Buffer.from(bs58.decode(ix.data));
          if ((data[0] === UPDATE_MIDPRICE_DISC || data[0] === UPDATE_MID_AND_SPREAD_DISC) && data.length >= 17) {
            samples.push({ t: bt * 1000, mid: fromQ32(data.readBigUInt64LE(9)) });
          }
        }
      });
      samples.sort((a, b) => a.t - b.t);
      oracleHistory = samples;
      console.log(`Backfilled ${samples.length} on-chain oracle updates for ${p.poolAddress.toBase58()}`);
    } catch (err) {
      console.error(`oracle backfill: ${err instanceof Error ? err.message : err}`);
    }
  }

  async function setPool(address: string | undefined): Promise<void> {
    if (!address) {
      pool = null;
      ladderReady = false;
      oracleHistory = [];
      state = { ...state, hasPool: false, pool: undefined, rungs: [], avgCost: null };
      return;
    }
    pool = await Hadron.load(connection, new PublicKey(address));
    ladderReady = pool.getActiveCurves().riskBid.points.length >= 2;
    await backfillOracleHistory(pool);
  }

  if (cfg.pool) await setPool(cfg.pool);

  // The CLI (`close`, headless `init`) edits buyback.config.json from another
  // process while the crank runs; watch the file so the crank never keeps
  // posting to a stale pool.
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

  async function refreshPoolState(oracleMid: number): Promise<void> {
    if (!pool) return;
    // Mid-init the CLI writes the ladder AFTER the pool exists; the cached
    // curve data won't see it, so reload until the ladder shows up.
    if (!ladderReady) {
      pool = await Hadron.load(connection, pool.poolAddress);
      ladderReady = pool.getActiveCurves().riskBid.points.length >= 2;
    }
    const [oracleInfo, vaultXInfo, vaultYInfo] = await connection.getMultipleAccountsInfo([
      pool.addresses.midpriceOracle,
      pool.addresses.vaultX,
      pool.addresses.vaultY,
    ]);
    if (!oracleInfo || !vaultXInfo || !vaultYInfo) throw new Error("pool accounts missing");
    const oracle = decodeMidpriceOracle(oracleInfo.data);

    // Post the mid on-chain (operator = quoting authority); once confirmed it
    // IS an on-chain data point. Stamp the sample with the time the mid was
    // COMPUTED, not when the tx confirmed; stamping at confirmation shifts
    // the oracle line several seconds right and makes it look like it was
    // quoting above a falling market when it was correct at compute time.
    const computedAt = Date.now();
    await sendTx(
      connection,
      [operator],
      [pool.updateMidprice(operator.publicKey, { midpriceQ32: toQ32(oracleMid), sequence: oracle.sequence + 1n })],
      "updateMidprice"
    );
    oracleHistory.push({ t: computedAt, mid: oracleMid });
    if (oracleHistory.length > 1800) oracleHistory.shift();

    const poolMid = fromQ32(oracle.midpriceQ32);
    const vaultX = tokenAmount(vaultXInfo.data);
    const vaultBase = Number(vaultX) / 10 ** BASE_DECIMALS;
    const vaultUsdc = Number(tokenAmount(vaultYInfo.data)) / 10 ** USD_DECIMALS;
    const bidPoints = pool.getActiveCurves().riskBid.points;
    const rungs = bidPoints.length >= 2 ? ladderStatus(bidPoints, vaultX, BASE_DECIMALS, poolMid) : [];

    // Average cost of everything bought so far: USDC actually spent out of the
    // treasury divided by base tokens received.
    const treasuryUsd = cfg.ladder.reduce((a, r) => a + r.usd, 0);
    const spentUsd = Math.max(0, treasuryUsd - vaultUsdc);
    const avgCost = vaultBase > 1e-9 ? spentUsd / vaultBase : null;

    state = {
      ...state,
      hasPool: true,
      pool: pool.poolAddress.toBase58(),
      baseMint: cfg.baseMint,
      usdcMint: cfg.usdcMint,
      poolState: PoolState[pool.config.state],
      poolMid,
      sequence: oracle.sequence.toString(),
      vaultBase,
      vaultUsdc,
      avgCost,
      rungs,
    };
    lastError = null;
  }

  // The price loop must never wait on devnet: a confirmation takes several
  // seconds, and overlapping pushes would race on the oracle sequence. The
  // chain push runs fire-and-forget behind a busy flag.
  let chainBusy = false;
  let tickCount = 0;
  let lastPushAt = 0;

  async function tick(): Promise<void> {
    try {
      await reloadConfigIfChanged();
      const price = await samplePrice();
      const smoothed = ema.update(price);
      // The posted mid is min(EMA, market): smoothed on the way up, instant
      // on the way down, so the pool never overbids off a lagging EMA.
      const oracleMid = Math.min(smoothed, price);
      priceHistory.push({ t: Date.now(), price });
      if (priceHistory.length > 1800) priceHistory.shift();

      state = {
        ...state,
        baseSymbol: cfg.baseSymbol,
        operator: operator.publicKey.toBase58(),
        priceSource: feed ? feed.lastLabel : "simulated",
        assetPrice: price,
        ema: smoothed,
        oracleMid,
        bestBid: oracleMid * (1 - bestSpread()),
        bestSpreadBps: cfg.ladder.length ? cfg.ladder[0].spreadBps : 0,
        priceHistory,
        oracleHistory,
        initSteps: initSteps(),
        ladderReady,
        error: lastError,
      };

      // Visible heartbeat: one compact line per tick so the crank never
      // looks stalled, plus a nudge when there is no pool to quote yet.
      tickCount++;
      console.log(
        `price $${price.toFixed(4)}  ema $${smoothed.toFixed(4)}  oracle $${oracleMid.toFixed(4)}` +
          (pool ? "" : "  (no pool)")
      );
      if (!pool && tickCount % 20 === 1) {
        console.log('No pool yet: run "npm run cli -- init" in another terminal to stand up the buybacks.');
      }

      // Throttle on-chain pushes: every tick would drown rate-limited RPCs
      // (the public devnet endpoint 429s hard); the price/UI loop stays at
      // full cadence regardless.
      const pushEvery = cfg.crank.pushIntervalMs ?? 4000;
      if (pool && !chainBusy && Date.now() - lastPushAt >= pushEvery) {
        lastPushAt = Date.now();
        chainBusy = true;
        refreshPoolState(oracleMid)
          .catch((err) => {
            lastError = err instanceof Error ? err.message : String(err);
            console.error(`chain push: ${lastError}`);
          })
          .finally(() => {
            chainBusy = false;
          });
      }
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
      state = { ...state, error: lastError };
      console.error(`tick: ${lastError}`);
    }
  }

  await tick();
  setInterval(tick, intervalMs);

  // ---- HTTP API ----
  function cors(res: ServerResponse): void {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");
    // Chrome sends a private-network preflight when the hosted (HTTPS) page
    // calls this localhost API; this header lets it through.
    res.setHeader("Access-Control-Allow-Private-Network", "true");
  }
  function json(res: ServerResponse, code: number, body: unknown): void {
    cors(res);
    res.writeHead(code, { "content-type": "application/json", "cache-control": "no-store" });
    res.end(JSON.stringify(body));
  }
  async function readBody(req: IncomingMessage): Promise<any> {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const raw = Buffer.concat(chunks).toString("utf8");
    return raw ? JSON.parse(raw) : {};
  }

  createServer(async (req, res) => {
    if (req.method === "OPTIONS") return json(res, 200, {});
    try {
      const url = req.url || "/";
      if (req.method === "GET" && url.startsWith("/api/state")) {
        return json(res, 200, state);
      }
      if (req.method === "GET" && url.startsWith("/api/balance")) {
        const wallet = new URL(url, "http://localhost").searchParams.get("wallet");
        if (!wallet) return json(res, 400, { error: "wallet query param required" });
        return json(res, 200, await walletBalances(connection, cfg, new PublicKey(wallet)));
      }
      if (req.method === "POST" && url.startsWith("/api/try-buy")) {
        const body = await readBody(req);
        const result = await simulateBuy(connection, operator, cfg, Number(body.amountUsdc ?? 10));
        return json(res, 200, result);
      }
      if (req.method === "POST" && url.startsWith("/api/faucet")) {
        const body = await readBody(req);
        const wallet = new PublicKey(body.wallet);
        const sig = await faucetBase(connection, operator, cfg, wallet, Number(body.amount ?? 100));
        return json(res, 200, { sig });
      }
      if (req.method === "POST" && url.startsWith("/api/build-swap")) {
        const body = await readBody(req);
        const quote = await buildSellTx(
          connection,
          cfg,
          new PublicKey(body.seller),
          Number(body.amountBase),
          Number(body.slippageBps ?? 100)
        );
        return json(res, 200, quote);
      }
      if (req.method === "POST" && url.startsWith("/api/send")) {
        // Broadcast a browser-signed tx on our devnet RPC (so the send does not
        // depend on the wallet's selected cluster, and the RPC key stays here).
        const body = await readBody(req);
        const raw = Buffer.from(body.signedTxBase64, "base64");
        const sig = await connection.sendRawTransaction(raw);
        await connection.confirmTransaction(sig, "confirmed");
        return json(res, 200, { sig, url: solscanTx(sig, connection.rpcEndpoint) });
      }
      return json(res, 404, { error: "not found" });
    } catch (err) {
      return json(res, 500, { error: err instanceof Error ? err.message : String(err) });
    }
  }).listen(port, () => {
    console.log(`Crank + API on http://localhost:${port}`);
    console.log(`Dashboard: ${cfg.dashboardUrl}`);
    const opener = process.platform === "darwin" ? "open" : process.platform === "win32" ? "start" : "xdg-open";
    exec(`${opener} ${cfg.dashboardUrl}`);
  });
}
