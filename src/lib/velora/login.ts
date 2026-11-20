// POST server function: Telegram mini app login. Client sends ONLY the raw
// initData string; identity is derived server-side (see server/session.ts).
// Node-only modules are imported dynamically inside the handler so nothing
// server-only is pulled into the client bundle.
import { createServerFn } from "@tanstack/react-start";
import type { PublicProfile } from "./server/users.ts";

export type LoginResponse =
  | { ok: true; profile: PublicProfile; isAdmin: boolean }
  | { ok: false; status: number; error: string };

export const loginWithTelegram = createServerFn({ method: "POST" })
  .validator((data: unknown) => {
    const initData = (data as { initData?: unknown } | null)?.initData;
    return { initData: typeof initData === "string" ? initData : "" };
  })
  .handler(async ({ data }): Promise<LoginResponse> => {
    const { authenticateTelegram } = await import("./server/session.ts");
    const auth = authenticateTelegram(data.initData, process.env);
    if (!auth.ok) return { ok: false, status: auth.status, error: auth.error };

    const { getSql } = await import("@/lib/db");
    const { upsertTelegramUser, toPublicProfile } = await import("./server/users.ts");
    const row = await upsertTelegramUser(await getSql(), auth.user, auth.startParam);
    if (row.banned_at) return { ok: false, status: 403, error: "banned" };
    return { ok: true, profile: toPublicProfile(row), isAdmin: auth.isAdmin };
  });
