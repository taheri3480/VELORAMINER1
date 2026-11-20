// Withdrawals. The user asks (amount only); an ADMIN reviews and pays manually.
//  * fee, destination wallet and all checks are decided on the server
//  * the amount is debited atomically at request time; reject = full refund, forfeit = no refund
//  * approval re-checks the user's on-chain history (sell-guard) and wallet hold on FRESH data
import { createServerFn } from "@tanstack/react-start";

export type WithdrawResult =
  | { ok: true; withdrawalId: string; balanceMicroVlr: number; feeMicroVlr: number; netMicroVlr: number; duplicate: boolean; status: "pending_manual_review" }
  | { ok: false; status: number; error: string };

export type WithdrawalRow = {
  id: string; telegramId: string; amountMicroVlr: number; feeMicroVlr: number;
  wallet: string; status: string; createdAt: string;
};
export type AdminListResult = { ok: true; withdrawals: WithdrawalRow[] } | { ok: false; status: number; error: string };
export type AdminReviewResult =
  | { ok: true; outcome: "approved" | "completed" | "rejected" | "forfeited"; reason?: string }
  | { ok: false; status: number; error: string };

const initOf = (d: unknown) => {
  const v = (d as { initData?: unknown } | null)?.initData;
  return typeof v === "string" && v.length <= 4096 ? v : "";
};

export const requestWithdrawal = createServerFn({ method: "POST" })
  .validator((d: unknown) => {
    const o = (d ?? {}) as Record<string, unknown>;
    return {
      initData: initOf(d),
      amountMicroVlr: typeof o.amountMicroVlr === "number" ? o.amountMicroVlr : NaN,
      idempotencyKey: typeof o.idempotencyKey === "string" && /^[A-Za-z0-9_-]{8,128}$/.test(o.idempotencyKey) ? o.idempotencyKey : "",
    };
  })
  .handler(async ({ data }): Promise<WithdrawResult> => {
    const { authenticateTelegram } = await import("./server/session.ts");
    const auth = authenticateTelegram(data.initData, process.env);
    if (!auth.ok) return { ok: false, status: auth.status, error: auth.error };
    if (!data.idempotencyKey) return { ok: false, status: 400, error: "bad-idempotency-key" };
    const key = process.env.TONAPI_KEY?.trim();
    if (!key) return { ok: false, status: 500, error: "server-misconfigured:TONAPI_KEY" };

    const { getSql } = await import("@/lib/db");
    const { planWithdrawal, mapDbError } = await import("./server/withdraw-rules.ts");
    const sql = await getSql();
    const id = String(auth.user.id);
    const u = (await sql.query<{ wallet_address: string | null; wallet_verified_at: string | null; banned_at: string | null }>(
      "SELECT wallet_address, wallet_verified_at, banned_at FROM velora_users WHERE telegram_id = $1::text", [id],
    ))[0];
    if (!u) return { ok: false, status: 404, error: "no-account" };

    let walletVlr = 0;
    if (u.wallet_address && u.wallet_verified_at && !u.banned_at) {
      try {
        const { fetchJettonWallet } = await import("./server/tonapi.ts");
        const { VLR_JETTON_MASTER } = await import("./server/env.ts");
        walletVlr = (await fetchJettonWallet(key, u.wallet_address, VLR_JETTON_MASTER)).balance;
      } catch {
        return { ok: false, status: 502, error: "chain-lookup-failed" };
      }
    }
    const plan = planWithdrawal({ amountMicro: data.amountMicroVlr, banned: !!u.banned_at, walletVerified: !!u.wallet_verified_at && !!u.wallet_address, walletVlr });
    if (!plan.ok) return { ok: false, status: plan.reason === "banned" ? 403 : 400, error: plan.reason };

    const { randomUUID } = await import("node:crypto");
    try {
      const rows = await sql.query<{ withdrawal_id: string; balance_micro_vlr: string | number; duplicate: boolean }>(
        "SELECT * FROM velora_request_withdrawal($1, $2, $3, $4, $5, $6)",
        [`wd_${randomUUID()}`, id, data.amountMicroVlr, plan.fee, u.wallet_address, data.idempotencyKey],
      );
      const r = rows[0];
      if (!r) return { ok: false, status: 500, error: "internal-error" };
      return { ok: true, withdrawalId: r.withdrawal_id, balanceMicroVlr: Number(r.balance_micro_vlr), feeMicroVlr: plan.fee, netMicroVlr: plan.net, duplicate: r.duplicate, status: "pending_manual_review" };
    } catch (e) {
      const code = mapDbError(e);
      return { ok: false, status: code === "internal-error" ? 500 : 409, error: code };
    }
  });

export const adminListWithdrawals = createServerFn({ method: "POST" })
  .validator((d: unknown) => ({ initData: initOf(d) }))
  .handler(async ({ data }): Promise<AdminListResult> => {
    const { authenticateTelegram } = await import("./server/session.ts");
    const auth = authenticateTelegram(data.initData, process.env);
    if (!auth.ok) return { ok: false, status: auth.status, error: auth.error };
    if (!auth.isAdmin) return { ok: false, status: 403, error: "forbidden" };
    const { getSql } = await import("@/lib/db");
    const rows = await (await getSql()).query<{ id: string; telegram_id: string; amount_micro_vlr: string | number; fee_micro_vlr: string | number; destination_address: string; status: string; created_at: string }>(
      "SELECT id, telegram_id, amount_micro_vlr, fee_micro_vlr, destination_address, status, created_at FROM velora_withdrawals WHERE status IN ('pending','approved') ORDER BY created_at LIMIT 100",
    );
    return { ok: true, withdrawals: rows.map((r) => ({ id: r.id, telegramId: r.telegram_id, amountMicroVlr: Number(r.amount_micro_vlr), feeMicroVlr: Number(r.fee_micro_vlr), wallet: r.destination_address, status: r.status, createdAt: String(r.created_at) })) };
  });

