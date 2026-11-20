import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { makeChallenge, checkChallenge, verifyTonProof, MAINNET_CHAIN, TESTNET_CHAIN, type TonProof } from "./ton-proof.ts";
import { parsePublicKey } from "./tonapi.ts";

const S = "unit-test-secret-unit-test-secret";
const NOW = 1_800_000_000_000;
const DOMAIN = "velora.example.app";
const HASH = "cd".repeat(32);
const ADDR = `0:${HASH}`;
const sha = (b: Buffer) => createHash("sha256").update(b).digest();

const { publicKey, privateKey } = generateKeyPairSync("ed25519");
const PUB = (publicKey.export({ format: "der", type: "spki" }) as Buffer).subarray(-32).toString("hex");

function makeProof(over: Partial<TonProof> = {}, tgId = 7): TonProof {
  const payload = over.payload ?? makeChallenge(tgId, S, NOW);
  const timestamp = over.timestamp ?? Math.floor(NOW / 1000);
  const domain = over.domain ?? { lengthBytes: DOMAIN.length, value: DOMAIN };
  const wc = Buffer.alloc(4); wc.writeInt32BE(0);
  const len = Buffer.alloc(4); len.writeUInt32LE(Buffer.byteLength(domain.value));
  const ts = Buffer.alloc(8); ts.writeBigUInt64LE(BigInt(timestamp));
  const msg = Buffer.concat([Buffer.from("ton-proof-item-v2/"), wc, Buffer.from(HASH, "hex"), len, Buffer.from(domain.value), ts, Buffer.from(payload)]);
  const digest = sha(Buffer.concat([Buffer.from([0xff, 0xff]), Buffer.from("ton-connect"), sha(msg)]));
  return { timestamp, domain, payload, signature: sign(null, digest, privateKey).toString("base64") };
}
const base = (proof: TonProof) => ({ address: ADDR, chain: MAINNET_CHAIN, publicKeyHex: PUB, trustedPublicKeyHex: PUB, proof, expectedDomain: DOMAIN, tgId: 7, secret: S, now: NOW });

describe("challenge", () => {
  it("is bound to the user and expires", () => {
    const c = makeChallenge(7, S, NOW);
    assert.ok(c.length < 128);
    assert.equal(checkChallenge(c, 7, S, NOW + 1000), true);
    assert.equal(checkChallenge(c, 8, S, NOW + 1000), false);
    assert.equal(checkChallenge(c, 7, "other-secret-other-secret-xx", NOW + 1000), false);
    assert.equal(checkChallenge(c, 7, S, NOW + 11 * 60_000), false);
    assert.equal(checkChallenge("garbage", 7, S, NOW), false);
  });
});

describe("verifyTonProof", () => {
  it("accepts a correctly signed proof and returns the raw wallet", () => {
    const r = verifyTonProof(base(makeProof()));
    assert.deepEqual(r, { ok: true, walletRaw: ADDR });
  });
  it("accepts a correctly signed testnet proof only when testnet is explicitly selected", () => {
    const p = makeProof();
    assert.equal((verifyTonProof({ ...base(p), chain: TESTNET_CHAIN }) as { reason: string }).reason, "chain");
    assert.deepEqual(verifyTonProof({ ...base(p), chain: TESTNET_CHAIN, expectedChain: TESTNET_CHAIN }), { ok: true, walletRaw: ADDR });
  });
  it("rejects wrong chain, domain, user, stale/future timestamp", () => {
    const p = makeProof();
    assert.equal((verifyTonProof({ ...base(p), chain: "-3" }) as { reason: string }).reason, "chain");
    assert.equal((verifyTonProof({ ...base(makeProof({ domain: { lengthBytes: 9, value: "evil.site" } })) }) as { reason: string }).reason, "domain");
    assert.equal((verifyTonProof({ ...base(p), tgId: 8 }) as { reason: string }).reason, "payload");
    assert.equal((verifyTonProof({ ...base(makeProof({ timestamp: Math.floor(NOW / 1000) - 3600 })) }) as { reason: string }).reason, "timestamp");
    assert.equal((verifyTonProof({ ...base(makeProof({ timestamp: Math.floor(NOW / 1000) + 3600 })) }) as { reason: string }).reason, "timestamp");
  });
  it("rejects a public key the chain does not attribute to the address, and bad signatures", () => {
    const p = makeProof();
    const other = "ef".repeat(32);
    assert.equal((verifyTonProof({ ...base(p), trustedPublicKeyHex: other }) as { reason: string }).reason, "public-key");
    assert.equal((verifyTonProof({ ...base(p), trustedPublicKeyHex: null }) as { reason: string }).reason, "public-key");
    assert.equal((verifyTonProof({ ...base(p), publicKeyHex: other }) as { reason: string }).reason, "public-key");
    const bad = { ...p, signature: Buffer.alloc(64, 1).toString("base64") };
    assert.equal((verifyTonProof(base(bad)) as { reason: string }).reason, "signature");
    assert.equal((verifyTonProof({ ...base(p), address: `0:${"ab".repeat(32)}` }) as { reason: string }).reason, "signature");
  });
});

describe("parsePublicKey", () => {
  it("accepts 64-hex only", () => {
    assert.equal(parsePublicKey({ public_key: "AB".repeat(32) }), "ab".repeat(32));
    assert.equal(parsePublicKey({ public_key: "xyz" }), null);
    assert.equal(parsePublicKey(null), null);
  });
});
