import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { sendTelegramMessage } from "./telegram-notify.ts";

describe("Telegram withdrawal notifications", () => {
  it("sends a message and includes a Mini App admin button only for HTTPS URLs", async () => {
    let sentUrl = "";
    let sentBody = "";
    const ok = await sendTelegramMessage(
      123456,
      "New withdrawal",
      { TG_BOT_TOKEN: "123456789:" + "A".repeat(35), MINI_APP_URL: "https://velora.example.com" },
      async (url, init) => {
        sentUrl = url;
        sentBody = init.body;
        return { ok: true };
      },
    );
    assert.equal(ok, true);
    assert.match(sentUrl, /^https:\/\/api\.telegram\.org\/bot/);
    const body = JSON.parse(sentBody);
    assert.equal(body.chat_id, 123456);
    assert.equal(body.text, "New withdrawal");
    assert.equal(body.reply_markup.inline_keyboard[0][0].web_app.url, "https://velora.example.com");
  });

  it("fails closed when the bot token is missing and does not call Telegram", async () => {
    let called = false;
    const ok = await sendTelegramMessage(123456, "test", {}, async () => {
      called = true;
      return { ok: true };
    });
    assert.equal(ok, false);
    assert.equal(called, false);
  });

  it("does not add a web app button for non-HTTPS URLs", async () => {
    let sentBody = "";
    await sendTelegramMessage(
      123456,
      "New withdrawal",
      { TG_BOT_TOKEN: "123456789:" + "A".repeat(35), MINI_APP_URL: "http://example.com" },
      async (_url, init) => { sentBody = init.body; return { ok: true }; },
    );
    assert.equal("reply_markup" in JSON.parse(sentBody), false);
  });
});
