// Limits for AUTOMATIC VLR payouts signed by the server's hot wallet. If the key
// ever leaks or a bug loops, these caps bound the loss. Keep the hot wallet
// balance small; the main treasury key never goes on the server.
export type PayoutLimits = {
  perTx: number;
  perUserDaily: number;
  totalDaily: number;
  reserve: number; // never drain the hot wallet below this
};

export const DEFAULT_LIMITS: PayoutLimits = { perTx: 50_000, perUserDaily: 200_000, totalDaily: 2_000_000, reserve: 0 };

export type PayoutCheck =
  | { ok: true }
  | { ok: false; reason: "banned" | "per-tx-limit" | "user-daily-limit" | "total-daily-limit" | "hot-wallet-low" | "duplicate" };

export function checkPayout(
  input: {
    amount: number;
    banned: boolean;
    userPaid24h: number;
    totalPaid24h: number;
    hotBalance: number;
    alreadyPaid: boolean; // same buy id already sent -> never pay twice
  },
  limits: PayoutLimits = DEFAULT_LIMITS,
): PayoutCheck {
  if (input.alreadyPaid) return { ok: false, reason: "duplicate" };
  if (input.banned) return { ok: false, reason: "banned" };
  if (input.amount > limits.perTx) return { ok: false, reason: "per-tx-limit" };
  if (input.userPaid24h + input.amount > limits.perUserDaily) return { ok: false, reason: "user-daily-limit" };
  if (input.totalPaid24h + input.amount > limits.totalDaily) return { ok: false, reason: "total-daily-limit" };
  if (input.hotBalance - input.amount < limits.reserve) return { ok: false, reason: "hot-wallet-low" };
  return { ok: true };
}
