import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { processPayouts, type PayoutStore, type PayoutDeps, type PayoutRec } from "./payout.ts";

function fakeStore(initial: PayoutRec[], o: { recent?: boolean; sending?: { id: string; msgHash: string; attemptedAt: number }[]; sums?: { user: number; total: number } } = {}) {
  const log: string[] = [];
  const queue = [...initial];
  const store: PayoutStore = {
    sendingWithHash: async () => o.sending ?? [],
    hasRecentSending: async () => !!o.recent,
    claimNext: async () => { const r = queue.shift() ?? null; if (r) log.push(`claim:${r.id}`); return r; },
    revertToPending: async (id) => { log.push(`revert:${id}`); },
    setMsgHash: async (id, h) => { log.push(`hash:${id}:${h}`); },
    markPaid: async (id) => { log.push(`paid:${id}`); },
    markReview: async (id, n) => { log.push(`review:${id}:${n}`); },
    paidSums: async () => o.sums ?? { user: 0, total: 0 },
  };
  return { store, log };
}
const rec: PayoutRec = { id: "buy:1", tgId: 7, vlr: 1000, walletRaw: "0:aa", banned: false };
const deps = (over: Partial<PayoutDeps> = {}, calls: string[] = []): PayoutDeps => ({
  now: () => 1_000_000,
  getSeqno: async () => 5,
  getJettonWallet: async () => ({ jettonWallet: "EQjw", balance: 1e6 }),
  buildSigned: async () => ({ boc: "BOC", msgHash: "H1" }),
  broadcast: async () => { calls.push("broadcast"); },
  checkMessage: async () => "unknown",
  ...over,
});

describe("processPayouts", () => {
  it("sends once: claim, hash recorded BEFORE broadcast", async () => {
    const { store, log } = fakeStore([rec]);
    const calls: string[] = [];
    const r = await processPayouts(store, deps({ broadcast: async () => { calls.push(`broadcast-after:${log.join(",")}`); } }));
    assert.equal(r.outcome.status, "sent");
    assert.deepEqual(log, ["claim:buy:1", "hash:buy:1:H1"]);
    assert.equal(calls[0], "broadcast-after:claim:buy:1,hash:buy:1:H1");
  });
  it("does nothing when idle or when a recent send is still in flight", async () => {
    assert.equal((await processPayouts(fakeStore([]).store, deps())).outcome.status, "idle");
    const busy = fakeStore([rec], { recent: true });
    assert.equal((await processPayouts(busy.store, deps())).outcome.status, "busy");
    assert.deepEqual(busy.log, []); // nothing claimed
  });
  it("never re-sends after an uncertain broadcast: goes to review", async () => {
    const { store, log } = fakeStore([rec]);
    const r = await processPayouts(store, deps({ broadcast: async () => { throw new Error("net"); } }));
    assert.deepEqual(r.outcome, { status: "review", note: "broadcast-uncertain" });
    assert.ok(log.includes("review:buy:1:broadcast-uncertain") && !log.some((l) => l.startsWith("revert")));
  });
  it("reverts (safe to retry) when preflight or signing fails before anything is sent", async () => {
    const a = fakeStore([rec]);
    const calls: string[] = [];
    const r1 = await processPayouts(a.store, deps({ getSeqno: async () => { throw new Error("x"); } }, calls));
    assert.equal(r1.outcome.status, "preflight-failed");
    assert.ok(a.log.includes("revert:buy:1") && calls.length === 0);
    const b = fakeStore([rec]);
    const r2 = await processPayouts(b.store, deps({ buildSigned: async () => { throw new Error("x"); } }, calls));
    assert.equal(r2.outcome.status, "preflight-failed");
    assert.equal(calls.length, 0);
  });
  it("waits (reverts) when the hot wallet is low; review for banned/over-limit/no wallet", async () => {
    const low = fakeStore([rec]);
    assert.equal((await processPayouts(low.store, deps({ getJettonWallet: async () => ({ jettonWallet: "x", balance: 10 }) }))).outcome.status, "hot-wallet-low");
    assert.ok(low.log.includes("revert:buy:1"));
    const calls: string[] = [];
    const banned = fakeStore([{ ...rec, banned: true }]);
    assert.deepEqual((await processPayouts(banned.store, deps({}, calls))).outcome, { status: "review", note: "banned" });
    const big = fakeStore([{ ...rec, vlr: 60_000 }]);
    assert.deepEqual((await processPayouts(big.store, deps({}, calls))).outcome, { status: "review", note: "per-tx-limit" });
    const daily = fakeStore([rec], { sums: { user: 199_500, total: 0 } });
    assert.deepEqual((await processPayouts(daily.store, deps({}, calls))).outcome, { status: "review", note: "user-daily-limit" });
    const nw = fakeStore([{ ...rec, walletRaw: null }]);
    assert.deepEqual((await processPayouts(nw.store, deps({}, calls))).outcome, { status: "review", note: "no-wallet" });
    assert.equal(calls.length, 0); // none of these ever broadcast
  });
  it("settles earlier sends: success -> paid, failed -> review, old unknown -> review", async () => {
    const s = fakeStore([], { sending: [{ id: "a", msgHash: "ha", attemptedAt: 0 }, { id: "b", msgHash: "hb", attemptedAt: 0 }, { id: "c", msgHash: "hc", attemptedAt: 999_000 }] });
    const r = await processPayouts(s.store, deps({ checkMessage: async (h) => (h === "ha" ? "success" : h === "hb" ? "failed" : "unknown") }));
    assert.equal(r.confirmed, 1);
    assert.deepEqual(s.log, ["paid:a", "review:b:tx-failed-onchain"]); // c is young: keeps waiting
  });
});
