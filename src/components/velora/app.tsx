import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useState,
  type InputHTMLAttributes,
  type ReactNode,
} from "react";
import {
  AlertTriangle,
  ArrowDownUp,
  ArrowLeftRight,
  Bell,
  BookOpen,
  CalendarDays,
  Check,
  ChevronRight,
  Copy,
  Crown,
  FastForward,
  Flame,
  Gem,
  Info,
  Lock,
  Medal,
  Pickaxe,
  Rocket,
  Send,
  Shield,
  Star,
  Timer,
  Trophy,
  Unlink,
  Users,
  Wallet,
  X,
  Zap,
} from "lucide-react";
import {
  Area,
  AreaChart,
  ResponsiveContainer,
} from "recharts";
import {
  ACTIVATION_GRAM,
  BASE_DAILY,
  HOLD_TASK,
  LEAGUES,
  MIN_WITHDRAW,
  PLANS,
  SELL_DAILY_CAP,
  SWAP_FEE,
  TASK_REWARDS,
  TIERS,
  VLR_PER_GRAM,
  WITHDRAW_FEE,
  canMine,
  dailyRate,
  dayKey,
  effectiveMult,
  fmt,
  fmtDuration,
  fmtTrim,
  holdRequired,
  liveAccrual,
  progressToNext,
  sellVerdict,
  shortAddress,
  tierForHold,
  type League,
  type PlanId,
  type TaskId,
} from "@/lib/velora/economy";
import { fill, t, type Key, type Lang } from "@/lib/velora/i18n";
import { useVelora } from "@/lib/velora/store";
import markUrl from "@/assets/velora-mark.png";
import { useSession } from "@/lib/velora/session";
import { signInWithTelegram } from "@/lib/velora/login-client";

type Screen = "home" | "swap" | "friends" | "wallet" | "stake" | "tasks" | "rules";
type Sheet = null | "menu" | "leagues" | "connect" | "activate" | "bell" | "sell" | "reset";

type Nav = {
  screen: Screen;
  setScreen: (screen: Screen) => void;
  sheet: Sheet;
  open: (sheet: Exclude<Sheet, null>) => void;
  close: () => void;
  now: number;
  sellAmount: number;
  askSell: (amount: number) => void;
};

const NavCtx = createContext<Nav | null>(null);

function useNav(): Nav {
  const value = useContext(NavCtx);
  if (!value) throw new Error("missing nav");
  return value;
}

function cn(...parts: Array<string | false | null | undefined>): string {
  return parts.filter(Boolean).join(" ");
}

function useT() {
  const lang = useVelora((s) => s.lang);
  return useMemo(
    () => ({
      lang,
      tr: (key: Key) => t(lang, key),
      tf: (key: Key, vars: Record<string, string | number>) => fill(t(lang, key), vars),
    }),
    [lang],
  );
}

const SERIES = Array.from({ length: 28 }, (_, i) => ({
  i,
  p: VLR_PER_GRAM * (1 + Math.sin(i / 2.4) * 0.04 + i * 0.0015),
}));

const PLAN_KEY: Record<PlanId, Key> = {
  "30": "planLabel30",
  "90": "planLabel90",
  "120": "planLabel120",
};

const TASKS: { id: TaskId; key: Key }[] = [
  { id: "connect", key: "taskConnect" },
  { id: "activate", key: "taskActivate" },
  { id: "buy", key: "taskBuy" },
  { id: "hold", key: "taskHold" },
  { id: "stake", key: "taskStake" },
];

function Mark({ className }: { className?: string }) {
  return (
    <img
      src={markUrl}
      alt=""
      draggable={false}
      className={cn("object-contain drop-shadow-[0_8px_16px_rgba(240,193,75,0.35)]", className)}
    />
  );
}

function Coin() {
  return <Mark className="size-[4.75rem] shrink-0" />;
}

function Field(props: InputHTMLAttributes<HTMLInputElement>) {
  return (
    <input
      inputMode="decimal"
      {...props}
      className={cn(
        "h-12 w-full rounded-2xl border border-line bg-card-2 px-3 text-lg font-bold tabular-nums outline-none focus:border-gold",
        props.className,
      )}
    />
  );
}

function GoldButton({
  children,
  onClick,
  disabled,
  type = "button",
}: {
  children: ReactNode;
  onClick?: () => void;
  disabled?: boolean;
  type?: "button" | "submit";
}) {
  return (
    <button
      type={type}
      onClick={onClick}
      disabled={disabled}
      className="btn-gold glow-gold flex min-h-12 w-full items-center justify-center gap-2 rounded-full bg-gold px-4 text-base font-extrabold text-bg disabled:opacity-40"
    >
      {children}
    </button>
  );
}

