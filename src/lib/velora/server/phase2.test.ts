import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { matchDeposits, memoFor, parseMemo, type IncomingTransfer } from "./deposits.ts";
import { quoteBuy, toUnits } from "./buy-quote.ts";
import { checkPayout } from "./payout-guard.ts";

const S = "test-secret";
const W = "0:aa";
const tx = (o: Partial<IncomingTransfer>): IncomingTransfer => ({
  txHash: "h1", at: 1, valueNano: 500_000_000n, fromRaw: W, comment: memoFor(7, S), success: true, ...o,
});

describe("deposits", () => {
  it("credits a valid 0.5 GRAM deposit from the verified wallet", () => {
    const r = matchDeposits([tx({})], S, () => W);
    assert.equal(r.credits.length, 1);
    assert.equal(r.credits[0].gram, 0.5);
  });
  it("holds forged memo, failed tx, dust, unverified and wrong sender", () => {
    const r = matchDeposits(
      [tx({ txHash: "a", comment: "velora:7:000000" }), tx({ txHash: "b", success: false }),
       tx({ txHash: "c", valueNano: 1n }), tx({ txHash: "d", fromRaw: "0:bb" })],
      S, () => W,
    );
    assert.deepEqual(r.held.map((h) => h.reason), ["bad-memo", "failed", "dust", "wrong-sender"]);
    assert.equal(matchDeposits([tx({})], S, () => null).held[0].reason, "no-verified-wallet");
  });
  it("memo round-trips", () => assert.equal(parseMemo(memoFor(123, S), S), 123));
});

describe("buy quote", () => {
  const now = 1_000_000;
  it("applies 0.5% fee at market price", () => {
    const q = quoteBuy({ gramIn: 1, price: { gramPerVlr: 0.0001, at: now }, now });
    assert.equal(q.ok && Math.round(q.vlrOut), 9950);
  });
  it("rejects stale prices and sudden jumps", () => {
    assert.equal(!quoteBuy({ gramIn: 1, price: { gramPerVlr: 0.0001, at: now - 120_000 }, now }).ok, true);
    const j = quoteBuy({ gramIn: 1, price: { gramPerVlr: 0.0002, at: now }, now, lastGood: 0.0001 });
    assert.equal(!j.ok && j.reason, "price-jump");
  });
  it("converts to base units exactly", () => assert.equal(toUnits(9950.5, 9), 9950500000000n));
});

describe("payout guard", () => {
  const base = { amount: 1000, banned: false, userPaid24h: 0, totalPaid24h: 0, hotBalance: 1e6, alreadyPaid: false };
  it("allows normal, blocks duplicate/banned/over-limit/low balance", () => {
    assert.equal(checkPayout(base).ok, true);
    assert.equal(!checkPayout({ ...base, alreadyPaid: true }).ok, true);
    assert.equal(!checkPayout({ ...base, banned: true }).ok, true);
    assert.equal(!checkPayout({ ...base, amount: 60_000 }).ok, true);
    assert.equal(!checkPayout({ ...base, hotBalance: 500 }).ok, true);
  });
});
