/**
 * Deterministic market-price simulator, shared verbatim between the CLI and
 * the dashboard page. The price is a pure function of (seed string, time), so
 * both sides compute the exact same line independently: no feed, no server,
 * and the page can backfill history instantly. Seed with the pool ID so every
 * pool gets its own distinct but reproducible path.
 */

export const SIM_BASE_PRICE = 75;
export const SIM_TICK_MS = 2000;

function seedFromString(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  }
  return h >>> 0;
}

/** Hash (seed, k) to a deterministic value in [-1, 1]. */
function hashNoise(seed: number, k: number): number {
  let a = (seed ^ Math.imul(k, 0x9e3779b1)) >>> 0;
  a = Math.imul(a ^ (a >>> 16), 0x21f0aaad) >>> 0;
  a = Math.imul(a ^ (a >>> 15), 0x735a2d97) >>> 0;
  a = (a ^ (a >>> 15)) >>> 0;
  return (a / 4294967296) * 2 - 1;
}

/**
 * SOL/USD sim price at time tMs for a given seed string. Layered sines give
 * organic trends; per-tick hash noise gives texture. Range ≈ ±1.5% of base.
 */
export function simPrice(seedStr: string, tMs: number): number {
  const s = seedFromString(seedStr || "hadron");
  const t = tMs / 1000;
  const k = Math.floor(tMs / SIM_TICK_MS);
  const wave =
    0.85 * Math.sin(t / 97 + (s % 7)) +
    0.45 * Math.sin(t / 23 + (s % 13)) +
    0.22 * Math.sin(t / 7.3 + (s % 29)) +
    0.28 * hashNoise(s, k);
  return SIM_BASE_PRICE * (1 + 0.012 * wave);
}