function Sheet({
  title,
  onClose,
  children,
}: {
  title: string;
  onClose: () => void;
  children: ReactNode;
}) {
  const { tr } = useT();
  return (
    <div className="absolute inset-0 z-30 flex flex-col justify-end">
      <button type="button" aria-label={tr("close")} className="absolute inset-0 bg-bg/70" onClick={onClose} />
      <div className="scroll-app relative max-h-[86%] overflow-y-auto rounded-t-3xl border border-line bg-phone px-4 pt-3 pb-6">
        <div className="mx-auto mb-3 h-1 w-10 rounded-full bg-line" />
        <div className="mb-3 flex items-center justify-between gap-3">
          <h2 className="font-display text-lg font-bold">{title}</h2>
          <button
            type="button"
            onClick={onClose}
            className="grid size-10 place-items-center rounded-full bg-card-2 text-fg"
          >
            <X size={18} />
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}

function Chevron() {
  return <ChevronRight size={16} className="shrink-0 text-dim rtl:rotate-180" />;
}

export function VeloraApp() {
  const lang = useVelora((s) => s.lang);
  const toast = useVelora((s) => s.toast);
  const toastAt = useVelora((s) => s.toastAt);
  const banned = useVelora((s) => s.banned);
  const [screen, setScreen] = useState<Screen>("home");
  const [sheet, setSheet] = useState<Sheet>(null);
  const [sellAmount, setSellAmount] = useState(0);
  const [now, setNow] = useState(0);
  const [hideBan, setHideBan] = useState(false);

  useEffect(() => {
    const boot = () => useVelora.getState().boot();
    if (useVelora.persist.hasHydrated()) boot();
    return useVelora.persist.onFinishHydration(boot);
  }, []);

  // Real login only inside Telegram; in a plain browser the app stays in demo mode.
  useEffect(() => {
    if (!window.Telegram?.WebApp?.initData) {
      useSession.setState({ status: "offline" });
      return;
    }
    useSession.setState({ status: "loading" });
    signInWithTelegram()
      .then((r) =>
        useSession.setState(
          r.ok ? { status: "authed", profile: r.profile, isAdmin: r.isAdmin } : { status: "error", error: r.error },
        ),
      )
      .catch(() => useSession.setState({ status: "error", error: "network" }));
  }, []);

  useEffect(() => {
    const tick = () => setNow(Date.now());
    tick();
    const id = setInterval(tick, 250);
    return () => clearInterval(id);
  }, []);

  useEffect(() => {
    const due = useVelora
      .getState()
      .withdrawals.some((w) => w.status === "pending" && w.completesAt <= Date.now());
    if (due) useVelora.getState().settle();
  }, [now]);

  useEffect(() => {
    if (!toastAt) return;
    const id = setTimeout(() => useVelora.getState().clearToast(), 2600);
    return () => clearTimeout(id);
  }, [toastAt]);

  useEffect(() => {
    document.documentElement.lang = lang;
    document.documentElement.dir = lang === "fa" || lang === "ar" ? "rtl" : "ltr";
  }, [lang]);

  useEffect(() => {
    setHideBan(false);
  }, [banned?.at]);

  const nav = useMemo<Nav>(
    () => ({
      screen,
      setScreen: (next) => {
        setScreen(next);
        setSheet(null);
      },
      sheet,
      open: (next) => setSheet(next),
      close: () => setSheet(null),
      now,
      sellAmount,
      askSell: (amount) => {
        setSellAmount(amount);
        setSheet("sell");
      },
    }),
    [screen, sheet, now, sellAmount],
  );

  return (
    <NavCtx.Provider value={nav}>
      <div dir={lang === "fa" || lang === "ar" ? "rtl" : "ltr"} className={cn("h-dvh overflow-hidden bg-bg text-fg", (lang === "fa" || lang === "ar") && "font-fa")}>
        <div className="mx-auto grid h-full w-full max-w-5xl md:grid-cols-[minmax(0,1fr)_430px]">
          <Aside />
          <div className="relative mx-auto flex h-full min-h-0 w-full max-w-[430px] flex-col overflow-hidden bg-phone md:border-x md:border-line">
            <Header />
            {banned && (
              <button
                type="button"
                onClick={() => setHideBan(false)}
                className="mx-4 mt-2 rounded-2xl border border-danger/40 bg-danger/10 px-3 py-2 text-start text-sm font-semibold text-danger"
              >
                {t(lang, "bannedBanner")}
              </button>
            )}
            <main className="scroll-app min-h-0 flex-1 overflow-y-auto px-4 pt-3 pb-6">
              {screen === "home" && <Home />}
              {screen === "swap" && <Swap />}
              {screen === "friends" && <Friends />}
              {screen === "wallet" && <WalletScreen />}
              {screen === "stake" && <StakeScreen />}
              {screen === "tasks" && <TasksScreen />}
              {screen === "rules" && <RulesScreen />}
            </main>
            <TabBar />
            {toast && (
              <div className="pointer-events-none absolute inset-x-4 bottom-24 z-40 rounded-2xl border border-line bg-card px-4 py-3 text-sm font-semibold shadow-lg">
                {toast}
              </div>
            )}
            <Sheets />
            {banned && !hideBan && <BanOverlay onHide={() => setHideBan(true)} />}
          </div>
        </div>
      </div>
    </NavCtx.Provider>
  );
}

function Aside() {
  const { tr } = useT();
  const items = [tr("aside1"), tr("aside2"), tr("aside3"), tr("aside4")];
  return (
    <aside className="hidden min-h-0 flex-col justify-between overflow-y-auto px-10 py-12 md:flex">
      <div>
        <Mark className="size-24" />
        <h1 className="mt-6 font-display text-5xl font-extrabold tracking-tight">VELORA</h1>
        <p className="mt-2 text-lg font-semibold text-gold">{tr("tagline")}</p>
        <p className="mt-6 max-w-md text-lg leading-relaxed text-muted">{tr("asideBody")}</p>
      </div>
      <ul className="mt-10 space-y-3">
        {items.map((item) => (
          <li key={item} className="flex items-center gap-3 text-sm font-semibold">
            <span className="size-1.5 rounded-full bg-gold" />
            {item}
          </li>
        ))}
      </ul>
    </aside>
  );
}

function Header() {
  const { tr } = useT();
  const { open } = useNav();
  const lang = useVelora((s) => s.lang);
  const unread = useVelora((s) => s.unread);
  const setLang = useVelora((s) => s.setLang);
  return (
    <header className="safe-top flex items-center gap-2 px-4 pb-2">
      <Mark className="size-14 shrink-0" />
      <div className="min-w-0 flex-1">
        <p className="font-display text-xl leading-none font-extrabold tracking-wide">VELORA</p>
        <p className="mt-1 text-xs font-semibold text-muted">{tr("tagline")}</p>
      </div>
      <select
        value={lang}
        onChange={(event) => setLang(event.target.value as Lang)}
        aria-label={tr("language")}
        className="h-10 max-w-[76px] rounded-full border border-line bg-card px-2 text-xs font-extrabold tracking-wide text-fg outline-none"
      >
        <option value="en">EN</option>
        <option value="fa">FA</option>
        <option value="ru">RU</option>
        <option value="ar">AR</option>
      </select>
      <button
        type="button"
        aria-label={tr("bell")}
        onClick={() => {
          useVelora.getState().clearUnread();
          open("bell");
        }}
        className="relative grid size-10 place-items-center rounded-full border border-line bg-card"
      >
        <Bell size={18} />
        {unread > 0 && <span className="absolute top-2 end-2 size-2 rounded-full bg-danger" />}
      </button>
    </header>
  );
}

function TabBar() {
  const { tr } = useT();
  const { screen, setScreen, sheet, open, close } = useNav();
  const items: { id: Screen | "menu"; key: Key; icon: ReactNode }[] = [
    { id: "home", key: "mining", icon: <Pickaxe size={18} /> },
    { id: "swap", key: "swap", icon: <ArrowLeftRight size={18} /> },
    { id: "menu", key: "menu", icon: null },
    { id: "friends", key: "friends", icon: <Users size={18} /> },
    { id: "wallet", key: "wallet", icon: <Wallet size={18} /> },
  ];
  return (
    <nav className="safe-bottom relative z-20 border-t border-line bg-phone">
      <div className="grid grid-cols-5 items-end px-1 pt-1">
      {items.map((item) => {
        if (item.id === "menu") {
          const on = sheet === "menu";
          return (
            <button key="menu" type="button" onClick={() => (on ? close() : open("menu"))} className="flex flex-col items-center pb-1">
              <span className="relative -top-3 grid size-14 place-items-center">
                {on ? (
                  <span className="grid size-11 place-items-center rounded-full bg-card-2 text-gold">
                    <X size={20} />
                  </span>
                ) : (
                  <Mark className="size-14" />
                )}
              </span>
              <span className={cn("-mt-2 text-xs leading-none font-bold", on ? "text-gold" : "text-muted")}>{tr("menu")}</span>
            </button>
          );
        }
        const on = screen === item.id && sheet !== "menu";
        return (
          <button
            key={item.id}
            type="button"
            onClick={() => setScreen(item.id as Screen)}
            className={cn("flex min-h-12 flex-col items-center justify-end gap-1 pb-1 text-xs font-bold", on ? "text-gold" : "text-muted")}
          >
            {item.icon}
            <span className="leading-none">{tr(item.key)}</span>
            <span className={cn("size-1 rounded-full", on ? "bg-gold" : "bg-transparent")} />
          </button>
        );
      })}
      </div>
    </nav>
  );
}

function Home() {
  const { tr, tf } = useT();
  const { now, open, setScreen } = useNav();
  const s = useVelora();
  const accrued = s.unclaimed + liveAccrual(s, now);
  const mining = canMine(s);
  const daily = mining || s.activated ? dailyRate(s, now) : BASE_DAILY;
  const mult = mining || s.activated ? effectiveMult(s, now) : 1;
  const { pct, next, current } = progressToNext(s.walletVlr);
  const league = current.league;

  return (
    <div className="flex flex-col gap-3">
      <section className="relative overflow-hidden rounded-3xl border border-line bg-card p-4">
        <svg viewBox="0 0 120 48" className="pointer-events-none absolute end-3 top-14 h-12 w-28 opacity-80" aria-hidden>
          <path
            d="M2 40 C 20 38, 28 34, 40 28 S 68 30, 82 18 104 12 118 4"
            fill="none"
            stroke="var(--color-gold)"
            strokeWidth="2.4"
            strokeLinecap="round"
          />
        </svg>
        <div className="flex items-start gap-3">
          <Coin />
          <div className="min-w-0 flex-1 pe-6">
            <div className="flex items-center justify-between gap-2">
              <p className="text-sm text-muted">{tr("total")}</p>
              <button
                type="button"
                onClick={() => open("leagues")}
                className="flex items-center gap-1 rounded-full border border-gold/40 bg-gold/10 px-2.5 py-1 text-xs font-extrabold text-gold"
              >
                <Star size={12} />
                Lv.{current.level}
              </button>
            </div>
            <p className="mt-1 text-3xl leading-none font-extrabold tracking-tight tabular-nums">
              {fmt(s.appBalance, 2)} <span className="text-lg text-gold">VLR</span>
            </p>
            <p className="mt-2 text-sm font-bold text-mint">{tf("pace", { n: fmtTrim(daily, 1) })}</p>
          </div>
        </div>
        <div className="mt-4 flex items-center justify-between gap-3 text-sm">
          <span className="inline-flex items-center gap-2 text-muted">
            <span className={cn("size-2 rounded-full", mining ? "bg-mint pulse-dot" : "bg-dim")} />
            {tr("miningNow")} · {mining ? tr("running") : tr("paused")}
          </span>
          <span className="font-extrabold tabular-nums text-mint">+{fmt(accrued, 4)}</span>
        </div>
        <div className="mt-3">
          <GoldButton
            onClick={() => {
              if (s.banned) return;
              if (!s.walletConnected) open("connect");
              else if (!s.activated) open("activate");
              else s.collect();
            }}
            disabled={Boolean(s.banned)}
          >
            <Pickaxe size={18} />
            {s.activated ? `${tr("collect")} · ${fmt(accrued, 2)}` : tr("start")}
          </GoldButton>
        </div>
      </section>

      <div className="grid grid-cols-3 gap-2">
        <Stat icon={<Zap size={16} />} label={tr("hourly")} value={fmtTrim(daily / 24, 1)} unit="VLR" />
        <Stat icon={<CalendarDays size={16} />} label={tr("daily")} value={fmtTrim(daily, 1)} unit="VLR" />
        <Stat icon={<Rocket size={16} />} label={tr("boost")} value={`×${fmtTrim(mult, 2)}`} accent />
      </div>

      <button
        type="button"
        onClick={() => setScreen("stake")}
        className="flex items-center gap-3 rounded-3xl border border-teal-line bg-teal p-3 text-start"
      >
        <span className="grid size-11 shrink-0 place-items-center rounded-2xl bg-mint/15 text-mint">
          <Rocket size={18} />
        </span>
        <span className="min-w-0 flex-1">
          <span className="block font-extrabold">{tr("stakeBanner")}</span>
          <span className="mt-0.5 block text-xs leading-snug text-mint">{tr("stakeBody")}</span>
        </span>
        <span className="shrink-0 rounded-full border border-gold px-3 py-2 text-xs font-extrabold text-gold">
          {tr("stakeNow")}
        </span>
      </button>

      <button
        type="button"
        onClick={() => open("leagues")}
        className="rounded-3xl border border-line bg-card p-4 text-start"
      >
        <span className="flex items-center gap-3">
          <span className="grid size-11 shrink-0 place-items-center rounded-2xl bg-gold/10 text-gold">
            <LeagueIcon league={league} />
          </span>
          <span className="min-w-0 flex-1">
            <span className="flex items-center gap-2">
              <span className="font-extrabold">{tr(league)}</span>
              <span className="rounded-full bg-card-2 px-2 py-0.5 text-xs font-bold text-gold">Lv.{current.level}</span>
            </span>
            <span className="mt-1 block text-xs text-muted">
              {next
                ? `${tf("toLevel", { n: next.level })} · ${tf("holdLeft", { n: fmtTrim(Math.max(0, next.hold - s.walletVlr), 0) })}`
                : tr("maxed")}
            </span>
          </span>
          <span className="font-extrabold text-gold tabular-nums">{Math.round(pct)}%</span>
        </span>
        <span className="mt-3 block h-2 overflow-hidden rounded-full bg-card-2">
          <span className="block h-full rounded-full bg-gold" style={{ width: `${pct}%` }} />
        </span>
      </button>

      <div className="grid grid-cols-2 gap-2">
        <Jump tone="ice" icon={<Check size={18} />} title={tr("tasks")} body={tr("tasksHint")} onClick={() => setScreen("tasks")} />
        <Jump tone="violet" icon={<Users size={18} />} title={tr("friends")} body={tr("friendsHint")} onClick={() => setScreen("friends")} />
        <Jump tone="mint" icon={<Shield size={18} />} title={tr("staking")} body={tr("stakingHint")} onClick={() => setScreen("stake")} />
        <Jump tone="gold" icon={<Wallet size={18} />} title={tr("wallet")} body={tr("walletHint")} onClick={() => setScreen("wallet")} />
      </div>
    </div>
  );
}

function Stat({
  icon,
  label,
  value,
  unit,
  accent,
}: {
  icon: ReactNode;
  label: string;
  value: string;
  unit?: string;
  accent?: boolean;
}) {
  return (
    <div className="rounded-3xl border border-line bg-card px-3 py-3">
      <p className="flex items-center gap-1 text-xs font-semibold text-muted">
        <span className="text-gold">{icon}</span>
        {label}
      </p>
      <p className={cn("mt-2 text-lg leading-none font-extrabold whitespace-nowrap tabular-nums", accent && "text-gold")}>
        {value}
        {unit && <span className="ms-1 text-xs font-bold text-dim">{unit}</span>}
      </p>
    </div>
  );
}

function Jump({
  icon,
  title,
  body,
  onClick,
  tone,
}: {
  icon: ReactNode;
  title: string;
  body: string;
  onClick: () => void;
  tone: "ice" | "violet" | "mint" | "gold";
}) {
  const toneClass = {
    ice: "border-ice/25 bg-ice/10 text-ice",
    violet: "border-violet/25 bg-violet/10 text-violet",
    mint: "border-mint/25 bg-mint/10 text-mint",
    gold: "border-gold/25 bg-gold/10 text-gold",
  }[tone];
  return (
    <button type="button" onClick={onClick} className={cn("rounded-3xl border p-3 text-start", toneClass)}>
      <span className="flex items-center justify-between">
        <span className="grid size-10 place-items-center rounded-2xl bg-phone/70 text-current">{icon}</span>
        <Chevron />
      </span>
      <span className="mt-3 block font-extrabold text-fg">{title}</span>
      <span className="mt-1 block text-xs leading-snug text-muted">{body}</span>
    </button>
  );
}

function LeagueIcon({ league }: { league: League }) {
  if (league === "legendary") return <Crown size={20} />;
  if (league === "platinum") return <Gem size={20} />;
  if (league === "gold") return <Medal size={20} />;
  if (league === "silver") return <Shield size={20} />;
  return <Shield size={20} />;
}

function Swap() {
  const { tr, tf } = useT();
  const { now, askSell, setScreen } = useNav();
  const s = useVelora();
  const [side, setSide] = useState<"buy" | "sell">("buy");
  const [raw, setRaw] = useState("1");
  const amount = Number(raw);
  const valid = Number.isFinite(amount) && amount > 0;
  const vlrOut = valid ? amount * VLR_PER_GRAM * (1 - SWAP_FEE) : 0;
  const gramOut = valid ? (amount / VLR_PER_GRAM) * (1 - SWAP_FEE) : 0;
  const verdict = side === "sell" && valid ? sellVerdict(s, amount, now) : "ok";
  const sold = s.sellDayKey === dayKey(now) ? s.soldToday : 0;
  const left = Math.max(0, SELL_DAILY_CAP - sold);
  const lockOn = s.sellLockUntil > now;

  function submit() {
    if (!valid || s.banned) return;
    if (side === "buy") {
      s.buy(amount);
      return;
    }
    if (verdict === "pending-ban" || verdict === "cap-ban") {
      askSell(amount);
      return;
    }
    s.sell(amount);
  }

  const presets = side === "buy" ? [0.5, 1, 2, 5] : [500, 2500, 5000];

  return (
    <div className="flex flex-col gap-3">
      <div>
        <p className="text-xs font-bold tracking-wide text-gold">{tr("official")}</p>
        <h2 className="font-display text-2xl font-extrabold">{tr("pool")}</h2>
        <p className="mt-1 text-sm leading-relaxed text-muted">{tr("poolHint")}</p>
      </div>
      <section className="rounded-3xl border border-line bg-card p-3">
        <div className="mb-1 flex items-center justify-between text-xs text-muted">
          <span>VLR / GRAM</span>
          <span className="font-bold text-mint">
            {fmtTrim(((SERIES[SERIES.length - 1]?.p ?? VLR_PER_GRAM) / (SERIES[0]?.p ?? VLR_PER_GRAM) - 1) * 100, 1)}%
          </span>
        </div>
        <div className="h-28">
          <ResponsiveContainer width="100%" height="100%">
            <AreaChart data={SERIES}>
              <Area dataKey="p" stroke="var(--color-gold)" fill="var(--color-gold)" fillOpacity={0.16} strokeWidth={2} dot={false} />
            </AreaChart>
          </ResponsiveContainer>
        </div>
        <p className="text-2xl font-extrabold tabular-nums">
          {fmtTrim(VLR_PER_GRAM, 0)} <span className="text-sm text-muted">VLR</span>
        </p>
        <p className="text-xs text-muted">1 GRAM</p>
      </section>

      <section className="rounded-3xl border border-line bg-card p-4">
        <div className="mb-2 flex items-center justify-between text-sm">
          <span className="text-muted">{tr("youPay")}</span>
          <span className="text-xs text-muted">
            {tr("balance")}{" "}
            {side === "buy" ? `${fmtTrim(s.gram, 2)} GRAM` : `${fmtTrim(s.walletVlr, 0)} VLR`}
          </span>
        </div>
        <div className="flex items-center gap-2">
          <Field value={raw} onChange={(e) => setRaw(e.target.value)} />
          <span className="grid h-12 min-w-20 place-items-center rounded-2xl bg-card-2 text-sm font-extrabold">
            {side === "buy" ? "GRAM" : "VLR"}
          </span>
        </div>
        <div className="mt-2 flex gap-2">
          {presets.map((n) => (
            <button
              key={n}
              type="button"
              onClick={() => setRaw(String(n))}
              className="h-9 flex-1 rounded-full border border-line text-xs font-bold"
            >
              {n}
            </button>
          ))}
          <button
            type="button"
            onClick={() => setRaw(String(side === "buy" ? Math.max(0, Math.floor(s.gram * 100) / 100) : Math.floor(s.walletVlr)))}
            className="h-9 flex-1 rounded-full border border-gold/50 text-xs font-bold text-gold"
          >
            {tr("max")}
          </button>
        </div>
      </section>

      <button
        type="button"
        aria-label={tr("swap")}
        onClick={() => {
          setSide(side === "buy" ? "sell" : "buy");
          setRaw(side === "buy" ? "2500" : "1");
        }}
        className="mx-auto grid size-11 place-items-center rounded-full border border-gold/40 bg-card text-gold"
      >
        <ArrowDownUp size={18} />
      </button>

      <section className="rounded-3xl border border-line bg-card p-4">
        <p className="text-sm text-muted">{tr("youReceive")}</p>
        <p className="mt-1 text-3xl font-extrabold tabular-nums text-mint">
          +{side === "buy" ? fmtTrim(vlrOut, 0) : fmtTrim(gramOut, 4)}{" "}
          <span className="text-base text-fg">{side === "buy" ? "VLR" : "GRAM"}</span>
        </p>
        <p className="mt-2 text-xs text-muted">
          {tr("rate")}: 1 GRAM = {fmtTrim(VLR_PER_GRAM, 0)} VLR · {tr("swapFee")}
        </p>
      </section>

      {side === "sell" && lockOn && (
        <p className="rounded-2xl border border-gold/30 bg-gold/10 px-3 py-2 text-xs leading-relaxed text-gold">
          {tr("sellLockBody")} {tf("sellLeft", { n: fmtTrim(left, 0) })}
        </p>
      )}
      {side === "sell" && s.withdrawals.some((w) => w.status === "pending") && (
        <p className="rounded-2xl border border-danger/40 bg-danger/10 px-3 py-2 text-xs leading-relaxed text-danger">
          {tr("pendingTag")}
        </p>
      )}
      {!s.activated && side === "buy" && s.gram - (valid ? amount : 0) < ACTIVATION_GRAM && (
        <p className="text-xs text-gold">{tr("keepActivation")}</p>
      )}

      <GoldButton onClick={submit} disabled={!valid || Boolean(s.banned)}>
        {side === "buy" ? tr("buy") : tr("sell")} {side === "buy" ? "VLR" : "VLR"}
      </GoldButton>
      <button type="button" onClick={() => setScreen("rules")} className="text-center text-xs font-semibold text-muted">
        {tr("rules")}
      </button>
    </div>
  );
}

function StakeScreen() {
  const { tr, tf } = useT();
  const { now } = useNav();
  const s = useVelora();
  const [planId, setPlanId] = useState<PlanId>("30");
  const [raw, setRaw] = useState("10000");
  const plan = PLANS.find((item) => item.id === planId) ?? PLANS[0];
  const amount = Number(raw);
  const stake = s.stake;
  const mature = stake ? stake.endsAt <= now : false;

  return (
    <div className="flex flex-col gap-3">
      <div>
        <p className="text-xs font-bold tracking-wide text-gold">{tr("official")}</p>
        <h2 className="font-display text-2xl font-extrabold">{tr("staking")}</h2>
        <p className="mt-1 text-sm leading-relaxed text-muted">{tr("stakeNote")}</p>
      </div>
      <section className="rounded-3xl border border-line bg-card p-4">
        <p className="text-sm text-muted">{tr("fromApp")}</p>
        <p className="mt-1 text-3xl font-extrabold tabular-nums">
          {fmtTrim(s.appBalance, 2)} <span className="text-base text-gold">VLR</span>
        </p>
      </section>
      {stake && (
        <section className="rounded-3xl border border-gold/40 bg-card p-4">
          <p className="text-xs font-bold text-gold">{tr("activeStake")}</p>
          <p className="mt-1 text-2xl font-extrabold tabular-nums">{fmtTrim(stake.amount, 0)} VLR</p>
          <p className="mt-1 text-sm text-muted">
            {tr(PLAN_KEY[stake.planId])} · {tf("profit", { n: Math.round(stake.profit * 100) })} · {tf("mineX", { n: fmtTrim(stake.mult, 1) })}
          </p>
          <p className="mt-2 text-sm font-semibold text-mint">
            {tr("estReturn")} · {fmtTrim(stake.amount * (1 + stake.profit), 0)} VLR
          </p>
          <p className="mt-1 text-xs text-muted">
            {mature ? tr("ready") : tf("lockedUntil", { t: fmtDuration(stake.endsAt - now) })}
          </p>
          <div className="mt-3">
            <GoldButton onClick={() => s.claimStake()} disabled={!mature}>
              {tr("claimStake")}
            </GoldButton>
          </div>
        </section>
      )}
      <p className="text-sm font-bold">{tr("stakeDuration")}</p>
      <div className="grid grid-cols-3 gap-2">
        {PLANS.map((item) => (
          <button
            key={item.id}
            type="button"
            onClick={() => setPlanId(item.id)}
            className={cn(
              "rounded-2xl border px-2 py-3 text-center",
              planId === item.id ? "border-gold bg-gold/10" : "border-line bg-card",
            )}
          >
            <span className="block text-xs font-bold">{tr(PLAN_KEY[item.id])}</span>
            <span className="mt-1 block text-sm font-extrabold text-gold">+{Math.round(item.profit * 100)}%</span>
            <span className="mt-1 block text-xs text-muted">×{fmtTrim(item.mult, 1)}</span>
          </button>
        ))}
      </div>
      <p className="text-sm font-bold">{tr("stakeAmount")}</p>
      <Field value={raw} onChange={(e) => setRaw(e.target.value)} />
      <div className="flex gap-2">
        {[10000, 25000, 50000].map((n) => (
          <button key={n} type="button" onClick={() => setRaw(String(n))} className="h-9 flex-1 rounded-full border border-line text-xs font-bold">
            {fmtTrim(n, 0)}
          </button>
        ))}
      </div>
      <p className="text-xs text-muted">{tf("minStake", { n: fmtTrim(plan.min, 0) })}</p>
      <GoldButton
        disabled={Boolean(stake) || !(amount >= plan.min) || amount > s.appBalance || Boolean(s.banned)}
        onClick={() => s.openStake(amount, plan.id)}
      >
        <Lock size={16} />
        {tr("stakeBtn")}
      </GoldButton>
    </div>
  );
}

function TasksScreen() {
  const { tr, tf } = useT();
  const { now } = useNav();
  const s = useVelora();
  const today = dayKey(now);
  const claimedToday = s.lastClaimDay === today;
  const finished = s.streakDay >= 30;
  const nextDay = claimedToday ? s.streakDay : s.lastClaimDay === dayKey(now - 86_400_000) ? s.streakDay + 1 : 1;
  const nextReward = 10 + Math.min(30, nextDay) * 4;

  return (
    <div className="flex flex-col gap-3">
      <section className="rounded-3xl border border-gold/30 bg-card p-4">
        <div className="flex items-center gap-2">
          <Flame size={18} className="text-gold" />
          <h2 className="font-extrabold">{tr("streak")}</h2>
          <span className="ms-auto text-xs font-bold text-gold">{s.streakDay}/30</span>
        </div>
        <p className="mt-1 text-sm text-muted">{tr("streakBody")}</p>
        <div className="mt-3 grid grid-cols-6 gap-1.5">
          {Array.from({ length: 30 }, (_, i) => {
            const day = i + 1;
            const on = day <= s.streakDay;
            return (
              <span
                key={day}
                className={cn(
                  "grid h-8 place-items-center rounded-lg text-xs font-bold",
                  on ? "bg-mint/15 text-mint" : "bg-card-2 text-dim",
                )}
              >
                {day}
              </span>
            );
          })}
        </div>
        <div className="mt-3">
          <GoldButton onClick={() => s.claimStreak()} disabled={claimedToday || finished || Boolean(s.banned)}>
            {finished ? tr("streakDone") : claimedToday ? tr("comeTomorrow") : `${tr("claim")} · +${nextReward}`}
          </GoldButton>
        </div>
      </section>
      {TASKS.map((task) => {
        const ready = s.taskReady(task.id);
        const done = s.claimedTasks.includes(task.id);
        return (
          <section key={task.id} className="rounded-3xl border border-line bg-card p-4">
            <div className="flex items-start justify-between gap-3">
              <div>
                <p className="font-extrabold">{tr(task.key)}</p>
                <p className="mt-1 text-xs text-muted">+{TASK_REWARDS[task.id]} VLR</p>
              </div>
              <span className="rounded-full border border-gold/40 px-2 py-1 text-xs font-bold text-gold">
                +{TASK_REWARDS[task.id]}
              </span>
            </div>
            <div className="mt-3">
              <button
                type="button"
                disabled={!ready || done || Boolean(s.banned)}
                onClick={() => s.claimTask(task.id)}
                className="h-10 rounded-full bg-card-2 px-4 text-sm font-bold disabled:opacity-40"
              >
                {done ? tr("claimed") : ready ? tr("claim") : tr("notReady")}
              </button>
            </div>
          </section>
        );
      })}
      <p className="text-xs text-muted">
        {tf("holdNeed", { n: fmtTrim(HOLD_TASK, 0) })}
      </p>
    </div>
  );
}

function Friends() {
  const { tr, tf } = useT();
  const code = useVelora((s) => s.referralCode);
  const lang = useVelora((s) => s.lang);

  async function onCopy() {
    try {
      await navigator.clipboard.writeText(code);
    } catch {
      /* clipboard may be blocked */
    }
    useVelora.setState({ toast: t(lang, "copied"), toastAt: Date.now() });
  }

  async function onShare() {
    const text = `Velora ${code}`;
    try {
      if (navigator.share) {
        await navigator.share({ title: "Velora", text });
        return;
      }
    } catch {
      /* dismissed */
    }
    await onCopy();
  }

  return (
    <div className="flex flex-col gap-3">
      <div>
        <h2 className="font-display text-2xl font-extrabold">{tr("inviteTitle")}</h2>
        <p className="mt-1 text-sm leading-relaxed text-muted">{tr("inviteBody")}</p>
      </div>
      <section className="rounded-3xl border border-gold/30 bg-gold/10 p-4 text-sm leading-relaxed">
        <p className="flex gap-2">
          <Info size={16} className="mt-0.5 shrink-0 text-gold" />
          {tr("fakeRule")}
        </p>
      </section>
      <div className="grid grid-cols-2 gap-2">
        <button type="button" onClick={onCopy} className="flex h-12 items-center justify-center gap-2 rounded-2xl bg-card font-bold">
          <Copy size={16} />
          {tr("copy")}
        </button>
        <button type="button" onClick={onShare} className="flex h-12 items-center justify-center gap-2 rounded-2xl bg-gold font-extrabold text-bg">
          <Send size={16} />
          {tr("share")}
        </button>
      </div>
      <section className="rounded-3xl border border-line bg-card p-4">
        <p className="text-xs text-muted">{tr("yourCode")}</p>
        <p className="mt-1 text-2xl font-extrabold tracking-wide tabular-nums">{code || "—"}</p>
        <p className="mt-2 text-xs font-bold text-gold">{tr("friendsHint")}</p>
      </section>
      <div className="grid grid-cols-2 gap-2">
        <div className="rounded-3xl border border-line bg-card p-4">
          <p className="text-xs text-muted">{tr("invited")}</p>
          <p className="mt-1 text-2xl font-extrabold">0</p>
          <p className="text-xs text-mint">{tf("activeCount", { n: 0 })}</p>
        </div>
        <div className="rounded-3xl border border-line bg-card p-4">
          <p className="text-xs text-muted">{tr("income")}</p>
          <p className="mt-1 text-2xl font-extrabold text-gold">+0</p>
          <p className="text-xs text-muted">VLR</p>
        </div>
      </div>
      <section className="rounded-3xl border border-dashed border-line p-6 text-center text-sm text-muted">
        {tr("friendEmpty")}
        <span className="mt-2 block text-xs">{tr("previewNote")}</span>
      </section>
    </div>
  );
}

function WalletScreen() {
  const { tr, tf } = useT();
  const { now, open, setScreen } = useNav();
  const s = useVelora();
  const [raw, setRaw] = useState("10000");
  const amount = Number(raw);
  const valid = Number.isFinite(amount) && amount > 0;
  const need = valid ? holdRequired(amount) : 0;
  const net = valid ? amount * (1 - WITHDRAW_FEE) : 0;
  const pending = s.withdrawals.find((w) => w.status === "pending");
  const sold = s.sellDayKey === dayKey(now) ? s.soldToday : 0;
  const lockOn = s.sellLockUntil > now;
  let block = "";
  if (!s.walletConnected) block = tr("connectTitle");
  else if (s.banned) block = tr("toastBanned");
  else if (pending) block = tr("toastPending");
  else if (!valid || amount < MIN_WITHDRAW) block = tr("minWithdraw");
  else if (amount > s.appBalance) block = tr("insufficient");
  else if (s.walletVlr + 1e-9 < need) block = tf("holdShort", { n: fmtTrim(need - s.walletVlr, 0) });

  return (
    <div className="flex flex-col gap-3">
      <section className="rounded-3xl border border-line bg-card p-4">
        <p className="text-sm text-muted">{tr("appBalance")}</p>
        <p className="mt-1 text-4xl font-extrabold tabular-nums">
          {fmt(s.appBalance, 2)} <span className="text-lg text-gold">VLR</span>
        </p>
        <p className="mt-1 text-xs text-dim">{tr("inGame")}</p>
      </section>
      <div className="grid grid-cols-2 gap-2">
        <div className="rounded-3xl border border-line bg-card p-3">
          <p className="text-xs text-muted">{tr("collateral")}</p>
          <p className="mt-1 text-xl font-extrabold tabular-nums text-mint">{fmtTrim(s.walletVlr, 0)}</p>
          <p className="text-xs text-dim">VLR</p>
        </div>
        <div className="rounded-3xl border border-line bg-card p-3">
          <p className="text-xs text-muted">{tr("withdrawn")}</p>
          <p className="mt-1 text-xl font-extrabold tabular-nums">{fmtTrim(s.totalWithdrawn, 0)}</p>
          <p className="text-xs text-dim">VLR</p>
        </div>
      </div>
      <section className="rounded-3xl border border-line bg-card p-4">
        {s.walletConnected ? (
          <>
            <p className="flex items-center gap-2 text-sm font-bold text-mint">
              <span className="size-2 rounded-full bg-mint" />
              {tr("linked")}
            </p>
            <p className="mt-2 text-xs break-all text-muted">{s.address}</p>
            <p className="mt-2 text-sm font-bold">{fmtTrim(s.gram, 2)} GRAM</p>
            <button type="button" onClick={() => s.disconnect()} className="mt-3 inline-flex h-10 items-center gap-2 rounded-full border border-line px-3 text-sm font-bold">
              <Unlink size={14} />
              {tr("disconnect")}
            </button>
          </>
        ) : (
          <GoldButton onClick={() => open("connect")}>{tr("connectBtn")}</GoldButton>
        )}
        <p className="mt-3 text-xs leading-relaxed text-dim">{tr("previewBalances")}</p>
      </section>

      <section className="rounded-3xl border border-line bg-card p-4">
        <h2 className="font-extrabold">{tr("withdraw")}</h2>
        <Field className="mt-3" value={raw} onChange={(e) => setRaw(e.target.value)} />
        <div className="mt-2 flex gap-2">
          {[10000, 25000, 50000].map((n) => (
            <button key={n} type="button" onClick={() => setRaw(String(n))} className="h-9 flex-1 rounded-full border border-line text-xs font-bold">
              {fmtTrim(n, 0)}
            </button>
          ))}
        </div>
        <ul className="mt-3 space-y-1 text-sm">
          <li className="flex justify-between gap-3">
            <span className="text-muted">{tr("net")}</span>
            <span className="font-bold tabular-nums">{fmtTrim(net, 1)} VLR</span>
          </li>
          <li className="flex justify-between gap-3">
            <span className="text-muted">{tr("walletHold")}</span>
            <span className={cn("font-bold tabular-nums", s.walletVlr + 1e-9 < need ? "text-danger" : "text-mint")}>
              {fmtTrim(s.walletVlr, 0)} / {fmtTrim(need, 0)}
            </span>
          </li>
        </ul>
        <p className="mt-2 text-xs text-muted">{tf("feeLine", { n: fmtTrim(net, 1) })}</p>
        {block && <p className="mt-2 text-xs font-semibold text-danger">{block}</p>}
        {s.walletVlr + 1e-9 < need && (
          <button type="button" onClick={() => setScreen("swap")} className="mt-2 text-xs font-bold text-gold">
            {tr("goSwap")}
          </button>
        )}
        <div className="mt-3">
          <GoldButton disabled={Boolean(block)} onClick={() => s.requestWithdraw(amount)}>
            {tr("request")}
          </GoldButton>
        </div>
      </section>

      {pending && (
        <section className="rounded-3xl border border-gold/40 bg-gold/10 p-4">
          <p className="flex items-center gap-2 text-sm font-extrabold text-gold">
            <Timer size={16} />
            {tr("pending")}
          </p>
          <p className="mt-1 text-2xl font-extrabold tabular-nums">{fmtTrim(pending.gross, 0)} VLR</p>
          <p className="text-sm text-muted">{tf("payoutIn", { t: fmtDuration(pending.completesAt - now) })}</p>
          <p className="mt-2 text-xs leading-relaxed">{tr("pendingTag")}</p>
        </section>
      )}

      <section className="rounded-3xl border border-line bg-card p-4">
        <p className="font-extrabold">{tr("sellLock")}</p>
        <p className="mt-1 text-sm leading-relaxed text-muted">{lockOn ? tr("sellLockBody") : tr("noLock")}</p>
        {lockOn && (
          <p className="mt-2 text-sm font-bold text-gold">
            {tf("sellLeft", { n: fmtTrim(Math.max(0, SELL_DAILY_CAP - sold), 0) })} · {fmtDuration(s.sellLockUntil - now)}
          </p>
        )}
      </section>

      <section className="rounded-3xl border border-line bg-card p-4">
        <p className="flex items-center gap-2 font-extrabold">
          <Info size={16} className="text-gold" />
          {tr("terms")}
        </p>
        <ul className="mt-2 space-y-2 text-sm leading-relaxed text-muted">
          <li>{tr("termFee")}</li>
          <li>{tr("termHold")}</li>
          <li>{tr("termSell")}</li>
          <li>{tr("termCap")}</li>
          <li>{tr("reviewNote")}</li>
        </ul>
      </section>

      <section>
        <h2 className="mb-2 font-extrabold">{tr("history")}</h2>
        {s.withdrawals.length === 0 && <p className="text-sm text-muted">{tr("historyEmpty")}</p>}
        <div className="flex flex-col gap-2">
          {s.withdrawals.map((w) => (
            <article key={w.id} className="rounded-3xl border border-line bg-card p-4">
              <div className="flex items-center justify-between gap-2">
                <p className="text-xs text-dim">{w.id.slice(0, 10)}</p>
                <span
                  className={cn(
                    "rounded-full px-2 py-1 text-xs font-bold",
                    w.status === "completed" && "bg-mint/15 text-mint",
                    w.status === "pending" && "bg-gold/15 text-gold",
                    w.status === "forfeited" && "bg-danger/15 text-danger",
                  )}
                >
                  {tr(w.status)}
                </span>
              </div>
              <p className="mt-2 text-xl font-extrabold tabular-nums">{fmtTrim(w.gross, 0)} VLR</p>
              <p className="text-sm text-mint">
                {tr("net")} {fmtTrim(w.net, 1)} VLR
              </p>
              <p className="mt-1 text-xs text-dim">{shortAddress(s.address) || "—"}</p>
            </article>
          ))}
        </div>
      </section>
    </div>
  );
}

function RulesScreen() {
  const { tr } = useT();
  const lines: { icon: ReactNode; text: string }[] = [
    { icon: <Wallet size={16} />, text: tr("r1") },
    { icon: <Pickaxe size={16} />, text: tr("r2") },
    { icon: <Rocket size={16} />, text: tr("r3") },
    { icon: <Lock size={16} />, text: tr("r4") },
    { icon: <Timer size={16} />, text: tr("r5") },
    { icon: <AlertTriangle size={16} />, text: tr("r6") },
    { icon: <BanIcon />, text: tr("r7") },
    { icon: <Users size={16} />, text: tr("r8") },
  ];
  return (
    <div className="flex flex-col gap-3">
      <div>
        <h2 className="font-display text-2xl font-extrabold">{tr("rules")}</h2>
        <p className="mt-1 text-sm text-muted">{tr("rulesLead")}</p>
      </div>
      {lines.map((line) => (
        <section key={line.text} className="flex gap-3 rounded-3xl border border-line bg-card p-4">
          <span className="grid size-10 shrink-0 place-items-center rounded-2xl bg-gold/10 text-gold">{line.icon}</span>
          <p className="text-sm leading-relaxed">{line.text}</p>
        </section>
      ))}
      <p className="text-xs leading-relaxed text-dim">{tr("previewBalances")}</p>
    </div>
  );
}

function BanIcon() {
  return <AlertTriangle size={16} />;
}

function Sheets() {
  const { tr, tf } = useT();
  const { sheet, close, open, setScreen, sellAmount } = useNav();
  const s = useVelora();
  if (sheet === "menu") {
    return (
      <Sheet title={tr("services")} onClose={close}>
        <p className="mb-3 text-sm text-muted">{tr("servicesHint")}</p>
        <div className="grid grid-cols-2 gap-2">
          <MenuTile icon={<Lock size={18} />} title={tr("staking")} body={tr("stakingHint")} onClick={() => setScreen("stake")} />
          <MenuTile icon={<Check size={18} />} title={tr("tasks")} body={tr("tasksHint")} onClick={() => setScreen("tasks")} />
          <MenuTile icon={<Trophy size={18} />} title={tr("leagues")} body={tr("leagueHint")} onClick={() => open("leagues")} />
          <MenuTile icon={<BookOpen size={18} />} title={tr("rules")} body={tr("rulesLead")} onClick={() => setScreen("rules")} />
        </div>
        <p className="mt-4 text-xs font-bold tracking-wide text-dim">{tr("preview")}</p>
        <div className="mt-2 grid gap-2">
          <button type="button" onClick={() => s.fastForward(86_400_000)} className="flex h-11 items-center justify-center gap-2 rounded-2xl border border-line text-sm font-bold">
            <FastForward size={16} />
            {tr("ff24")}
          </button>
          <button type="button" onClick={() => s.fastForward(7 * 86_400_000)} className="flex h-11 items-center justify-center gap-2 rounded-2xl border border-line text-sm font-bold">
            <FastForward size={16} />
            {tr("ff7")}
          </button>
          <button type="button" onClick={() => open("reset")} className="h-11 rounded-2xl border border-danger/40 text-sm font-bold text-danger">
            {tr("reset")}
          </button>
        </div>
      </Sheet>
    );
  }
  if (sheet === "connect") {
    return (
      <Sheet title={tr("connectTitle")} onClose={close}>
        <p className="text-sm leading-relaxed text-muted">{tr("connectBody")}</p>
        <p className="mt-3 text-sm font-bold">{fmtTrim(s.gram, 2)} GRAM</p>
        <div className="mt-4">
          <GoldButton
            onClick={() => {
              s.connect();
              if (!useVelora.getState().activated) open("activate");
              else close();
            }}
          >
            {tr("connectBtn")}
          </GoldButton>
        </div>
      </Sheet>
    );
  }
  if (sheet === "activate") {
    return (
      <Sheet title={tr("depositTitle")} onClose={close}>
        <p className="text-sm leading-relaxed text-muted">{tr("depositBody")}</p>
        <p className="mt-3 text-sm">
          {tr("balance")}: <span className="font-extrabold">{fmtTrim(s.gram, 2)} GRAM</span>
        </p>
        <div className="mt-4">
          <GoldButton
            disabled={s.gram < ACTIVATION_GRAM}
            onClick={() => {
              s.activate();
              if (useVelora.getState().activated) close();
            }}
          >
            {tr("pay")}
          </GoldButton>
        </div>
      </Sheet>
    );
  }
  if (sheet === "leagues") return <LeaguesSheet />;
  if (sheet === "bell") {
    return (
      <Sheet title={tr("bell")} onClose={close}>
        {s.notices.length === 0 && <p className="text-sm text-muted">{tr("bellEmpty")}</p>}
        <div className="flex flex-col gap-2">
          {s.notices.map((n) => (
            <p key={n.id} className="rounded-2xl bg-card px-3 py-3 text-sm">
              {n.text}
            </p>
          ))}
        </div>
      </Sheet>
    );
  }
  if (sheet === "sell") {
    const pending = s.withdrawals.some((w) => w.status === "pending");
    return (
      <Sheet title={tr("wouldBanTitle")} onClose={close}>
        <p className="text-sm leading-relaxed text-danger">{pending ? tr("wouldBanPending") : tr("wouldBanCap")}</p>
        <p className="mt-2 text-sm font-bold tabular-nums">{fmtTrim(sellAmount, 0)} VLR</p>
        <div className="mt-4 grid gap-2">
          <button
            type="button"
            onClick={() => {
              s.sell(sellAmount);
              close();
            }}
            className="h-12 rounded-full bg-danger font-extrabold text-fg"
          >
            {tr("confirmBan")}
          </button>
          <button type="button" onClick={close} className="h-12 rounded-full border border-line font-bold">
            {tr("cancel")}
          </button>
        </div>
      </Sheet>
    );
  }
  if (sheet === "reset") {
    return (
      <Sheet title={tr("reset")} onClose={close}>
        <p className="text-sm leading-relaxed text-muted">{tr("resetAsk")}</p>
        <div className="mt-4 grid gap-2">
          <button
            type="button"
            onClick={() => {
              s.reset();
              setScreen("home");
            }}
            className="h-12 rounded-full bg-danger font-extrabold text-fg"
          >
            {tr("yesReset")}
          </button>
          <button type="button" onClick={close} className="h-12 rounded-full border border-line font-bold">
            {tr("cancel")}
          </button>
        </div>
      </Sheet>
    );
  }
  return null;
}

function MenuTile({
  icon,
  title,
  body,
  onClick,
}: {
  icon: ReactNode;
  title: string;
  body: string;
  onClick: () => void;
}) {
  return (
    <button type="button" onClick={onClick} className="rounded-3xl border border-line bg-card p-3 text-start">
      <span className="grid size-10 place-items-center rounded-2xl bg-gold/10 text-gold">{icon}</span>
      <span className="mt-2 block font-extrabold">{title}</span>
      <span className="mt-1 block text-xs leading-snug text-muted">{body}</span>
    </button>
  );
}

function LeaguesSheet() {
  const { tr, tf } = useT();
  const { close, now } = useNav();
  const s = useVelora();
  const [tab, setTab] = useState<"leagues" | "levels">("levels");
  const current = tierForHold(s.walletVlr);
  const daily = s.activated ? dailyRate(s, now) : BASE_DAILY;
  return (
    <Sheet title={tr("leaguesTitle")} onClose={close}>
      <div className="mb-3 grid grid-cols-2 gap-2 rounded-full bg-card p-1">
        <button
          type="button"
          onClick={() => setTab("leagues")}
          className={cn("h-10 rounded-full text-sm font-bold", tab === "leagues" && "bg-gold text-bg")}
        >
          {tr("leagueTab")}
        </button>
        <button
          type="button"
          onClick={() => setTab("levels")}
          className={cn("h-10 rounded-full text-sm font-bold", tab === "levels" && "bg-gold text-bg")}
        >
          {tr("allLevels")}
        </button>
      </div>
      {tab === "leagues" ? (
        <div className="flex flex-col gap-2">
          {LEAGUES.map((league) => {
            const first = TIERS.find((tier) => tier.level === league.from);
            return (
              <div
                key={league.id}
                className={cn(
                  "flex items-center gap-3 rounded-2xl border px-3 py-3",
                  current.league === league.id ? "border-gold bg-gold/10" : "border-line bg-card",
                )}
              >
                <span className="grid size-10 place-items-center rounded-xl bg-card-2 text-gold">
                  <LeagueIcon league={league.id} />
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block font-extrabold">
                    {tr(league.id)}
                    {current.league === league.id && (
                      <span className="ms-2 text-xs text-gold">{tr("you")}</span>
                    )}
                  </span>
                  <span className="block text-xs text-muted">{tf("leagueRange", { a: league.from, b: league.to })}</span>
                </span>
                <span className="text-end">
                  <span className="block text-sm font-extrabold text-gold">{tf("upTo", { n: fmtTrim(league.maxDaily, 0) })}</span>
                  <span className="block text-xs text-muted">{tf("fromHold", { n: fmtTrim(first?.hold ?? 0, 0) })}</span>
                </span>
              </div>
            );
          })}
          <p className="text-xs leading-relaxed text-muted">{tr("capNote")}</p>
        </div>
      ) : (
        <div className="flex flex-col gap-2">
          {TIERS.map((tier) => (
            <div
              key={tier.level}
              className={cn(
                "flex items-center justify-between gap-3 rounded-2xl border px-3 py-3",
                tier.level === current.level ? "border-gold bg-gold/10" : "border-line bg-card",
              )}
            >
              <span>
                <span className="block font-extrabold">
                  Lv {tier.level}
                  {tier.level === current.level && <span className="ms-2 text-xs text-gold">{tr("you")}</span>}
                </span>
                <span className="block text-xs text-muted">
                  {fmtTrim((BASE_DAILY * tier.mult) / 24, 1)} / h · ×{fmtTrim(tier.mult, 1)}
                </span>
              </span>
              <span className="text-end">
                <span className="block font-extrabold tabular-nums text-gold">{fmtTrim(tier.hold, 0)} VLR</span>
                <span className="block text-xs text-mint">+{fmtTrim(BASE_DAILY * tier.mult, 0)} {tr("perDay")}</span>
              </span>
            </div>
          ))}
        </div>
      )}
      <div className="mt-3 rounded-2xl bg-card p-3 text-sm">
        <p className="font-bold">{tr("yourStatus")}</p>
        <p className="mt-1 text-muted">
          Lv {current.level}/13 · {fmtTrim(daily, 1)} VLR {tr("perDay")} · ×{fmtTrim(s.activated ? effectiveMult(s, now) : current.mult, 2)}
        </p>
      </div>
      <div className="mt-3">
        <GoldButton onClick={close}>{tr("gotIt")}</GoldButton>
      </div>
    </Sheet>
  );
}

function BanOverlay({ onHide }: { onHide: () => void }) {
  const { tr } = useT();
  const banned = useVelora((s) => s.banned);
  const reset = useVelora((s) => s.reset);
  if (!banned) return null;
  return (
    <div className="absolute inset-0 z-50 flex items-end bg-bg/80 p-4 sm:items-center">
      <div className="w-full rounded-3xl border border-danger/40 bg-phone p-5">
        <span className="grid size-12 place-items-center rounded-2xl bg-danger/15 text-danger">
          <AlertTriangle />
        </span>
        <h2 className="mt-3 font-display text-2xl font-extrabold">{tr("bannedTitle")}</h2>
        <p className="mt-2 text-sm leading-relaxed text-muted">
          {banned.reason === "pending-sell" ? tr("reasonPending") : tr("reasonDump")}
        </p>
        <div className="mt-4 grid gap-2">
          <button
            type="button"
            onClick={() => reset()}
            className="h-12 rounded-full bg-gold font-extrabold text-bg"
          >
            {tr("playAgain")}
          </button>
          <button type="button" onClick={onHide} className="h-12 rounded-full border border-line font-bold">
            {tr("lookAround")}
          </button>
        </div>
      </div>
    </div>
  );
}
