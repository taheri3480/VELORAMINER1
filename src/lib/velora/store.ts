import { create } from "zustand";
import { persist } from "zustand/middleware";
import {
  ACTIVATION_GRAM,
  BASE_DAILY,
  HOLD_TASK,
  PAYOUT_MS,
  PLANS,
  SELL_LOCK_MS,
  START_GRAM,
  SWAP_FEE,
  TASK_REWARDS,
  VLR_PER_GRAM,
  WITHDRAW_FEE,
  canMine,
  dailyRate,
  dayKey,
  liveAccrual,
  sellVerdict,
  type PlanId,
  type TaskId,
} from "@/lib/velora/economy";
import { fill, t, type Key, type Lang } from "@/lib/velora/i18n";

export type Stake = {
  amount: number;
  planId: PlanId;
  profit: number;
  mult: number;
  startedAt: number;
  endsAt: number;
};

export type Withdrawal = {
  id: string;
  gross: number;
  fee: number;
  net: number;
  status: "pending" | "completed" | "forfeited";
  createdAt: number;
  completesAt: number;
  completedAt?: number;
};

export type Notice = { id: string; text: string; at: number };

type Data = {
  lang: Lang;
  walletConnected: boolean;
  address: string;
  gram: number;
  walletVlr: number;
  activated: boolean;
  appBalance: number;
  unclaimed: number;
  lastTick: number;
  stake: Stake | null;
  withdrawals: Withdrawal[];
  totalWithdrawn: number;
  sellLockUntil: number;
  soldToday: number;
  sellDayKey: string;
  banned: { reason: "pending-sell" | "dump"; at: number } | null;
  claimedTasks: TaskId[];
  streakDay: number;
  lastClaimDay: string;
  referralCode: string;
  notices: Notice[];
  unread: number;
  everBought: boolean;
  everStaked: boolean;
  toast: string;
  toastAt: number;
};

type Actions = {
  boot: () => void;
  settle: (now?: number) => void;
  setLang: (lang: Lang) => void;
  connect: (verifiedAddress: string) => void;
  disconnect: () => void;
  activate: () => void;
  collect: () => void;
  buy: (gramIn: number) => void;
  sell: (amount: number) => void;
  openStake: (amount: number, planId: PlanId) => void;
  claimStake: () => void;
  requestWithdraw: (amount: number) => void;
  claimTask: (id: TaskId) => void;
  claimStreak: () => void;
  fastForward: (ms: number) => void;
  reset: () => void;
  clearUnread: () => void;
  clearToast: () => void;
  taskReady: (id: TaskId, now?: number) => boolean;
};

export type Store = Data & Actions;

const fresh = (): Data => ({
  lang: "en",
  walletConnected: false,
  address: "",
  gram: START_GRAM,
  walletVlr: 0,
  activated: false,
  appBalance: 0,
  unclaimed: 0,
  lastTick: 0,
  stake: null,
  withdrawals: [],
  totalWithdrawn: 0,
  sellLockUntil: 0,
  soldToday: 0,
  sellDayKey: "",
  banned: null,
  claimedTasks: [],
  streakDay: 0,
  lastClaimDay: "",
  referralCode: "",
  notices: [],
  unread: 0,
  everBought: false,
  everStaked: false,
  toast: "",
  toastAt: 0,
});

function uid(prefix: string): string {
  return `${prefix}${Math.random().toString(36).slice(2, 8)}${Date.now().toString(36).slice(-4)}`;
}

function genCode(): string {
  return String(Math.floor(1_000_000_000 + Math.random() * 9_000_000_000));
}

function say(get: () => Store, set: (partial: Partial<Data>) => void, key: Key, vars?: Record<string, string | number>) {
  const text = vars ? fill(t(get().lang, key), vars) : t(get().lang, key);
  const notice: Notice = { id: uid("n"), text, at: Date.now() };
  const cur = get();
  set({
    toast: text,
    toastAt: Date.now(),
    notices: [notice, ...cur.notices].slice(0, 20),
    unread: cur.unread + 1,
  });
}

