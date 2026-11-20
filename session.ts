// Server-verified identity from the Telegram login. Not persisted on purpose:
// it is re-established on every launch from Telegram's signed initData.
import { create } from "zustand";
import type { PublicProfile } from "./server/users.ts";

type Session =
  | { status: "idle" | "loading" | "offline" }
  | { status: "authed"; profile: PublicProfile; isAdmin: boolean }
  | { status: "error"; error: string };

export const useSession = create<Session>()(() => ({ status: "idle" }));
