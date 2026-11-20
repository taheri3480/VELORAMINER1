import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { isDepositEnabled } from "./env.ts";

describe("real deposit safety gate", () => {
  it("keeps deposits disabled by default", () => {
    assert.equal(isDepositEnabled({}), false);
    assert.equal(isDepositEnabled({ DEPOSITS_ENABLED: "false", TON_NETWORK: "mainnet" }), false);
  });

  it("requires explicit enablement AND Mainnet", () => {
    assert.equal(isDepositEnabled({ DEPOSITS_ENABLED: "true", TON_NETWORK: "testnet" }), false);
    assert.equal(isDepositEnabled({ DEPOSITS_ENABLED: "true", TON_NETWORK: "mainnet" }), true);
    assert.equal(isDepositEnabled({ DEPOSITS_ENABLED: "true" }), false);
  });
});
