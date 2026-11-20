// Telegram login: turns raw `initData` into a trusted identity. The Telegram id
// is NEVER taken from a client field, only from a payload that passes
// verifyInitData() (HMAC with the bot token).
import { verifyInitData, type TgUser } from "./telegram-auth.ts";
import { parseAdminIds, isAdmin } from "./admin.ts";

export const MAX_INIT_DATA_LENGTH = 4096;
// Telegram initData is re-issued when the Mini App is opened again. Keep the
// current 24-hour compatibility window; future timestamps are rejected separately.
// A renewable server session should replace this long window before production.
export const INIT_DATA_MAX_AGE_SEC = 24 * 3600;

export type AuthResult =
  | { ok: true; user: TgUser; startParam?: string; isAdmin: boolean }
  | { ok: false; status: 400 | 401 | 500; error: string };

export function authenticateTelegram(
  initData: unknown,
  source: Record<string, string | undefined>,
  now = Date.now(),
): AuthResult {
  if (typeof initData !== "string" || !initData || initData.length > MAX_INIT_DATA_LENGTH) {
    return { ok: false, status: 400, error: "invalid-init-data" };
  }
  const token = source.TG_BOT_TOKEN?.trim();
  // Config problems are reported by NAME only; secret values are never echoed.
  if (!token || !/^\d{6,12}:[A-Za-z0-9_-]{30,}$/.test(token)) {
    return { ok: false, status: 500, error: "server-misconfigured:TG_BOT_TOKEN" };
  }
  const v = verifyInitData(initData, token, now, INIT_DATA_MAX_AGE_SEC);
  if (!v.ok) return { ok: false, status: 401, error: `unauthorized:${v.reason}` };
  const admins = parseAdminIds(source.ADMIN_TG_IDS);
  return { ok: true, user: v.user, startParam: v.startParam, isAdmin: isAdmin(v.user.id, admins) };
}
