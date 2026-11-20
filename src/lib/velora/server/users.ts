// Creates / refreshes the account for a verified Telegram user (ledger schema, TEXT ids).
// The referrer is recorded ONCE, on first sign-in, and only if it is an existing, different
// user. Existing accounts can never be re-parented.
import { parseStartParam } from "./referral.ts";
import type { TgUser } from "./telegram-auth.ts";

export type SqlLike = {
  query<T = Record<string, unknown>>(text: string, params?: unknown[]): Promise<T[]>;
};

export type UserRow = {
  telegram_id: string;
  username: string | null;
  wallet_address: string | null;
  wallet_verified_at: string | null;
  banned_at: string | null;
  available_micro_vlr: string | number;
  held_micro_vlr: string | number;
};

export type PublicProfile = {
  telegramId: string;
  username: string | null;
  walletVerified: boolean;
  availableMicroVlr: number;
  heldMicroVlr: number;
};

export async function upsertTelegramUser(
  sql: SqlLike,
  user: TgUser,
  startParam: string | undefined,
): Promise<UserRow> {
  const id = String(user.id);
  const ref = parseStartParam(startParam);
  await sql.query(
    `INSERT INTO velora_users (telegram_id, username, first_name, referrer_telegram_id)
     VALUES ($1::text, $2, $3, (SELECT telegram_id FROM velora_users WHERE telegram_id = $4::text AND telegram_id <> $1::text))
     ON CONFLICT (telegram_id) DO UPDATE SET username = EXCLUDED.username, first_name = EXCLUDED.first_name, updated_at = now()`,
    [id, user.username ?? null, user.first_name ?? "", ref === null ? null : String(ref)],
  );
  await sql.query("INSERT INTO velora_accounts (telegram_id) VALUES ($1::text) ON CONFLICT DO NOTHING", [id]);
  const rows = await sql.query<UserRow>(
    `SELECT u.telegram_id, u.username, u.wallet_address, u.wallet_verified_at, u.banned_at,
            a.available_micro_vlr, a.held_micro_vlr
     FROM velora_users u JOIN velora_accounts a ON a.telegram_id = u.telegram_id
     WHERE u.telegram_id = $1::text`,
    [id],
  );
  return rows[0];
}

export function toPublicProfile(row: UserRow): PublicProfile {
  return {
    telegramId: String(row.telegram_id),
    username: row.username,
    walletVerified: !!row.wallet_verified_at,
    availableMicroVlr: Number(row.available_micro_vlr),
    heldMicroVlr: Number(row.held_micro_vlr),
  };
}
