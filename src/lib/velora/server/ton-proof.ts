// TON Connect `ton_proof` verification: proves the user controls the private key
// of a wallet. Spec: message = "ton-proof-item-v2/" ++ addr(wc int32 BE, hash 32B)
// ++ domainLen(uint32 LE) ++ domain ++ timestamp(uint64 LE) ++ payload;
// signed digest = sha256(0xffff ++ "ton-connect" ++ sha256(message)), Ed25519.
// The challenge `payload` is stateless: expiry + HMAC bound to the Telegram id,
// so a proof made for one account cannot be replayed on another.
import { createHash, createHmac, createPublicKey, timingSafeEqual, verify } from "node:crypto";
import { toRawAddress } from "./ton-address.ts";

export const CHALLENGE_TTL_MS = 10 * 60_000;
export const PROOF_MAX_AGE_MS = 15 * 60_000;
export const MAINNET_CHAIN = "-239";
export const TESTNET_CHAIN = "-3";

const sha256 = (b: Buffer | Uint8Array) => createHash("sha256").update(b).digest();
const SPKI_ED25519 = Buffer.from("302a300506032b6570032100", "hex");

const mac = (secret: string, tgId: number, exp: number) =>
  createHmac("sha256", secret).update(`ton-proof|${tgId}|${exp}`).digest("hex").slice(0, 32);

export function makeChallenge(tgId: number, secret: string, now = Date.now()): string {
  const exp = now + CHALLENGE_TTL_MS;
  return `${exp.toString(36)}.${mac(secret, tgId, exp)}`;
}

export function checkChallenge(payload: string, tgId: number, secret: string, now = Date.now()): boolean {
  const m = /^([0-9a-z]{1,12})\.([0-9a-f]{32})$/.exec(payload);
  if (!m) return false;
  const exp = parseInt(m[1], 36);
  if (!(exp > now) || exp - now > CHALLENGE_TTL_MS) return false;
  const a = Buffer.from(m[2]);
  const b = Buffer.from(mac(secret, tgId, exp));
  return a.length === b.length && timingSafeEqual(a, b);
}

export type TonProof = {
  timestamp: number; // seconds
  domain: { lengthBytes: number; value: string };
  payload: string;
  signature: string; // base64
};

export type ProofResult =
  | { ok: true; walletRaw: string }
  | { ok: false; reason: "chain" | "address" | "domain" | "payload" | "timestamp" | "public-key" | "signature" };

export function verifyTonProof(i: {
  address: string; // as sent by the wallet (raw or friendly)
  chain: string;
  publicKeyHex: string; // the key the wallet claims
  trustedPublicKeyHex: string | null; // key of that address according to the chain (TonAPI)
  proof: TonProof;
  expectedDomain: string;
  tgId: number;
  secret: string;
  now?: number;
  expectedChain?: string;
}): ProofResult {
  const now = i.now ?? Date.now();
  if (i.chain !== (i.expectedChain ?? MAINNET_CHAIN)) return { ok: false, reason: "chain" };
  const raw = toRawAddress(i.address);
  const m = raw ? /^(-1|0):([0-9a-f]{64})$/.exec(raw) : null;
  if (!m) return { ok: false, reason: "address" };
  const domain = Buffer.from(i.proof.domain.value, "utf8");
  if (i.proof.domain.value !== i.expectedDomain || i.proof.domain.lengthBytes !== domain.length) {
    return { ok: false, reason: "domain" };
  }
  if (!checkChallenge(i.proof.payload, i.tgId, i.secret, now)) return { ok: false, reason: "payload" };
  const tsMs = i.proof.timestamp * 1000;
  if (!Number.isInteger(i.proof.timestamp) || now - tsMs > PROOF_MAX_AGE_MS || tsMs - now > 60_000) {
    return { ok: false, reason: "timestamp" };
  }
  const pub = /^[0-9a-fA-F]{64}$/.test(i.publicKeyHex) ? i.publicKeyHex.toLowerCase() : null;
  if (!pub || !i.trustedPublicKeyHex || pub !== i.trustedPublicKeyHex.toLowerCase()) {
    return { ok: false, reason: "public-key" };
  }
  const wc = Buffer.alloc(4);
  wc.writeInt32BE(Number(m[1]));
  const len = Buffer.alloc(4);
  len.writeUInt32LE(domain.length);
  const ts = Buffer.alloc(8);
  ts.writeBigUInt64LE(BigInt(i.proof.timestamp));
  const message = Buffer.concat([
    Buffer.from("ton-proof-item-v2/"), wc, Buffer.from(m[2], "hex"), len, domain, ts, Buffer.from(i.proof.payload),
  ]);
  const digest = sha256(Buffer.concat([Buffer.from([0xff, 0xff]), Buffer.from("ton-connect"), sha256(message)]));
  try {
    const key = createPublicKey({ key: Buffer.concat([SPKI_ED25519, Buffer.from(pub, "hex")]), format: "der", type: "spki" });
    const sig = Buffer.from(i.proof.signature, "base64");
    if (sig.length !== 64 || !verify(null, digest, key, sig)) return { ok: false, reason: "signature" };
  } catch {
    return { ok: false, reason: "signature" };
  }
  return { ok: true, walletRaw: raw! };
}
