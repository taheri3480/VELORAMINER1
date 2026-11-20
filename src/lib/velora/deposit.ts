// Server functions for buying VLR with GRAM. Identity comes only from verified
// Telegram initData. Node-only code is imported dynamically (see login.ts).
import { createServerFn } from "@tanstack/react-start";

export type DepositInfo =
  | { ok: true; treasury: string; memo: string; minGram: number }
  | { ok: false; status: number; error: string };
export type BuyRow = { id: string; gram: number; vlr: number; status: string; at: string };
export type CheckResult =
  | { ok: true; buys: BuyRow[]; newlyCredited: number }
  | { ok: false; status: number; error: string };

const validate = (data: unknown) => {
  const v = (data as { initData?: unknown } | null)?.initData;
  return { initData: typeof v === "string" ? v : "" };
};

export const getDepositInfo = createServerFn({ method: "POST" })
  .validator(validate)
  .handler(async ({ data }): Promise<DepositInfo> => {
    const { authenticateTelegram } = await import("./server/session.ts");
    const auth = authenticateTelegram(data.initData, process.env);
    if (!auth.ok) return { ok: false, status: auth.status, error: auth.error };
    const secret = process.env.MEMO_SECRET?.trim();
    if (!secret || secret.length < 24) return { ok: false, status: 500, error: "server-misconfigured:MEMO_SECRET" };
    const { memoFor, MIN_DEPOSIT_NANO, GRAM_DECIMALS } = await import("./server/deposits.ts");
    const { TREASURY_ADDRESS } = await import("./server/env.ts");
    return {
      ok: true,
      treasury: TREASURY_ADDRESS,
      memo: memoFor(auth.user.id, secret),
      minGram: Number(MIN_DEPOSIT_NANO) / 10 ** GRAM_DECIMALS,
    };
  });

let lastCheck = 0; // per-instance cooldown so taps cannot hammer TonAPI
const COOLDOWN_MS = 5_000;

export const checkDeposits = createServerFn({ method: "POST" })
  .validator(validate)
  .handler(async ({ data }): Promise<CheckResult> => {
    const { authenticateTelegram } = await import("./server/session.ts");
    const auth = authenticateTelegram(data.initData, process.env);
    if (!auth.ok) return { ok: false, status: auth.status, error: auth.error };
    const key = process.env.TONAPI_KEY?.trim();
    const secret = process.env.MEMO_SECRET?.trim();
    if (!key) return { ok: false, status: 500, error: "server-misconfigured:TONAPI_KEY" };
    if (!secret || secret.length < 24) return { ok: false, status: 500, error: "server-misconfigured:MEMO_SECRET" };

    const { getSql } = await import("@/lib/db");
    const sql = await getSql();
    const before = Number((await sql.query<{ n: string }>("SELECT count(*) AS n FROM velora_buys WHERE telegram_id = $1::text", [String(auth.user.id)]))[0]?.n ?? 0);

    if (Date.now() - lastCheck >= COOLDOWN_MS) {
      lastCheck = Date.now();
      const { TREASURY_ADDRESS, VLR_JETTON_MASTER } = await import("./server/env.ts");
      const { toRawAddress } = await import("./server/ton-address.ts");
      const { fetchTreasuryTransfers, fetchVlrPrice } = await import("./server/tonapi.ts");
      const { planDeposits, persistPlan } = await import("./server/ingest.ts");
      const { parseMemo } = await import("./server/deposits.ts");
      try {
        const treasuryRaw = toRawAddress(TREASURY_ADDRESS)!;
        const [transfers, price] = await Promise.all([
          fetchTreasuryTransfers(key, TREASURY_ADDRESS, treasuryRaw),
          fetchVlrPrice(key, VLR_JETTON_MASTER),
        ]);
        const tgIds = [...new Set(transfers.map((t) => parseMemo(t.comment, secret)).filter((n): n is number => n !== null))];
        const users = tgIds.length
          ? await sql.query<{ telegram_id: string; wallet_address: string }>(
              "SELECT telegram_id, wallet_address FROM velora_users WHERE telegram_id = ANY($1::text[]) AND wallet_verified_at IS NOT NULL AND banned_at IS NULL",
              [tgIds.map(String)],
            )
          : [];
        const wallets = new Map(users.map((u) => [Number(u.telegram_id), u.wallet_address]));
        const done = await sql.query<{ tx_hash: string }>("SELECT tx_hash FROM velora_deposits WHERE status = 'credited' AND tx_hash = ANY($1::text[])", [transfers.map((t) => t.txHash)]);
        const last = await sql.query<{ gram_per_vlr: string }>("SELECT gram_per_vlr FROM velora_buys ORDER BY created_at DESC LIMIT 1");
        await persistPlan(sql, planDeposits(transfers, {
          secret,
          verifiedWalletOf: (id) => wallets.get(id) ?? null,
          alreadyCredited: new Set(done.map((d) => d.tx_hash)),
          price,
          lastGoodPrice: last[0] ? Number(last[0].gram_per_vlr) : undefined,
          now: Date.now(),
        }));
      } catch {
        return { ok: false, status: 502, error: "chain-lookup-failed" }; // details stay in server logs, not the client
      }
    }

    // Best effort: pay out whatever is ready. Failures here never break the user's request;
    // anything unpaid just stays 'pending_payout' (or 'review' for a human).
    try {
      const { runPayoutsOnce } = await import("./server/payout-run.ts");
      await runPayoutsOnce(sql);
    } catch {
      /* @ton packages not installed yet, or hot wallet unreachable */
    }

    const rows = await sql.query<{ id: string; gram_in: string; vlr_out: string; status: string; created_at: string }>(
      "SELECT id, gram_in, vlr_out, status, created_at FROM velora_buys WHERE telegram_id = $1::text ORDER BY created_at DESC LIMIT 20",
      [String(auth.user.id)],
    );
    const after = Number((await sql.query<{ n: string }>("SELECT count(*) AS n FROM velora_buys WHERE telegram_id = $1::text", [String(auth.user.id)]))[0]?.n ?? 0);
    return {
      ok: true,
      newlyCredited: Math.max(0, after - before),
      buys: rows.map((r) => ({ id: r.id, gram: Number(r.gram_in), vlr: Number(r.vlr_out), status: r.status, at: String(r.created_at) })),
    };
  });
