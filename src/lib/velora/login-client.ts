// Browser side: read Telegram's initData and call the login server function.
import { loginWithTelegram, type LoginResponse } from "./login.ts";

type TgWebApp = { initData?: string; ready?: () => void; expand?: () => void };
declare global {
  interface Window {
    Telegram?: { WebApp?: TgWebApp };
  }
}

export async function signInWithTelegram(): Promise<LoginResponse> {
  const wa = window.Telegram?.WebApp;
  if (!wa?.initData) return { ok: false, status: 400, error: "not-in-telegram" };
  wa.ready?.();
  return loginWithTelegram({ data: { initData: wa.initData } });
}
