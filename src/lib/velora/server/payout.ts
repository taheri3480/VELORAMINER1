// Automatic VLR payouts for credited buys, signed by the server's HOT wallet.
// Safety rules (the money-losing failure is paying TWICE, so every choice below
// prefers "stop and ask a human" over "retry"):
//  * a buy is claimed atomically (pending_payout -> sending); only one worker can hold it
//  * once a signed message may have been broadcast, it is never re-sent automatically
//  * only failures that happen BEFORE anything is built are reverted to pending
//  * hard caps from payout-guard.ts bound the loss if the key leaks or a bug loops
import { checkPayout, DEFAULT_LIMITS, type PayoutLimits } from "./payout-guard.ts";
import type { MessageState } from "./tonapi.ts";
import type { SqlLike } from "./users.ts";

export type PayoutRec = { id: string; tgId: number; vlr: number; walletRaw: string | null; banned: boolean };

export interface PayoutStore {
  sendingWithHash(): Promise<{ id: string; msgHash: string; attemptedAt: number }[]>;
  hasRecentSending(sinceMs: number): Promise<boolean>;
  claimNext(): Promise<PayoutRec | null>;
  revertToPending(id: string): Promise<void>;
  setMsgHash(id: string, hash: string): Promise<void>;
  markPaid(id: string): Promise<void>;
  markReview(id: string, note: string): Promise<void>;
  paidSums(tgId: number, excludeId: string): Promise<{ user: number; total: number }>;
}

export interface PayoutDeps {
  now: () => number;
  getSeqno: () => Promise<number>;
  getJettonWallet: () => Promise<{ jettonWallet: string; balance: number }>;
  buildSigned: (a: { seqno: number; jettonWallet: string; destRaw: string; vlr: number; buyId: string }) => Promise<{ boc: string; msgHash: string }>;
  broadcast: (boc: string) => Promise<void>;
  checkMessage: (msgHash: string) => Promise<MessageState>;
}

export type PayoutOutcome =
  | { status: "idle" | "busy" | "sent" | "hot-wallet-low" | "preflight-failed" }
  | { status: "review"; note: string };

export const BUSY_WINDOW_MS = 90_000;
export const UNCONFIRMED_AFTER_MS = 15 * 60_000;

export async function processPayouts(
  store: PayoutStore, deps: PayoutDeps, limits: PayoutLimits = DEFAULT_LIMITS,
): Promise<{ confirmed: number; outcome: PayoutOutcome }> {
  // 1) settle earlier sends
  let confirmed = 0;
  for (const s of await store.sendingWithHash()) {
    const st = await deps.checkMessage(s.msgHash).catch((): MessageState => "unknown");
    if (st === "success") { await store.markPaid(s.id); confirmed += 1; }
    else if (st === "failed") await store.markReview(s.id, "tx-failed-onchain");
    else if (deps.now() - s.attemptedAt > UNCONFIRMED_AFTER_MS) await store.markReview(s.id, "unconfirmed-after-15min");
  }
  // 2) the wallet seqno must advance between sends: one in flight at a time
  if (await store.hasRecentSending(BUSY_WINDOW_MS)) return { confirmed, outcome: { status: "busy" } };

  const rec = await store.claimNext();
  if (!rec) return { confirmed, outcome: { status: "idle" } };
  if (!rec.walletRaw) { await store.markReview(rec.id, "no-wallet"); return { confirmed, outcome: { status: "review", note: "no-wallet" } }; }

  // 3) preflight: nothing is built or sent yet, so any failure here is safely reverted
  let seqno: number, jw: { jettonWallet: string; balance: number }, sums: { user: number; total: number };
  try {
    [seqno, jw, sums] = await Promise.all([deps.getSeqno(), deps.getJettonWallet(), store.paidSums(rec.tgId, rec.id)]);
  } catch {
    await store.revertToPending(rec.id);
    return { confirmed, outcome: { status: "preflight-failed" } };
  }
  const check = checkPayout(
    { amount: rec.vlr, banned: rec.banned, userPaid24h: sums.user, totalPaid24h: sums.total, hotBalance: jw.balance, alreadyPaid: false },
    limits,
  );
  if (!check.ok) {
    if (check.reason === "hot-wallet-low") { // top up the hot wallet and it resumes by itself
      await store.revertToPending(rec.id);
      return { confirmed, outcome: { status: "hot-wallet-low" } };
    }
    await store.markReview(rec.id, check.reason);
    return { confirmed, outcome: { status: "review", note: check.reason } };
  }

  // 4) build + sign (still nothing on the network), then record the hash BEFORE broadcasting
  let built: { boc: string; msgHash: string };
  try {
    built = await deps.buildSigned({ seqno, jettonWallet: jw.jettonWallet, destRaw: rec.walletRaw, vlr: rec.vlr, buyId: rec.id });
    await store.setMsgHash(rec.id, built.msgHash);
  } catch {
    await store.revertToPending(rec.id);
    return { confirmed, outcome: { status: "preflight-failed" } };
  }
  try {
    await deps.broadcast(built.boc);
  } catch {
    // The node may have accepted it even though we saw an error: never re-send blindly.
    await store.markReview(rec.id, "broadcast-uncertain");
    return { confirmed, outcome: { status: "review", note: "broadcast-uncertain" } };
  }
  return { confirmed, outcome: { status: "sent" } };
}

