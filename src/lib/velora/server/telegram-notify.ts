import { parseAdminIds } from "./admin.ts";

type FetchLike = (url: string, init: { method: string; headers: Record<string, string>; body: string }) => Promise<{ ok: boolean }>;

export async function sendTelegramMessage(
  chatId: number | string,
  text: string,
  source: Record<string, string | undefined> = process.env,
  fetcher: FetchLike = fetch as unknown as FetchLike,
): Promise<boolean> {
  const token = source.TG_BOT_TOKEN?.trim();
  if (!token || !/^\d{6,12}:[A-Za-z0-9_-]{30,}$/.test(token)) return false;
  const miniAppUrl = source.MINI_APP_URL?.trim();
  const reply_markup = miniAppUrl && /^https:\/\//i.test(miniAppUrl)
    ? { inline_keyboard: [[{ text: "Open VELORA Admin", web_app: { url: miniAppUrl } }]] }
    : undefined;
  try {
    const response = await fetcher(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, text, ...(reply_markup ? { reply_markup } : {}) }),
    });
    return response.ok;
  } catch {
    return false;
  }
}

export async function notifyAdmins(
  text: string,
  source: Record<string, string | undefined> = process.env,
): Promise<void> {
  const ids = parseAdminIds(source.ADMIN_TG_IDS);
  await Promise.all([...ids].map((id) => sendTelegramMessage(id, text, source)));
}
