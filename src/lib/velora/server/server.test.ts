import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { toRawAddress, sameAddress } from "./ton-address.ts";
import { evaluateWallet, HOUR, type JettonEvent } from "./sell-guard.ts";
import { referralBonus, parseStartParam, type Party } from "./referral.ts";
import { verifyInitData } from "./telegram-auth.ts";

const T0 = Date.UTC(2026, 10, 18);
const ev = (id: string, h: number, direction: "in" | "out", amount: number): JettonEvent => ({
  id, at: T0 + h * HOUR, direction, amount,
});

describe("ton-address", () => {
  it("accepts the two project addresses and rejects a corrupted one", () => {
    assert.ok(toRawAddress("UQC9r6buJ2_6JcXJ8Dy4hoGt-UaZ9xw1yZsK08HXH-BwfX7W"));
    assert.ok(toRawAddress("EQAM4mqepzSh2667Uc_CWUXqcpAl28kLRFgcVFY-YVNC-kxF"));
    assert.equal(toRawAddress("UQC9r6buJ2_6JcXJ8Dy4hoGt-UaZ9xw1yZsK08HXH-BwfX7X"), null);
  });
  it("treats EQ/UQ/raw forms of one wallet as equal", () => {
    const raw = toRawAddress("UQC9r6buJ2_6JcXJ8Dy4hoGt-UaZ9xw1yZsK08HXH-BwfX7W")!;
    assert.ok(sameAddress("UQC9r6buJ2_6JcXJ8Dy4hoGt-UaZ9xw1yZsK08HXH-BwfX7W", raw));
  });
});

describe("sell-guard", () => {
  it("lets a user sell 2,500 within 24h after a 10,000 deposit, bans on the next sell", () => {
    const base = [ev("d", 0, "in", 10_000), ev("s1", 1, "out", 2_500)];
    const ok = evaluateWallet({ events: base, pending: [], now: T0 + 2 * HOUR });
    assert.equal(ok.ok, true);
    assert.equal(ok.ok && ok.remaining, 0);
    const bad = evaluateWallet({ events: [...base, ev("s2", 5, "out", 1)], pending: [], now: T0 + 6 * HOUR });
    assert.equal(bad.ok, false);
    assert.equal(!bad.ok && bad.reason, "daily-cap-exceeded");
  });
  it("window rolls: 2,500 on day 1 and 2,500 on day 2 is fine", () => {
    const r = evaluateWallet({
      events: [ev("d", 0, "in", 10_000), ev("s1", 1, "out", 2_500), ev("s2", 26, "out", 2_500)],
      pending: [], now: T0 + 27 * HOUR,
    });
    assert.equal(r.ok, true);
  });
  it("no cap after the 72h lock expires", () => {
    const r = evaluateWallet({
      events: [ev("d", 0, "in", 10_000), ev("s1", 80, "out", 9_000)],
      pending: [], now: T0 + 81 * HOUR,
    });
    assert.equal(r.ok, true);
  });
  it("selling during a pending withdrawal bans and forfeits it", () => {
    const r = evaluateWallet({
      events: [ev("s1", 10, "out", 1)],
      pending: [{ id: "W1", createdAt: T0 + 9 * HOUR }], now: T0 + 11 * HOUR,
    });
    assert.equal(r.ok, false);
    assert.deepEqual(!r.ok && r.forfeit, ["W1"]);
  });
  it("a sell before the withdrawal was requested is not a violation", () => {
    const r = evaluateWallet({
      events: [ev("s1", 1, "out", 5)],
      pending: [{ id: "W1", createdAt: T0 + 9 * HOUR }], now: T0 + 11 * HOUR,
    });
    assert.equal(r.ok, true);
  });
});

describe("referral", () => {
  const inv: Party = { tgId: 2, walletRaw: "0:aa", walletVerified: true, banned: false };
  const ref: Party = { tgId: 1, walletRaw: "0:bb", walletVerified: true, banned: false };
  it("pays 5% only after the invitee wallet is verified", () => {
    assert.equal(referralBonus(1000, inv, ref), 50);
    assert.equal(referralBonus(1000, { ...inv, walletVerified: false }, ref), 0);
  });
  it("blocks self-referral, shared wallet and banned parties", () => {
    assert.equal(referralBonus(1000, inv, { ...ref, tgId: 2 }), 0);
    assert.equal(referralBonus(1000, inv, { ...ref, walletRaw: "0:aa" }), 0);
    assert.equal(referralBonus(1000, { ...inv, banned: true }, ref), 0);
  });
  it("parses start params", () => {
    assert.equal(parseStartParam("ref_123"), 123);
    assert.equal(parseStartParam("x"), null);
  });
});

describe("telegram initData", () => {
  const token = "123456:TEST";
  const build = (authDate: number, tamper = false) => {
    const p = new URLSearchParams({
      auth_date: String(authDate),
      query_id: "q",
      start_param: "ref_1",
      user: JSON.stringify({ id: 42, username: "u" }),
    });
    const check = [...p.entries()].sort(([a], [b]) => (a < b ? -1 : 1)).map(([k, v]) => `${k}=${v}`).join("\n");
    const secret = createHmac("sha256", "WebAppData").update(token).digest();
    p.set("hash", createHmac("sha256", secret).update(check).digest("hex"));
    if (tamper) p.set("user", JSON.stringify({ id: 43 }));
    return p.toString();
  };
  const now = Date.now();
  it("accepts valid, rejects tampered and expired", () => {
    const good = verifyInitData(build(Math.floor(now / 1000)), token, now);
    assert.equal(good.ok && good.user.id, 42);
    assert.equal(good.ok && good.startParam, "ref_1");
    const bad = verifyInitData(build(Math.floor(now / 1000), true), token, now);
    assert.equal(!bad.ok && bad.reason, "bad-hash");
    const old = verifyInitData(build(Math.floor(now / 1000) - 7200), token, now);
    assert.equal(!old.ok && old.reason, "expired");
    const future = verifyInitData(build(Math.floor(now / 1000) + 61), token, now);
    assert.equal(!future.ok && future.reason, "future-auth-date");
  });
});
