import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { authenticateTelegram } from "./session.ts";

const TOKEN = "123456789:" + "A".repeat(35);
const NOW = Date.UTC(2026, 10, 18, 12);

function sign(fields: Record<string, string>, token = TOKEN): string {
  const check = Object.entries(fields).sort(([a], [b]) => (a < b ? -1 : 1)).map(([k, v]) => `${k}=${v}`).join("\n");
  const secret = createHmac("sha256", "WebAppData").update(token).digest();
  const hash = createHmac("sha256", secret).update(check).digest("hex");
  return new URLSearchParams({ ...fields, hash }).toString();
}
const fields = (id: number, ageSec = 10) => ({
  auth_date: String(Math.floor(NOW / 1000) - ageSec),
  user: JSON.stringify({ id, username: "u" }),
  start_param: "ref_7",
});
const env = { TG_BOT_TOKEN: TOKEN, ADMIN_TG_IDS: "1642396044" };

describe("authenticateTelegram", () => {
  it("accepts valid initData and flags admins only from the env list", () => {
    const a = authenticateTelegram(sign(fields(1642396044)), env, NOW);
    assert.ok(a.ok && a.isAdmin && a.startParam === "ref_7");
    const b = authenticateTelegram(sign(fields(5)), env, NOW);
    assert.ok(b.ok && !b.isAdmin);
  });
  it("rejects tampering, wrong bot token, expiry, and bad input", () => {
    const good = sign(fields(5));
    const tampered = good.replace("%22id%22%3A5", "%22id%22%3A1642396044");
    assert.notEqual(tampered, good);
    const t = authenticateTelegram(tampered, env, NOW);
    assert.ok(!t.ok && t.status === 401);
    assert.ok(!authenticateTelegram(sign(fields(5), "999999999:" + "B".repeat(35)), env, NOW).ok);
    const old = authenticateTelegram(sign(fields(5, 3 * 24 * 3600)), env, NOW);
    assert.ok(!old.ok && old.error === "unauthorized:expired");
    const futureFields = { ...fields(5), auth_date: String(Math.floor(NOW / 1000) + 61) };
    const future = authenticateTelegram(sign(futureFields), env, NOW);
    assert.ok(!future.ok && future.error === "unauthorized:future-auth-date");
    for (const bad of [undefined, 42, "", "x".repeat(5000)]) {
      const r = authenticateTelegram(bad, env, NOW);
      assert.ok(!r.ok && r.status === 400);
    }
  });
  it("reports a missing/bad bot token by name without echoing it", () => {
    const r = authenticateTelegram(sign(fields(5)), { TG_BOT_TOKEN: "bad" }, NOW);
    assert.ok(!r.ok && r.status === 500 && !JSON.stringify(r).includes("bad\""));
    assert.ok(!authenticateTelegram(sign(fields(5)), {}, NOW).ok);
  });
});
