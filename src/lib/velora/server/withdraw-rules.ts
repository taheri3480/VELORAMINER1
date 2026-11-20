// Pure withdrawal rules. The CLIENT sends only the amount; the fee, the destination and every
// eligibility check are decided on the server (the client is never trusted for money).
import { HOLD_RATIO } from "../economy.ts";

export const MICRO = 1_000_000;
export const MIN_WITHDRAW_MICRO = 10_000 * MICRO; // must match the SQL function (10,000 VLR)
export const MAX_WITHDRAW_MICRO = 10_000_000 * MICRO;
export const WITHDRAW_FEE_BP = 500; // 5.00%, integer basis points (matches economy WITHDRAW_FEE)

export function feeFor(amountMicro: number): number {
  return Number((BigInt(amountMicro) * BigInt(WITHDRAW_FEE_BP)) / 10_000n);
}

export type WithdrawPlan =
  | { ok: true; fee: number; net: number }
  | { ok: false; reason: "banned" | "no-verified-wallet" | "bad-amount" | "below-minimum" | "hold-not-met" };

export function planWithdrawal(i: {
  amountMicro: number;
  banned: boolean;
  walletVerified: boolean;
  walletVlr: number; // fresh on-chain balance of the user's verified wallet
}): WithdrawPlan {
  if (!Number.isSafeInteger(i.amountMicro) || i.amountMicro <= 0 || i.amountMicro > MAX_WITHDRAW_MICRO) return { ok: false, reason: "bad-amount" };
  if (i.banned) return { ok: false, reason: "banned" };
  if (!i.walletVerified) return { ok: false, reason: "no-verified-wallet" };
  if (i.amountMicro < MIN_WITHDRAW_MICRO) return { ok: false, reason: "below-minimum" };
  if (i.walletVlr + 1e-9 < (i.amountMicro / MICRO) * HOLD_RATIO) return { ok: false, reason: "hold-not-met" };
  const fee = feeFor(i.amountMicro);
  return { ok: true, fee, net: i.amountMicro - fee };
}

/** Database exceptions carry internal text; the client only ever sees these stable codes. */
export function mapDbError(e: unknown): string {
  const m = String((e as { message?: unknown } | null)?.message ?? "");
  if (m.includes("insufficient balance")) return "insufficient-balance";
  if (m.includes("withdrawal already pending")) return "withdrawal-already-pending";
  if (m.includes("destination wallet is not verified")) return "wallet-not-verified";
  if (m.includes("idempotency key reused")) return "idempotency-conflict";
  if (m.includes("invalid withdrawal request") || m.includes("invalid withdrawal fee")) return "invalid-request";
  if (m.includes("invalid state")) return "invalid-state";
  if (m.includes("withdrawal not found")) return "not-found";
  return "internal-error";
}
