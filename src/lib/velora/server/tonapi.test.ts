import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { parseIncomingTransfers, parseVlrPrice, fetchPublicKey } from "./tonapi.ts";
import { planDeposits } from "./ingest.ts";
import { memoFor } from "./deposits.ts";
import { toRawAddress } from "./ton-address.ts";

const TREASURY = "UQC9r6buJ2_6JcXJ8Dy4hoGt-UaZ9xw1yZsK08HXH-BwfX7W";
const TR = toRawAddress(TREASURY)!;
const WALLET = "0:" + "ab".repeat(32);
const S = "unit-test-secret-unit-test-secret";

// Fixture shaped after TonAPI's /v2/blockchain/accounts/{id}/transactions.
const msg = (o: Record<string, unknown> = {}) => ({
  msg_type: "int_msg", bounced: false, value: 500000000,
  source: { address: WALLET }, destination: { address: TR },
  decoded_op_name: "text_comment", decoded_body: { text: memoFor(7, S) }, ...o,
});
const tx = (hash: string, m: unknown, o: Record<string, unknown> = {}) => ({ hash, utime: 1_700_000_000, success: true, aborted: false, in_msg: m, ...o });

describe("tonapi parsing", () => {
  it("keeps only successful, non-bounced internal transfers to the treasury", () => {
    const r = parseIncomingTransfers({ transactions: [
      tx("ok", msg()),
      tx("bounced", msg({ bounced: true })),
      tx("ext", msg({ msg_type: "ext_in_msg" })),
      tx("other-dest", msg({ destination: { address: WALLET } })),
      tx("zero", msg({ value: 0 })),
      tx("aborted", msg(), { aborted: true }),
      tx("garbage", msg({ value: "abc" })),
    ] }, TR);
    assert.deepEqual(r.map((x) => [x.txHash, x.success]), [["ok", true], ["aborted", false]]);
    assert.equal(r[0].valueNano, 500000000n);
    assert.equal(r[0].comment, memoFor(7, S));
    assert.deepEqual(parseIncomingTransfers(null, TR), []);
  });
  it("parses a price and rejects junk", () => {
    assert.equal(parseVlrPrice({ rates: { X: { prices: { TON: 0.0001 } } } }, 5)?.gramPerVlr, 0.0001);
    assert.equal(parseVlrPrice({ rates: {} }, 5), null);
    assert.equal(parseVlrPrice({ rates: { X: { prices: { TON: -1 } } } }, 5), null);
  });
});

describe("planDeposits", () => {
  const now = 1_000_000;
  const base = { secret: S, verifiedWalletOf: (id: number) => (id === 7 ? WALLET : null), alreadyCredited: new Set<string>(), price: { gramPerVlr: 0.0001, at: now }, now };
  const t = (hash: string, o = {}) => ({ txHash: hash, at: 1, valueNano: 500_000_000n, fromRaw: WALLET, comment: memoFor(7, S), success: true, ...o });
  it("credits once, skips already-credited, and applies the quote", () => {
    const p = planDeposits([t("a"), t("b")], { ...base, alreadyCredited: new Set(["b"]) });
    assert.equal(p.credits.length, 1);
    assert.equal(p.credits[0].txHash, "a");
    assert.equal(Math.round(p.credits[0].vlrOut), 4975);
    assert.equal(p.held.length, 0);
  });
  it("holds (does not credit) on no price, price jump, unverified wallet, forged memo", () => {
    assert.equal(planDeposits([t("a")], { ...base, price: null }).held[0].reason, "no-price");
    assert.equal(planDeposits([t("a")], { ...base, lastGoodPrice: 0.00001 }).held[0].reason, "quote:price-jump");
    assert.equal(planDeposits([t("a")], { ...base, verifiedWalletOf: () => null }).held[0].reason, "no-verified-wallet");
    const f = planDeposits([t("a", { comment: "velora:7:000000" })], base);
    assert.equal(f.credits.length, 0);
    assert.equal(f.held[0].reason, "bad-memo");
    assert.equal(f.held[0].tgId, null);
  });
});

import { parseJettonHistory } from "./tonapi.ts";
describe("jetton history", () => {
  const W = "0:" + "ab".repeat(32);
  const O = "0:" + "cd".repeat(32);
  const ev = (id: string, t: number, from: string, to: string, amount: string, status = "ok") => ({
    event_id: id, timestamp: t, actions: [{ type: "JettonTransfer", status, JettonTransfer: { sender: { address: from }, recipient: { address: to }, amount } }],
  });
  it("turns transfers into in/out events with VLR amounts, skipping failed and unrelated ones", () => {
    const r = parseJettonHistory({ events: [
      ev("e1", 100, O, W, "5000000000000"),
      ev("e2", 200, W, O, "1000000000000"),
      ev("e3", 300, W, O, "1000000000000", "failed"),
      ev("e4", 400, O, O, "1000000000000"),
    ] }, W);
    assert.deepEqual(r.map((e) => [e.id, e.direction, e.amount, e.at]), [["e1:0", "in", 5000, 100000], ["e2:0", "out", 1000, 200000]]);
    assert.deepEqual(parseJettonHistory(null, W), []);
  });
});


describe("network-aware wallet lookup", () => {
  it("uses the selected TonAPI network", async () => {
    const urls: string[] = [];
    const fakeFetch = async (url: string) => {
      urls.push(url);
      return { ok: true, json: async () => ({ public_key: "ab".repeat(32) }) };
    };
    await fetchPublicKey("key", WALLET, fakeFetch, "testnet");
    await fetchPublicKey("key", WALLET, fakeFetch, "mainnet");
    assert.match(urls[0], /^https:\/\/testnet\\.tonapi\\.io\//);
    assert.match(urls[1], /^https:\/\/tonapi\\.io\//);
  });
});