export const adminReviewWithdrawal = createServerFn({ method: "POST" })
  .validator((d: unknown) => {
    const o = (d ?? {}) as Record<string, unknown>;
    const action = o.action === "approve" || o.action === "reject" || o.action === "complete" ? o.action : "";
    return {
      initData: initOf(d),
      id: typeof o.id === "string" && /^wd_[0-9a-f-]{36}$/.test(o.id) ? o.id : "",
      action: action as "approve" | "reject" | "complete" | "",
      txHash: typeof o.txHash === "string" && /^[A-Za-z0-9_+/=-]{20,100}$/.test(o.txHash) ? o.txHash : "",
      note: typeof o.note === "string" ? o.note.slice(0, 500) : null,
    };
  })
  .handler(async ({ data }): Promise<AdminReviewResult> => {
    const { authenticateTelegram } = await import("./server/session.ts");
    const auth = authenticateTelegram(data.initData, process.env);
    if (!auth.ok) return { ok: false, status: auth.status, error: auth.error };
    if (!auth.isAdmin) return { ok: false, status: 403, error: "forbidden" };
    if (!data.id || !data.action) return { ok: false, status: 400, error: "bad-request" };

    const { getSql } = await import("@/lib/db");
    const { mapDbError, MICRO } = await import("./server/withdraw-rules.ts");
    const sql = await getSql();
    const admin = String(auth.user.id);
    const resolve = async (action: string, note: string | null, tx: string | null, ban = false) =>
      sql.query("SELECT * FROM velora_resolve_withdrawal($1, $2, $3, $4, $5, $6)", [data.id, action, admin, note, tx, ban]);

    try {
      if (data.action === "reject") { await resolve("reject", data.note, null); return { ok: true, outcome: "rejected" }; }
      if (data.action === "complete") {
        if (!data.txHash) return { ok: false, status: 400, error: "tx-hash-required" };
        await resolve("complete", data.note, data.txHash);
        return { ok: true, outcome: "completed" };
      }

      // approve: re-check on FRESH on-chain data before allowing a manual payment
      const w = (await sql.query<{ telegram_id: string; amount_micro_vlr: string | number; status: string; created_ms: string | number; wallet_address: string | null; banned_at: string | null }>(
        `SELECT w.telegram_id, w.amount_micro_vlr, w.status, (extract(epoch FROM w.created_at) * 1000)::bigint AS created_ms,
                u.wallet_address, u.banned_at
         FROM velora_withdrawals w JOIN velora_users u ON u.telegram_id = w.telegram_id WHERE w.id = $1`, [data.id],
      ))[0];
      if (!w) return { ok: false, status: 404, error: "not-found" };
      if (w.status !== "pending") return { ok: false, status: 409, error: "invalid-state" };
      const key = process.env.TONAPI_KEY?.trim();
      if (!key || !w.wallet_address) return { ok: false, status: 500, error: "server-misconfigured" };

      const { fetchJettonHistory, fetchJettonWallet } = await import("./server/tonapi.ts");
      const { VLR_JETTON_MASTER, TREASURY_ADDRESS } = await import("./server/env.ts");
      const { toRawAddress } = await import("./server/ton-address.ts");
      const { evaluateWallet, DEFAULT_CONFIG } = await import("./server/sell-guard.ts");
      const { decideWithdrawal } = await import("./server/admin.ts");
      let events, balance;
      try {
        [events, balance] = await Promise.all([
          fetchJettonHistory(key, w.wallet_address, VLR_JETTON_MASTER),
          fetchJettonWallet(key, w.wallet_address, VLR_JETTON_MASTER).then((j) => j.balance),
        ]);
      } catch {
        return { ok: false, status: 502, error: "chain-lookup-failed" };
      }
      const now = Date.now();
      const createdAt = Number(w.created_ms);
      const guard = evaluateWallet(
        { events, pending: [{ id: data.id, createdAt }], now },
        { ...DEFAULT_CONFIG, ignoreOut: [toRawAddress(TREASURY_ADDRESS)!] },
      );
      const d = decideWithdrawal({ createdAt, now, gross: Number(w.amount_micro_vlr) / MICRO, walletVlrBalance: balance, banned: !!w.banned_at, guard });
      if (d.action === "ready") { await resolve("approve", data.note, null); return { ok: true, outcome: "approved" }; }
      if (d.action === "wait") return { ok: false, status: 409, error: "wait-indexing-buffer" };
      if (d.action === "forfeit") {
        await resolve("forfeit", d.reason, null, true);
        return { ok: true, outcome: "forfeited", reason: d.reason };
      }
      return { ok: false, status: 409, error: d.reason }; // banned / hold-not-met: admin decides (reject = refund)
    } catch (e) {
      const code = mapDbError(e);
      return { ok: false, status: code === "internal-error" ? 500 : 409, error: code };
    }
  });
