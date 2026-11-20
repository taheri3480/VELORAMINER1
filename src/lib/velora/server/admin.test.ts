import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { parseAdminIds, isAdmin, decideWithdrawal } from "./admin.ts";

const ok = { ok: true as const, lockedUntil: 0, soldInWindow: 0, remaining: Infinity };
const base = { createdAt: 0, now: 10 * 60_000, gross: 10_000, walletVlrBalance: 3_000, banned: false, guard: ok };

describe("admin", () => {
  it("only listed ids are admins", () => {
    const a = parseAdminIds("1642396044, x, -5");
    assert.equal(isAdmin(1642396044, a), true);
    assert.equal(isAdmin(1, a), false);
    assert.equal(parseAdminIds(undefined).size, 0);
  });
  it("withdrawal decision", () => {
    assert.equal(decideWithdrawal(base).action, "ready");
    assert.equal(decideWithdrawal({ ...base, now: 60_000 }).action, "wait");
    assert.equal(decideWithdrawal({ ...base, walletVlrBalance: 2_000 }).action, "reject");
    // The hold is 25% of the requested gross amount, not 25% of lifetime mining.
    assert.equal(decideWithdrawal({ ...base, gross: 40_000, walletVlrBalance: 9_999 }).action, "reject");
    assert.equal(decideWithdrawal({ ...base, gross: 40_000, walletVlrBalance: 10_000 }).action, "ready");
    assert.equal(decideWithdrawal({ ...base, banned: true }).action, "reject");
    const bad = { ok: false as const, reason: "sold-during-pending-withdrawal" as const, eventId: "e", at: 1, forfeit: ["W"] };
    assert.equal(decideWithdrawal({ ...base, guard: bad }).action, "forfeit");
  });
});

import { readEnv } from "./env.ts";
describe("env", () => {
  it("reports missing and malformed values without echoing secrets", () => {
    const r = readEnv({ TG_BOT_TOKEN: "bad", MEMO_SECRET: "short" });
    assert.equal(r.ok, false);
    assert.ok(!r.ok && r.missing.includes("TONAPI_KEY") && r.invalid.includes("TG_BOT_TOKEN"));
    assert.ok(!JSON.stringify(r).includes("bad"));
  });
  it("accepts a complete, well-formed set", () => {
    const r = readEnv({
      TG_BOT_TOKEN: "123456789:" + "A".repeat(35), TONAPI_KEY: "k", MEMO_SECRET: "x".repeat(32),
      ADMIN_TG_IDS: "1642396044", HOT_WALLET_MNEMONIC: "w",
    });
    assert.equal(r.ok, true);
  });
});
