import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { feeFor, planWithdrawal, mapDbError, MICRO, WITHDRAW_FEE_BP } from "./withdraw-rules.ts";
import { WITHDRAW_FEE } from "../economy.ts";

const ok = { amountMicro: 10_000 * MICRO, banned: false, walletVerified: true, walletVlr: 5_000 };

describe("withdraw rules", () => {
  it("fee is computed on the server in integers and matches the economy constant", () => {
    assert.equal(WITHDRAW_FEE_BP / 10_000, WITHDRAW_FEE);
    assert.equal(feeFor(10_000 * MICRO), 500 * MICRO);
    assert.equal(feeFor(10_000_000_001), 500_000_000); // floors, no float drift
  });
  it("accepts a valid request and returns fee + net", () => {
    const p = planWithdrawal(ok);
    assert.deepEqual(p, { ok: true, fee: 500 * MICRO, net: 9_500 * MICRO });
  });
  it("blocks banned, unverified, below minimum, bad amounts, and unmet 25% hold", () => {
    const r = (o: object) => { const p = planWithdrawal({ ...ok, ...o }); return p.ok ? "ok" : p.reason; };
    assert.equal(r({ banned: true }), "banned");
    assert.equal(r({ walletVerified: false }), "no-verified-wallet");
    assert.equal(r({ amountMicro: 9_999 * MICRO }), "below-minimum");
    assert.equal(r({ amountMicro: 1.5 }), "bad-amount");
    assert.equal(r({ amountMicro: -5 }), "bad-amount");
    assert.equal(r({ walletVlr: 2_499 }), "hold-not-met");
    assert.equal(r({ walletVlr: 2_500 }), "ok");
    assert.equal(r({ amountMicro: 40_000 * MICRO, walletVlr: 9_999 }), "hold-not-met");
    assert.equal(r({ amountMicro: 40_000 * MICRO, walletVlr: 10_000 }), "ok");
  });
  it("maps database errors to stable codes without leaking text", () => {
    assert.equal(mapDbError(new Error("insufficient balance")), "insufficient-balance");
    assert.equal(mapDbError(new Error('relation "velora_x" does not exist')), "internal-error");
    assert.equal(mapDbError(null), "internal-error");
  });
});
