// Wires the real TonAPI + hot wallet into processPayouts. Returns null when payouts
// are not configured (no HOT_WALLET_MNEMONIC), so buys simply stay 'pending_payout'.
import { processPayouts, pgPayoutStore, type PayoutDeps } from "./payout.ts";
import { fetchSeqno, fetchJettonWallet, broadcastBoc, checkMessage } from "./tonapi.ts";
import { VLR_JETTON_MASTER } from "./env.ts";
import type { SqlLike } from "./users.ts";

export async function runPayoutsOnce(sql: SqlLike, source: Record<string, string | undefined> = process.env) {
  const mnemonic = source.HOT_WALLET_MNEMONIC?.trim();
  const key = source.TONAPI_KEY?.trim();
  if (!mnemonic || !key) return null;
  const { loadHotWallet, buildSignedJettonTransfer } = await import("./ton-sign.ts");
  const hot = await loadHotWallet(mnemonic);
  const deps: PayoutDeps = {
    now: () => Date.now(),
    getSeqno: () => fetchSeqno(key, hot.rawAddress),
    getJettonWallet: () => fetchJettonWallet(key, hot.rawAddress, VLR_JETTON_MASTER),
    buildSigned: (a) => buildSignedJettonTransfer(hot, a),
    broadcast: (boc) => broadcastBoc(key, boc),
    checkMessage: (h) => checkMessage(key, h),
  };
  return processPayouts(pgPayoutStore(sql), deps);
}
