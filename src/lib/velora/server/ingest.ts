// Turns treasury transfers into credited buys (VLR owed to the user) or held
// items for review. planDeposits is pure; persistPlan is one atomic statement per
// item, idempotent on tx_hash, so polling twice or concurrently never double-credits.
import { matchDeposits, parseMemo, GRAM_DECIMALS, type IncomingTransfer } from "./deposits.ts";
import { quoteBuy, type Price } from "./buy-quote.ts";
import type { SqlLike } from "./users.ts";

export type PlannedCredit = {
  txHash: string; tgId: number; at: number; valueNano: bigint; gram: number; vlrOut: number; gramPerVlr: number;
};
export type PlannedHold = { txHash: string; tgId: number | null; at: number; valueNano: bigint; reason: string };

export function planDeposits(
  transfers: IncomingTransfer[],
  o: {
    secret: string;
    verifiedWalletOf: (tgId: number) => string | null;
    alreadyCredited: Set<string>;
    price: Price | null;
    lastGoodPrice?: number;
    now: number;
  },
): { credits: PlannedCredit[]; held: PlannedHold[] } {
  const fresh = transfers.filter((t) => !o.alreadyCredited.has(t.txHash));
  const byHash = new Map(fresh.map((t) => [t.txHash, t]));
  const m = matchDeposits(fresh, o.secret, o.verifiedWalletOf);
  const credits: PlannedCredit[] = [];
  const held: PlannedHold[] = [];
  const hold = (hash: string, reason: string) => {
    const t = byHash.get(hash)!;
    held.push({ txHash: hash, tgId: parseMemo(t.comment, o.secret), at: t.at, valueNano: t.valueNano, reason });
  };
  for (const h of m.held) hold(h.txHash, h.reason);
  for (const c of m.credits) {
    if (!o.price) { hold(c.txHash, "no-price"); continue; }
    const q = quoteBuy({ gramIn: c.gram, price: o.price, now: o.now, lastGood: o.lastGoodPrice });
    if (!q.ok) { hold(c.txHash, `quote:${q.reason}`); continue; }
    const t = byHash.get(c.txHash)!;
    credits.push({ txHash: c.txHash, tgId: c.tgId, at: t.at, valueNano: c.valueNano, gram: c.gram, vlrOut: q.vlrOut, gramPerVlr: q.gramPerVlr });
  }
  return { credits, held };
}

export async function persistPlan(sql: SqlLike, plan: { credits: PlannedCredit[]; held: PlannedHold[] }): Promise<void> {
  for (const h of plan.held) {
    await sql.query(
      `INSERT INTO velora_deposits (tx_hash, telegram_id, value_nano, gram, status, held_reason, at)
       VALUES ($1, $2::text, $3::numeric, $4::numeric, 'held', $5, to_timestamp($6::double precision / 1000))
       ON CONFLICT (tx_hash) DO UPDATE SET held_reason = EXCLUDED.held_reason, telegram_id = EXCLUDED.telegram_id
         WHERE velora_deposits.status = 'held'`,
      [h.txHash, h.tgId === null ? null : String(h.tgId), h.valueNano.toString(), Number(h.valueNano) / 10 ** GRAM_DECIMALS, h.reason, h.at],
    );
  }
  for (const c of plan.credits) {
    await sql.query(
      `WITH d AS (
         INSERT INTO velora_deposits (tx_hash, telegram_id, value_nano, gram, status, at)
         VALUES ($1, $2::text, $3::numeric, $4::numeric, 'credited', to_timestamp($5::double precision / 1000))
         ON CONFLICT (tx_hash) DO UPDATE SET status = 'credited', held_reason = NULL, telegram_id = EXCLUDED.telegram_id
           WHERE velora_deposits.status = 'held'
         RETURNING tx_hash
       )
       INSERT INTO velora_buys (id, telegram_id, deposit_tx, gram_in, vlr_out, gram_per_vlr, status)
       SELECT 'buy:' || tx_hash, $2::text, tx_hash, $4::numeric, $6::numeric, $7::numeric, 'pending_payout' FROM d
       ON CONFLICT (id) DO NOTHING`,
      [c.txHash, String(c.tgId), c.valueNano.toString(), c.gram, c.at, c.vlrOut, c.gramPerVlr],
    );
  }
}