export function pgPayoutStore(sql: SqlLike): PayoutStore {
  return {
    async sendingWithHash() {
      const r = await sql.query<{ id: string; payout_msg_hash: string; at: string }>(
        "SELECT id, payout_msg_hash, (extract(epoch FROM payout_attempted_at) * 1000)::bigint AS at FROM velora_buys WHERE status = 'sending' AND payout_msg_hash IS NOT NULL",
      );
      return r.map((x) => ({ id: x.id, msgHash: x.payout_msg_hash, attemptedAt: Number(x.at) }));
    },
    async hasRecentSending(sinceMs) {
      const r = await sql.query("SELECT 1 FROM velora_buys WHERE status = 'sending' AND payout_attempted_at > now() - ($1::double precision * interval '1 millisecond') LIMIT 1", [sinceMs]);
      return r.length > 0;
    },
    async claimNext() {
      const r = await sql.query<{ id: string; telegram_id: string; vlr_out: string; wallet_address: string | null; banned: boolean }>(
        `UPDATE velora_buys b SET status = 'sending', payout_attempted_at = now()
         FROM velora_users u
         WHERE u.telegram_id = b.telegram_id
           AND b.id = (SELECT id FROM velora_buys WHERE status = 'pending_payout' ORDER BY created_at LIMIT 1 FOR UPDATE SKIP LOCKED)
         RETURNING b.id, b.telegram_id, b.vlr_out, u.wallet_address, (u.banned_at IS NOT NULL) AS banned`,
      );
      const x = r[0];
      return x ? { id: x.id, tgId: Number(x.telegram_id), vlr: Number(x.vlr_out), walletRaw: x.wallet_address, banned: x.banned } : null;
    },
    async revertToPending(id) {
      await sql.query("UPDATE velora_buys SET status = 'pending_payout', payout_attempted_at = NULL, payout_msg_hash = NULL WHERE id = $1 AND status = 'sending'", [id]);
    },
    async setMsgHash(id, hash) {
      await sql.query("UPDATE velora_buys SET payout_msg_hash = $2 WHERE id = $1 AND status = 'sending'", [id, hash]);
    },
    async markPaid(id) {
      await sql.query("UPDATE velora_buys SET status = 'paid', paid_at = now(), payout_tx = payout_msg_hash WHERE id = $1 AND status = 'sending'", [id]);
    },
    async markReview(id, note) {
      await sql.query("UPDATE velora_buys SET status = 'review', review_note = $2 WHERE id = $1 AND status IN ('sending','pending_payout')", [id, note]);
    },
    async paidSums(tgId, excludeId) {
      const r = await sql.query<{ u: string; t: string }>(
        `SELECT COALESCE(SUM(vlr_out) FILTER (WHERE telegram_id = $1::text), 0) AS u, COALESCE(SUM(vlr_out), 0) AS t
         FROM velora_buys WHERE status IN ('paid','sending') AND id <> $2 AND payout_attempted_at > now() - interval '24 hours'`,
        [String(tgId), excludeId],
      );
      return { user: Number(r[0]?.u ?? 0), total: Number(r[0]?.t ?? 0) };
    },
  };
}
