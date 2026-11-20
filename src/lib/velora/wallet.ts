// Server functions for wallet verification (TON Connect ton_proof).
// Identity comes only from verified Telegram initData; node-only code is imported dynamically.
import { createServerFn } from "@tanstack/react-start";

export type ChallengeResult =
  | { ok: true; payload: string }
  | { ok: false; status: number; error: string };
export type VerifyResult =
  | { ok: true; wallet: string }
  | { ok: false; status: number; error: string };

const str = (v: unknown, max: number) => (typeof v === "string" && v.length <= max ? v : "");

export const getWalletChallenge = createServerFn({ method: "POST" })
  .validator((d: unknown) => ({ initData: str((d as { initData?: unknown } | null)?.initData, 4096) }))
  .handler(async ({ data }): Promise<ChallengeResult> => {
    const { authenticateTelegram } = await import("./server/session.ts");
    const auth = authenticateTelegram(data.initData, process.env);
    if (!auth.ok) return { ok: false, status: auth.status, error: auth.error };
    const secret = process.env.MEMO_SECRET?.trim();
    if (!secret || secret.length < 24) return { ok: false, status: 500, error: "server-misconfigured:MEMO_SECRET" };
    const { makeChallenge } = await import("./server/ton-proof.ts");
    return { ok: true, payload: makeChallenge(auth.user.id, secret) };
  });

export const verifyWallet = createServerFn({ method: "POST" })
  .validator((d: unknown) => {
    const o = (d ?? {}) as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
    const p = (o.proof ?? {}) as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
    return {
      initData: str(o.initData, 4096),
      address: str(o.address, 100),
      chain: str(o.chain, 10),
      publicKey: str(o.publicKey, 64),
      proof: {
        timestamp: Number(p.timestamp),
        domain: { lengthBytes: Number(p.domain?.lengthBytes), value: str(p.domain?.value, 253) },
        payload: str(p.payload, 128),
        signature: str(p.signature, 200),
      },
    };
  })
  .handler(async ({ data }): Promise<VerifyResult> => {
    const { authenticateTelegram } = await import("./server/session.ts");
    const auth = authenticateTelegram(data.initData, process.env);
    if (!auth.ok) return { ok: false, status: auth.status, error: auth.error };
    const secret = process.env.MEMO_SECRET?.trim();
    const key = process.env.TONAPI_KEY?.trim();
    const domain = process.env.APP_DOMAIN?.trim();
    const network = (process.env.TON_NETWORK?.trim() || "mainnet").toLowerCase();
    const expectedChain = network === "testnet" ? "-3" : network === "mainnet" ? "-239" : null;
    // Feature flag: stays off until the proof verifier has been tested with a real wallet.
    if (process.env.TON_PROOF_ENABLED?.trim() !== "true") return { ok: false, status: 503, error: "wallet-verification-disabled" };
    if (!secret || secret.length < 24) return { ok: false, status: 500, error: "server-misconfigured:MEMO_SECRET" };
    if (!key) return { ok: false, status: 500, error: "server-misconfigured:TONAPI_KEY" };
    if (!domain) return { ok: false, status: 500, error: "server-misconfigured:APP_DOMAIN" };
    if (!expectedChain) return { ok: false, status: 500, error: "server-misconfigured:TON_NETWORK" };

    const { toRawAddress } = await import("./server/ton-address.ts");
    const { fetchPublicKey } = await import("./server/tonapi.ts");
    const { verifyTonProof } = await import("./server/ton-proof.ts");
    const raw = toRawAddress(data.address);
    if (!raw) return { ok: false, status: 400, error: "bad-address" };
    let trusted: string | null;
    try {
      trusted = await fetchPublicKey(key, raw, undefined, network as "mainnet" | "testnet");
    } catch {
      return { ok: false, status: 502, error: "chain-lookup-failed" };
    }
    const r = verifyTonProof({
      address: raw, chain: data.chain, publicKeyHex: data.publicKey, trustedPublicKeyHex: trusted,
      proof: data.proof, expectedDomain: domain, tgId: auth.user.id, secret, expectedChain,
    });
    if (!r.ok) return { ok: false, status: 401, error: `proof-rejected:${r.reason}` };

    const { getSql } = await import("@/lib/db");
    const sql = await getSql();
    const cur = await sql.query<{ wallet_address: string | null; banned_at: string | null }>(
      "SELECT wallet_address, banned_at FROM velora_users WHERE telegram_id = $1::text", [String(auth.user.id)],
    );
    if (!cur[0]) return { ok: false, status: 404, error: "no-account" };
    if (cur[0].banned_at) return { ok: false, status: 403, error: "banned" };
    if (cur[0].wallet_address === r.walletRaw) return { ok: true, wallet: r.walletRaw }; // idempotent
    if (cur[0].wallet_address) return { ok: false, status: 409, error: "wallet-locked" }; // one wallet per account
    try {
      await sql.query(
        "UPDATE velora_users SET wallet_address = $2, wallet_verified_at = now(), updated_at = now() WHERE telegram_id = $1::text AND wallet_address IS NULL",
        [String(auth.user.id), r.walletRaw],
      );
    } catch (e) {
      if ((e as { code?: string }).code === "23505") return { ok: false, status: 409, error: "wallet-in-use" };
      throw e;
    }
    return { ok: true, wallet: r.walletRaw };
  });
