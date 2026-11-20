// Admin identity + the decision a withdrawal must pass BEFORE the admin can pay it.
// The admin still clicks "approve" manually; this only says whether approving is safe.
import type { Verdict } from "./sell-guard.ts";

export function parseAdminIds(env: string | undefined): Set<number> {
  return new Set(
    (env ?? "").split(",").map((s) => Number(s.trim())).filter((n) => Number.isInteger(n) && n > 0),
  );
}

/** tgId MUST come from verifyInitData(), never from a client-supplied field. */
export function isAdmin(tgId: number, admins: Set<number>): boolean {
  return admins.has(tgId);
}

export type Decision =
  | { action: "ready" }
  | { action: "wait"; reason: "indexing-buffer" }
  | { action: "forfeit"; reason: "sold-during-pending-withdrawal" | "daily-cap-exceeded" }
  | { action: "reject"; reason: "banned" | "hold-not-met" };

export const INDEXING_BUFFER_MS = 5 * 60_000; // TonAPI can lag; re-check on-chain data before paying

export function decideWithdrawal(input: {
  createdAt: number;
  now: number;
  gross: number;
  walletVlrBalance: number; // fresh on-chain balance
  banned: boolean;
  guard: Verdict; // evaluateWallet() run on fresh jetton history
}): Decision {
  if (input.banned) return { action: "reject", reason: "banned" };
  if (!input.guard.ok) return { action: "forfeit", reason: input.guard.reason };
  if (input.walletVlrBalance + 1e-9 < input.gross * 0.25) return { action: "reject", reason: "hold-not-met" };
  if (input.now - input.createdAt < INDEXING_BUFFER_MS) return { action: "wait", reason: "indexing-buffer" };
  return { action: "ready" };
}
