// Referral: when an invited user (wallet verified) collects mined VLR, the
// inviter earns 5% of that amount on top. The invitee's own amount is untouched.

export const REFERRAL_RATE = 0.05;

export type Party = {
  tgId: number;
  walletRaw: string | null;
  walletVerified: boolean;
  banned: boolean;
};

export function referralBonus(mined: number, invitee: Party, referrer: Party | null): number {
  if (!referrer || !(mined > 0)) return 0;
  if (referrer.tgId === invitee.tgId) return 0;
  if (!invitee.walletVerified || !invitee.walletRaw) return 0;
  if (invitee.banned || referrer.banned) return 0;
  if (referrer.walletRaw && referrer.walletRaw === invitee.walletRaw) return 0;
  return Math.floor(mined * REFERRAL_RATE * 1e6) / 1e6;
}

/** Idempotency key: one ledger row per collected batch, so retries never double-pay. */
export function referralKey(inviteeTgId: number, collectId: string): string {
  return `ref:${inviteeTgId}:${collectId}`;
}

/** start_param from t.me/VELORA_MINER_bot/app?startapp=ref_<tgId> */
export function parseStartParam(param: string | undefined): number | null {
  const m = /^ref_(\d{1,15})$/.exec(param ?? "");
  return m ? Number(m[1]) : null;
}
