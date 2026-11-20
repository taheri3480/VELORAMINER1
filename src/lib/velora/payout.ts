// Admin-only: run the payout worker on demand and list buys that need a human.
import { createServerFn } from "@tanstack/react-start";

export type AdminPayoutResult =
  | { ok: true; configured: boolean; confirmed: number; outcome: string; review: { id: string; tgId: number; vlr: number; note: string | null }[] }
  | { ok: false; status: number; error: string };

export const adminRunPayouts = createServerFn({ method: "POST" })
  .validator((d: unknown) => {
    const v = (d as { initData?: unknown } | null)?.initData;
    return { initData: typeof v === "string" && v.length <= 4096 ? v : "" };
  })
  .handler(async ({ data }): Promise<AdminPayoutResult> => {
    const { authenticateTelegram } = await import("./server/session.ts");
    const auth = authenticateTelegram(data.initData, process.env);
    if (!auth.ok) return { ok: false, status: auth.status, error: auth.error };
    if (!auth.isAdmin) return { ok: false, status: 403, error: "forbidden" };
    const { getSql } = await import("@/lib/db");
    const sql = await getSql();
    const { runPayoutsOnce } = await import("./server/payout-run.ts");
    let res: Awaited<ReturnType<typeof runPayoutsOnce>> = null;
    try {
      res = await runPayoutsOnce(sql);
    } catch {
      return { ok: false, status: 500, error: "payout-run-failed" };
    }
    const rows = await sql.query<{ id: string; telegram_id: string; vlr_out: string; review_note: string | null }>(
      "SELECT id, telegram_id, vlr_out, review_note FROM velora_buys WHERE status = 'review' ORDER BY created_at LIMIT 50",
    );
    return {
      ok: true,
      configured: res !== null,
      confirmed: res?.confirmed ?? 0,
      outcome: res?.outcome.status ?? "not-configured",
      review: rows.map((r) => ({ id: r.id, tgId: Number(r.telegram_id), vlr: Number(r.vlr_out), note: r.review_note })),
    };
  });
