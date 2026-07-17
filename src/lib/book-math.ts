import { fromQ32, type CurvePoint } from "@hadron-fi/sdk-v2";

/**
 * Fill accounting for a bid-only Hadron orderbook pool.
 *
 * The bid ladder lives on the risk-bid curve with an absolute vault-balance
 * x-axis: point[i].amountIn is the cumulative SHFL (base) vault level where
 * rung i starts, and the last point is a terminal marker at full capacity.
 * Fills move only the base vault balance (sellers deposit SHFL into vaultX),
 * so the vault balance is a monotonic fill pointer along the curve:
 * everything in [point[0].amountIn, vaultX] has been bought.
 */

export interface RungStatus {
  spreadBps: number;
  /** Absolute bid price at this rung for the given midprice. */
  price: number;
  sizeShfl: number;
  filledShfl: number;
  remainingShfl: number;
}

function clampBig(x: bigint, lo: bigint, hi: bigint): bigint {
  return x < lo ? lo : x > hi ? hi : x;
}

/** Per-rung fill status from the active risk-bid curve points + live vaultX. */
export function ladderStatus(
  points: CurvePoint[],
  vaultX: bigint,
  decimalsX: number,
  midprice: number
): RungStatus[] {
  const rungs: RungStatus[] = [];
  const scale = 10 ** decimalsX;
  for (let i = 0; i < points.length - 1; i++) {
    const lo = points[i].amountIn;
    const hi = points[i + 1].amountIn;
    const factor = fromQ32(points[i].priceFactorQ32);
    const filled = clampBig(vaultX, lo, hi) - lo;
    rungs.push({
      spreadBps: Math.round((1 - factor) * 10_000),
      price: midprice * factor,
      sizeShfl: Number(hi - lo) / scale,
      filledShfl: Number(filled) / scale,
      remainingShfl: Number(hi - filled - lo) / scale,
    });
  }
  return rungs;
}

/** Total SHFL bought so far (vault progress past the ladder anchor). */
export function totalFilledShfl(
  points: CurvePoint[],
  vaultX: bigint,
  decimalsX: number
): number {
  if (points.length === 0) return 0;
  const anchor = points[0].amountIn;
  const terminal = points[points.length - 1].amountIn;
  return Number(clampBig(vaultX, anchor, terminal) - anchor) / 10 ** decimalsX;
}

/**
 * Estimate USDC out for selling `amountInAtoms` of SHFL (fee already removed),
 * by walking the bid rungs from the current vault position. Mirrors the
 * on-chain Integrated risk walk with Step interpolation and equal decimals.
 */
export function estimateSellOutput(
  points: CurvePoint[],
  vaultX: bigint,
  amountInAtoms: bigint,
  midprice: number
): { outAtoms: bigint; exhausted: boolean } {
  let remaining = amountInAtoms;
  let cursor = vaultX < points[0].amountIn ? points[0].amountIn : vaultX;
  let out = 0n;
  for (let i = 0; i < points.length - 1 && remaining > 0n; i++) {
    const hi = points[i + 1].amountIn;
    if (cursor >= hi) continue;
    const seg = clampBig(remaining, 0n, hi - cursor);
    const factor = fromQ32(points[i].priceFactorQ32);
    out += BigInt(Math.floor(Number(seg) * midprice * factor));
    cursor += seg;
    remaining -= seg;
  }
  return { outAtoms: out, exhausted: remaining > 0n };
}
