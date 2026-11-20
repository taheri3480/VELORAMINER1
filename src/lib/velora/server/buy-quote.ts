// GRAM -> VLR at the market price, with a staleness check and a circuit breaker
// (thin DEX liquidity can be manipulated; never pay out on a wild price).
export const SWAP_FEE = 0.005;

export type Price = { gramPerVlr: number; at: number };

export type Quote =
  | { ok: true; vlrOut: number; gramPerVlr: number }
  | { ok: false; reason: "bad-amount" | "stale-price" | "bad-price" | "price-jump" };

export function quoteBuy(
  input: { gramIn: number; price: Price; now: number; lastGood?: number },
  opts = { maxAgeMs: 60_000, maxJump: 0.2 },
): Quote {
  const { gramIn, price, now, lastGood } = input;
  if (!(gramIn > 0) || !Number.isFinite(gramIn)) return { ok: false, reason: "bad-amount" };
  if (!(price.gramPerVlr > 0) || !Number.isFinite(price.gramPerVlr)) return { ok: false, reason: "bad-price" };
  if (now - price.at > opts.maxAgeMs) return { ok: false, reason: "stale-price" };
  if (lastGood && Math.abs(price.gramPerVlr - lastGood) / lastGood > opts.maxJump) {
    return { ok: false, reason: "price-jump" };
  }
  return { ok: true, vlrOut: (gramIn / price.gramPerVlr) * (1 - SWAP_FEE), gramPerVlr: price.gramPerVlr };
}

/** Decimal -> integer base units without float drift (6 dp precision is enough for the game). */
export function toUnits(amount: number, decimals: number): bigint {
  if (decimals < 6) return BigInt(Math.floor(amount * 10 ** decimals));
  return BigInt(Math.floor(amount * 1e6)) * 10n ** BigInt(decimals - 6);
}
