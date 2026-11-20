export const BASE_DAILY = 600;
export const MAX_MULT = 10;
export const MIN_WITHDRAW = 10_000;
export const WITHDRAW_FEE = 0.05;
export const HOLD_RATIO = 0.25;
export const ACTIVATION_GRAM = 0.5;
export const SELL_DAILY_CAP = 2_500;
export const SELL_LOCK_MS = 72 * 60 * 60 * 1000;
export const PAYOUT_MS = 60 * 1000;
export const VLR_PER_GRAM = 8_000;
export const SWAP_FEE = 0.005;
export const START_GRAM = 20;
export const HOLD_TASK = 2_500;

export const TASK_REWARDS = {
  connect: 25,
  activate: 50,
  buy: 100,
  hold: 200,
  stake: 150,
} as const;

export type TaskId = keyof typeof TASK_REWARDS;

export const TIERS = [
  { level: 1, hold: 0, mult: 1, league: "bronze" },
  { level: 2, hold: 500, mult: 1.3, league: "bronze" },
  { level: 3, hold: 1_500, mult: 1.7, league: "bronze" },
  { level: 4, hold: 3_000, mult: 2.1, league: "silver" },
  { level: 5, hold: 6_000, mult: 2.6, league: "silver" },
  { level: 6, hold: 12_000, mult: 3.2, league: "silver" },
  { level: 7, hold: 22_000, mult: 3.9, league: "gold" },
  { level: 8, hold: 40_000, mult: 4.7, league: "gold" },
  { level: 9, hold: 70_000, mult: 5.6, league: "platinum" },
  { level: 10, hold: 110_000, mult: 6.6, league: "platinum" },
  { level: 11, hold: 180_000, mult: 7.7, league: "legendary" },
  { level: 12, hold: 280_000, mult: 8.8, league: "legendary" },
  { level: 13, hold: 450_000, mult: 10, league: "legendary" },
] as const;

export type League = (typeof TIERS)[number]["league"];
export type Tier = (typeof TIERS)[number];

export const PLANS = [
  { id: "30", days: 30, profit: 0.3, mult: 1.5, min: 10_000 },
  { id: "90", days: 90, profit: 1.1, mult: 2.2, min: 10_000 },
  { id: "120", days: 120, profit: 1.5, mult: 3, min: 10_000 },
] as const;

export type PlanId = (typeof PLANS)[number]["id"];

export const LEAGUES: { id: League; from: number; to: number; maxDaily: number }[] = [
  { id: "bronze", from: 1, to: 3, maxDaily: 600 * 1.7 },
  { id: "silver", from: 4, to: 6, maxDaily: 600 * 3.2 },
  { id: "gold", from: 7, to: 8, maxDaily: 600 * 4.7 },
  { id: "platinum", from: 9, to: 10, maxDaily: 600 * 6.6 },
  { id: "legendary", from: 11, to: 13, maxDaily: 600 * 10 },
];

export type MiningSnap = {
  walletVlr: number;
  activated: boolean;
  walletConnected: boolean;
  banned: unknown;
  stake: { mult: number; endsAt: number } | null;
  lastTick: number;
};

export function tierForHold(hold: number): Tier {
  let current: Tier = TIERS[0];
  for (const tier of TIERS) {
    if (hold + 1e-9 >= tier.hold) current = tier;
  }
  return current;
}

export function nextTier(tier: Tier): Tier | null {
  return TIERS.find((item) => item.level === tier.level + 1) ?? null;
}

export function canMine(s: MiningSnap): boolean {
  return Boolean(s.activated && s.walletConnected && !s.banned && s.lastTick);
}

export function effectiveMult(s: MiningSnap, now: number): number {
  const hold = tierForHold(s.walletVlr).mult;
  const stake = s.stake && s.stake.endsAt > now ? s.stake.mult : 1;
  return Math.min(MAX_MULT, hold * stake);
}

export function dailyRate(s: MiningSnap, now: number): number {
  return BASE_DAILY * effectiveMult(s, now);
}

export function liveAccrual(s: MiningSnap, now: number): number {
  if (!canMine(s)) return 0;
  const dt = Math.max(0, Math.min(now - s.lastTick, 14 * 86_400_000));
  return (dailyRate(s, now) / 86_400) * (dt / 1000);
}

export function holdRequired(amount: number): number {
  return amount * HOLD_RATIO;
}

export function dayKey(ts: number): string {
  return new Date(ts).toISOString().slice(0, 10);
}

export function fmt(n: number, digits = 2): string {
  if (!Number.isFinite(n)) return "0";
  return n.toLocaleString("en-US", {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  });
}

export function fmtTrim(n: number, digits = 2): string {
  if (!Number.isFinite(n)) return "0";
  return n.toLocaleString("en-US", {
    minimumFractionDigits: 0,
    maximumFractionDigits: digits,
  });
}

export function fmtDuration(ms: number): string {
  const safe = Math.max(0, ms);
  const total = Math.floor(safe / 1000);
  const d = Math.floor(total / 86_400);
  const h = Math.floor((total % 86_400) / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (d > 0) return `${d}d ${h}h`;
  const pad = (v: number) => String(v).padStart(2, "0");
  return `${pad(h)}:${pad(m)}:${pad(s)}`;
}

export function shortAddress(addr: string): string {
  if (addr.length < 14) return addr;
  return `${addr.slice(0, 6)}…${addr.slice(-4)}`;
}

export function progressToNext(hold: number): { pct: number; next: Tier | null; current: Tier } {
  const current = tierForHold(hold);
  const next = nextTier(current);
  if (!next) return { pct: 100, next: null, current };
  const span = next.hold - current.hold;
  const pct = span <= 0 ? 100 : Math.max(0, Math.min(100, ((hold - current.hold) / span) * 100));
  return { pct, next, current };
}

export type SellVerdict = "ok" | "pending-ban" | "cap-ban" | "insufficient" | "zero";

export function sellVerdict(
  input: {
    walletVlr: number;
    withdrawals: { status: string }[];
    sellLockUntil: number;
    sellDayKey: string;
    soldToday: number;
  },
  amount: number,
  now: number,
): SellVerdict {
  if (!(amount > 0)) return "zero";
  if (amount > input.walletVlr + 1e-6) return "insufficient";
  if (input.withdrawals.some((w) => w.status === "pending")) return "pending-ban";
  if (input.sellLockUntil > now) {
    const sold = input.sellDayKey === dayKey(now) ? input.soldToday : 0;
    if (sold + amount > SELL_DAILY_CAP + 1e-6) return "cap-ban";
  }
  return "ok";
}
