// Verifies Telegram Mini App `initData` (HMAC-SHA256 with the bot token).
// Never trust a Telegram id sent by the client — only one that passes this.
import { createHmac, timingSafeEqual } from "node:crypto";

export type TgUser = { id: number; username?: string; first_name?: string };

export type InitDataResult =
  | { ok: true; user: TgUser; startParam?: string; authDate: number }
  | { ok: false; reason: "missing-hash" | "bad-hash" | "expired" | "future-auth-date" | "no-user" };

export function verifyInitData(
  initData: string,
  botToken: string,
  now = Date.now(),
  maxAgeSec = 3600,
): InitDataResult {
  const params = new URLSearchParams(initData);
  const hash = params.get("hash");
  if (!hash) return { ok: false, reason: "missing-hash" };
  params.delete("hash");
  const dataCheck = [...params.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => `${k}=${v}`)
    .join("\n");
  const secret = createHmac("sha256", "WebAppData").update(botToken).digest();
  const expected = createHmac("sha256", secret).update(dataCheck).digest();
  let given: Buffer;
  try {
    given = Buffer.from(hash, "hex");
  } catch {
    return { ok: false, reason: "bad-hash" };
  }
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) {
    return { ok: false, reason: "bad-hash" };
  }
  const authDate = Number(params.get("auth_date") ?? 0);
  const nowSec = Math.floor(now / 1000);
  if (!authDate || nowSec - authDate > maxAgeSec) return { ok: false, reason: "expired" };
  // Allow small clock skew, but never accept an auth_date materially in the future.
  if (authDate > nowSec + 60) return { ok: false, reason: "future-auth-date" };
  try {
    const user = JSON.parse(params.get("user") ?? "") as TgUser;
    if (typeof user.id !== "number") return { ok: false, reason: "no-user" };
    return { ok: true, user, startParam: params.get("start_param") ?? undefined, authDate };
  } catch {
    return { ok: false, reason: "no-user" };
  }
}
