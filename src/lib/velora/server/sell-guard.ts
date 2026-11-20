// Server-side enforcement of the sell rules, driven by the user's real on-chain
// jetton history (TonAPI). Pure function: no I/O, so it is fully testable.
//
// Rules (from the product spec):
//  1. Selling while a withdrawal is pending  -> ban + that withdrawal is forfeited.
//  2. For `lockMs` (72h) after a deposit into the wallet, selling more than
//     `dailyCap` (2,500) in any rolling 24h window -> ban.
// "Selling" = any outgoing VLR transfer from the connected wallet, except to
// addresses listed in `ignoreOut` (e.g. the treasury).

export const HOUR = 3_600_000;

export type SellGuardConfig = {
  lockMs: number;
  dailyCap: number;
  windowMs: number;
  /** Incoming transfers smaller than this do not start/extend the 72h lock (anti-dust). */
  minLockingDeposit: number;
  /** Raw addresses whose incoming transfers are not "sells" when sent TO them. */
  ignoreOut: string[];
};

export const DEFAULT_CONFIG: SellGuardConfig = {
  lockMs: 72 * HOUR,
  dailyCap: 2_500,
  windowMs: 24 * HOUR,
  minLockingDeposit: 1,
  ignoreOut: [],
};

export type JettonEvent = {
  id: string;
  at: number; // ms epoch
  direction: "in" | "out";
  amount: number; // VLR, already divided by decimals
  counterparty?: string; // raw address
};

export type PendingWithdrawal = { id: string; createdAt: number };

export type Verdict =
  | { ok: true; lockedUntil: number; soldInWindow: number; remaining: number }
  | {
      ok: false;
      reason: "sold-during-pending-withdrawal" | "daily-cap-exceeded";
      eventId: string;
      at: number;
      forfeit: string[];
    };

export function evaluateWallet(
  input: { events: JettonEvent[]; pending: PendingWithdrawal[]; now: number },
  config: SellGuardConfig = DEFAULT_CONFIG,
): Verdict {
  const { pending, now } = input;
  const events = [...input.events].sort((a, b) => a.at - b.at || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const ignore = new Set(config.ignoreOut);
  const sells = events.filter(
    (e) => e.direction === "out" && !(e.counterparty && ignore.has(e.counterparty)),
  );
  const deposits = events.filter((e) => e.direction === "in" && e.amount >= config.minLockingDeposit);

  // Rule 1: any sell after a pending withdrawal was requested.
  for (const s of sells) {
    const hit = pending.filter((w) => s.at >= w.createdAt);
    if (hit.length) {
      return {
        ok: false,
        reason: "sold-during-pending-withdrawal",
        eventId: s.id,
        at: s.at,
        forfeit: hit.map((w) => w.id),
      };
    }
  }

  // Rule 2: rolling-window cap while locked.
  const lockedAt = (t: number) => deposits.some((d) => d.at <= t && t < d.at + config.lockMs);
  for (const s of sells) {
    if (!lockedAt(s.at)) continue;
    const sum = sells
      .filter((x) => x.at <= s.at && x.at > s.at - config.windowMs)
      .reduce((acc, x) => acc + x.amount, 0);
    if (sum > config.dailyCap + 1e-9) {
      return { ok: false, reason: "daily-cap-exceeded", eventId: s.id, at: s.at, forfeit: [] };
    }
  }

  const lockedUntil = deposits.reduce((m, d) => Math.max(m, d.at + config.lockMs), 0);
  const soldInWindow = sells
    .filter((x) => x.at <= now && x.at > now - config.windowMs)
    .reduce((acc, x) => acc + x.amount, 0);
  const remaining = lockedUntil > now ? Math.max(0, config.dailyCap - soldInWindow) : Infinity;
  return { ok: true, lockedUntil, soldInWindow, remaining };
}
