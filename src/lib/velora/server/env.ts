// Single place where every secret/config value is read. Secrets live ONLY in
// environment variables (Vercel > Settings > Environment Variables, or a local
// .env that is git-ignored). Never paste a token into source code: anything in
// the repo or a zip can leak.
import { toRawAddress } from "./ton-address.ts";

// Public on-chain addresses (safe to keep in code).
export const TREASURY_ADDRESS = "UQC9r6buJ2_6JcXJ8Dy4hoGt-UaZ9xw1yZsK08HXH-BwfX7W";
export const VLR_JETTON_MASTER = "EQAM4mqepzSh2667Uc_CWUXqcpAl28kLRFgcVFY-YVNC-kxF";
export const BOT_USERNAME = "VELORA_MINER_bot";

export type VeloraEnv = {
  tgBotToken: string; // TG_BOT_TOKEN env var only (never hardcode)
  tonapiKey: string; // TONAPI_KEY
  memoSecret: string; // MEMO_SECRET (any long random string; signs deposit memos)
  adminIds: string; // ADMIN_TG_IDS, comma separated (e.g. 1642396044)
  hotWalletMnemonic: string; // HOT_WALLET_MNEMONIC (separate small wallet; auto VLR payouts)
};

const REQUIRED: [keyof VeloraEnv, string][] = [
  ["tgBotToken", "TG_BOT_TOKEN"],
  ["tonapiKey", "TONAPI_KEY"],
  ["memoSecret", "MEMO_SECRET"],
  ["adminIds", "ADMIN_TG_IDS"],
  ["hotWalletMnemonic", "HOT_WALLET_MNEMONIC"],
];

export function readEnv(
  source: Record<string, string | undefined> = process.env,
): { ok: true; env: VeloraEnv } | { ok: false; missing: string[]; invalid: string[] } {
  const missing: string[] = [];
  const invalid: string[] = [];
  const env = {} as VeloraEnv;
  for (const [key, name] of REQUIRED) {
    const v = (source[name])?.trim();
    if (!v) missing.push(name);
    else env[key] = v;
  }
  if (env.tgBotToken && !/^\d{6,12}:[A-Za-z0-9_-]{30,}$/.test(env.tgBotToken)) invalid.push("TG_BOT_TOKEN");
  if (env.memoSecret && env.memoSecret.length < 24) invalid.push("MEMO_SECRET");
  if (toRawAddress(TREASURY_ADDRESS) === null) invalid.push("TREASURY_ADDRESS");
  if (toRawAddress(VLR_JETTON_MASTER) === null) invalid.push("VLR_JETTON_MASTER");
  return missing.length || invalid.length ? { ok: false, missing, invalid } : { ok: true, env };
}
