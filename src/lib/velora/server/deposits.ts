// GRAM (native TON coin) deposits to the treasury, matched to accounts by a
// per-user memo. Only native, successful, non-bounced transfers from the user's
// VERIFIED wallet are credited. Everything else is returned as `held` for manual review.
import { createHmac } from "node:crypto";

export const GRAM_DECIMALS = 9;
export const MIN_DEPOSIT_NANO = 10_000_000n; // 0.01 GRAM; smaller = dust, ignored

export type IncomingTransfer = {
  txHash: string; // idempotency key (store it; never credit a hash twice)
  at: number;
  valueNano: bigint;
  fromRaw: string; // raw address of the sender
  comment?: string;
  success: boolean; // false for aborted/bounced transactions
};

export function memoFor(tgId: number, secret: string): string {
  const code = createHmac("sha256", secret).update(String(tgId)).digest("hex").slice(0, 6);
  return `velora:${tgId}:${code}`;
}

export function parseMemo(text: string | undefined, secret: string): number | null {
  const m = /^velora:(\d{1,15}):([0-9a-f]{6})$/.exec((text ?? "").trim());
  if (!m) return null;
  return memoFor(Number(m[1]), secret) === `velora:${m[1]}:${m[2]}` ? Number(m[1]) : null;
}

export type Credit = { txHash: string; tgId: number; gram: number; valueNano: bigint };
export type Held = { txHash: string; reason: "dust" | "failed" | "bad-memo" | "no-verified-wallet" | "wrong-sender" };

export function matchDeposits(
  transfers: IncomingTransfer[],
  secret: string,
  verifiedWalletOf: (tgId: number) => string | null,
): { credits: Credit[]; held: Held[] } {
  const credits: Credit[] = [];
  const held: Held[] = [];
  for (const t of transfers) {
    if (!t.success) { held.push({ txHash: t.txHash, reason: "failed" }); continue; }
    if (t.valueNano < MIN_DEPOSIT_NANO) { held.push({ txHash: t.txHash, reason: "dust" }); continue; }
    const tgId = parseMemo(t.comment, secret);
    if (tgId === null) { held.push({ txHash: t.txHash, reason: "bad-memo" }); continue; }
    const wallet = verifiedWalletOf(tgId);
    if (!wallet) { held.push({ txHash: t.txHash, reason: "no-verified-wallet" }); continue; }
    if (wallet !== t.fromRaw) { held.push({ txHash: t.txHash, reason: "wrong-sender" }); continue; }
    credits.push({ txHash: t.txHash, tgId, gram: Number(t.valueNano) / 10 ** GRAM_DECIMALS, valueNano: t.valueNano });
  }
  return { credits, held };
}
