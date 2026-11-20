import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { runPayoutsOnce } from "./payout-run.ts";

describe("runPayoutsOnce safety gate", () => {
  const unusedSql = {} as never;

  it("never starts a payout unless the operator explicitly enables it", async () => {
    const result = await runPayoutsOnce(unusedSql, {
      PAYOUTS_ENABLED: "false",
      TON_NETWORK: "mainnet",
      HOT_WALLET_MNEMONIC: "not-a-real-secret",
      TONAPI_KEY: "not-a-real-key",
    });
    assert.equal(result, null);
  });

  it("never starts a real payout on Testnet, even when the flag is enabled", async () => {
    const result = await runPayoutsOnce(unusedSql, {
      PAYOUTS_ENABLED: "true",
      TON_NETWORK: "testnet",
      HOT_WALLET_MNEMONIC: "not-a-real-secret",
      TONAPI_KEY: "not-a-real-key",
    });
    assert.equal(result, null);
  });

  it("fails closed when the Mainnet flag is enabled but signing credentials are absent", async () => {
    const result = await runPayoutsOnce(unusedSql, {
      PAYOUTS_ENABLED: "true",
      TON_NETWORK: "mainnet",
    });
    assert.equal(result, null);
  });
});