export const useVelora = create<Store>()(
  persist(
    (set, get) => ({
      ...fresh(),
      boot: () => {
        const s = get();
        const patch: Partial<Data> = {};
        if (!s.lastTick) patch.lastTick = Date.now();
        // A locally persisted preview flag is not proof of wallet ownership.
        if (s.walletConnected || s.address) { patch.walletConnected = false; patch.address = ""; }
        if (!s.referralCode) patch.referralCode = genCode();
        if (Object.keys(patch).length) set(patch);
      },
      settle: (now = Date.now()) => {
        const s = get();
        const gain = liveAccrual(s, now);
        let walletVlr = s.walletVlr;
        let totalWithdrawn = s.totalWithdrawn;
        let sellLockUntil = s.sellLockUntil;
        let paid = false;
        const withdrawals = s.withdrawals.map((w) => {
          if (w.status === "pending" && w.completesAt <= now && !s.banned) {
            walletVlr += w.net;
            totalWithdrawn += w.net;
            sellLockUntil = now + SELL_LOCK_MS;
            paid = true;
            return { ...w, status: "completed" as const, completedAt: now };
          }
          return w;
        });
        const moved =
          gain > 0 ||
          paid ||
          walletVlr !== s.walletVlr ||
          withdrawals.some((w, i) => w !== s.withdrawals[i]);
        if (!moved && s.lastTick) {
          if (s.lastTick !== now) set({ lastTick: now });
          return;
        }
        set({
          unclaimed: s.unclaimed + gain,
          lastTick: now,
          walletVlr,
          totalWithdrawn,
          sellLockUntil,
          withdrawals,
          soldToday: sellLockUntil > now ? s.soldToday : 0,
        });
        if (paid) say(get, set, "toastPaid");
      },
      setLang: (lang) => set({ lang }),
      connect: (verifiedAddress) => {
        const s = get();
        if (s.banned) { say(get, set, "toastBanned"); return; }
        if (!verifiedAddress || verifiedAddress.length > 100) return;
        set({ walletConnected: true, address: verifiedAddress });
        say(get, set, "toastConnected");
      },
      disconnect: () => {
        const s = get();
        if (s.withdrawals.some((w) => w.status === "pending")) {
          say(get, set, "toastDisconnectBlock");
          return;
        }
        get().settle();
        set({ walletConnected: false, address: "" });
        say(get, set, "toastOff");
      },
      activate: () => {
        const s = get();
        if (s.banned) return;
        if (!s.walletConnected || s.activated) return;
        if (s.gram + 1e-9 < ACTIVATION_GRAM) {
          say(get, set, "toastNeedGram");
          return;
        }
        get().settle();
        set({ gram: get().gram - ACTIVATION_GRAM, activated: true, lastTick: Date.now() });
        say(get, set, "toastOn");
      },
      collect: () => {
        const s = get();
        if (s.banned || !canMine(s)) return;
        get().settle();
        const unclaimed = get().unclaimed;
        if (unclaimed < 0.0001) {
          say(get, set, "nothing");
          return;
        }
        set({ appBalance: get().appBalance + unclaimed, unclaimed: 0 });
        say(get, set, "toastCollect", { n: unclaimed.toLocaleString("en-US", { maximumFractionDigits: 2 }) });
      },
      buy: (gramIn) => {
        const now = Date.now();
        get().settle(now);
        const s = get();
        if (s.banned) {
          say(get, set, "toastBanned");
          return;
        }
        if (!(gramIn > 0) || s.gram + 1e-9 < gramIn) {
          say(get, set, "insufficient");
          return;
        }
        const vlr = gramIn * VLR_PER_GRAM * (1 - SWAP_FEE);
        set({ gram: s.gram - gramIn, walletVlr: s.walletVlr + vlr, everBought: true });
        say(get, set, "toastBuy", { n: vlr.toLocaleString("en-US", { maximumFractionDigits: 0 }) });
      },
      sell: (amount) => {
        const now = Date.now();
        get().settle(now);
        const s = get();
        if (s.banned) {
          say(get, set, "toastBanned");
          return;
        }
        const verdict = sellVerdict(s, amount, now);
        if (verdict === "insufficient" || verdict === "zero") {
          say(get, set, "insufficient");
          return;
        }
        if (verdict === "pending-ban") {
          set({
            banned: { reason: "pending-sell", at: now },
            withdrawals: s.withdrawals.map((w) =>
              w.status === "pending" ? { ...w, status: "forfeited" as const } : w,
            ),
          });
          say(get, set, "reasonPending");
          return;
        }
        if (verdict === "cap-ban") {
          set({ banned: { reason: "dump", at: now } });
          say(get, set, "reasonDump");
          return;
        }
        const key = dayKey(now);
        const locked = s.sellLockUntil > now;
        const already = locked && s.sellDayKey === key ? s.soldToday : 0;
        const gramIn = (amount / VLR_PER_GRAM) * (1 - SWAP_FEE);
        set({
          walletVlr: s.walletVlr - amount,
          gram: s.gram + gramIn,
          soldToday: locked ? already + amount : s.soldToday,
          sellDayKey: key,
        });
        say(get, set, "toastSell", { n: amount.toLocaleString("en-US", { maximumFractionDigits: 0 }) });
      },
      openStake: (amount, planId) => {
        const now = Date.now();
        get().settle(now);
        const s = get();
        if (s.banned) return;
        const plan = PLANS.find((item) => item.id === planId);
        if (!plan) return;
        if (s.stake) {
          say(get, set, "alreadyStake");
          return;
        }
        if (amount + 1e-9 < plan.min) {
          say(get, set, "minStake", { n: plan.min.toLocaleString("en-US") });
          return;
        }
        if (s.appBalance + 1e-9 < amount) {
          say(get, set, "insufficient");
          return;
        }
        set({
          appBalance: s.appBalance - amount,
          everStaked: true,
          stake: {
            amount,
            planId,
            profit: plan.profit,
            mult: plan.mult,
            startedAt: now,
            endsAt: now + plan.days * 86_400_000,
          },
        });
        say(get, set, "toastStake");
      },
      claimStake: () => {
        const now = Date.now();
        get().settle(now);
        const s = get();
        if (!s.stake) return;
        if (s.stake.endsAt > now) {
          say(get, set, "toastEarly");
          return;
        }
        const back = s.stake.amount * (1 + s.stake.profit);
        set({ appBalance: get().appBalance + back, stake: null });
        say(get, set, "toastStakeClaim", { n: back.toLocaleString("en-US", { maximumFractionDigits: 0 }) });
      },
      requestWithdraw: (amount) => {
        const now = Date.now();
        get().settle(now);
        const s = get();
        if (s.banned) {
          say(get, set, "toastBanned");
          return;
        }
        if (!s.walletConnected) {
          say(get, set, "connectTitle");
          return;
        }
        if (s.withdrawals.some((w) => w.status === "pending")) {
          say(get, set, "toastPending");
          return;
        }
        if (amount + 1e-9 < 10_000) {
          say(get, set, "minWithdraw");
          return;
        }
        if (s.appBalance + 1e-9 < amount) {
          say(get, set, "insufficient");
          return;
        }
        if (s.walletVlr + 1e-9 < amount * 0.25) {
          say(get, set, "holdNeed", {
            n: (amount * 0.25).toLocaleString("en-US", { maximumFractionDigits: 0 }),
          });
          return;
        }
        const fee = amount * WITHDRAW_FEE;
        const row: Withdrawal = {
          id: uid("W"),
          gross: amount,
          fee,
          net: amount - fee,
          status: "pending",
          createdAt: now,
          completesAt: now + PAYOUT_MS,
        };
        set({
          appBalance: s.appBalance - amount,
          withdrawals: [row, ...s.withdrawals].slice(0, 40),
        });
        say(get, set, "toastWithdraw");
      },
      taskReady: (id) => {
        const s = get();
        if (id === "connect") return s.walletConnected;
        if (id === "activate") return s.activated;
        if (id === "buy") return s.everBought;
        if (id === "hold") return s.walletVlr + 1e-9 >= HOLD_TASK;
        return s.everStaked;
      },
      claimTask: (id) => {
        get().settle();
        const s = get();
        if (s.banned || s.claimedTasks.includes(id) || !get().taskReady(id)) return;
        const reward = TASK_REWARDS[id];
        set({
          claimedTasks: [...s.claimedTasks, id],
          appBalance: get().appBalance + reward,
        });
        say(get, set, "toastTask", { n: reward });
      },
      claimStreak: () => {
        const now = Date.now();
        get().settle(now);
        const s = get();
        if (s.banned) return;
        const today = dayKey(now);
        if (s.lastClaimDay === today) return;
        if (s.streakDay >= 30) return;
        const yesterday = dayKey(now - 86_400_000);
        const next = s.lastClaimDay === yesterday ? s.streakDay + 1 : 1;
        const reward = 10 + next * 4;
        set({
          streakDay: next,
          lastClaimDay: today,
          appBalance: get().appBalance + reward,
        });
        say(get, set, "toastStreak", { n: next, m: reward });
      },
      fastForward: (ms) => {
        const now = Date.now();
        get().settle(now);
        const s = get();
        const rate = canMine(s) ? dailyRate(s, now) / 86_400 : 0;
        const extra = rate * (ms / 1000);
        set({
          unclaimed: s.unclaimed + extra,
          lastTick: now,
          stake: s.stake
            ? { ...s.stake, startedAt: s.stake.startedAt - ms, endsAt: s.stake.endsAt - ms }
            : null,
          withdrawals: s.withdrawals.map((w) =>
            w.status === "pending"
              ? { ...w, createdAt: w.createdAt - ms, completesAt: w.completesAt - ms }
              : w,
          ),
          sellLockUntil: s.sellLockUntil > 0 ? s.sellLockUntil - ms : 0,
        });
        get().settle(Date.now());
        say(get, set, ms >= 7 * 86_400_000 ? "ff7done" : "ff24done");
      },
      reset: () => {
        const lang = get().lang;
        set({ ...fresh(), lang, lastTick: Date.now(), referralCode: genCode() });
      },
      clearUnread: () => set({ unread: 0 }),
      clearToast: () => set({ toast: "" }),
    }),
    {
      name: "velora-miner-v1",
      partialize: (s) => {
        const {
          toast: _toast,
          toastAt: _toastAt,
          boot: _b,
          settle: _s,
          setLang: _l,
          connect: _c,
          disconnect: _d,
          activate: _a,
          collect: _co,
          buy: _bu,
          sell: _se,
          openStake: _o,
          claimStake: _cs,
          requestWithdraw: _r,
          claimTask: _ct,
          claimStreak: _k,
          fastForward: _f,
          reset: _re,
          clearUnread: _cu,
          clearToast: _cl,
          taskReady: _tr,
          ...data
        } = s;
        return data;
      },
    },
  ),
);

export const baseHourly = BASE_DAILY / 24;
