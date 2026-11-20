// TonAPI client + response parsers. The parsers are pure and tolerant: anything
// that does not look like a normal incoming transfer is skipped (never credited).
// NOTE: response shapes were written from the public TonAPI docs and are covered
// by fixture tests only. Verify once against a real response (see tonapi.test.ts).
import { toRawAddress } from "./ton-address.ts";
import type { IncomingTransfer } from "./deposits.ts";
import type { Price } from "./buy-quote.ts";

const BASE = "https://tonapi.io";

type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

export function parseIncomingTransfers(json: unknown, treasuryRaw: string): IncomingTransfer[] {
  const txs = (json as Json | null)?.transactions;
  if (!Array.isArray(txs)) return [];
  const out: IncomingTransfer[] = [];
  for (const t of txs as Json[]) {
    const msg = t?.in_msg as Json | undefined;
    if (!msg || typeof t.hash !== "string") continue;
    if (msg.msg_type !== "int_msg") continue; // external/outgoing are not deposits
    if (msg.bounced === true) continue;
    const dest = msg.destination?.address;
    if (typeof dest !== "string" || toRawAddress(dest) !== treasuryRaw) continue;
    const src = typeof msg.source?.address === "string" ? toRawAddress(msg.source.address) : null;
    if (!src) continue;
    let valueNano: bigint;
    try {
      valueNano = BigInt(String(msg.value));
    } catch {
      continue;
    }
    if (valueNano <= 0n) continue;
    const comment =
      msg.decoded_op_name === "text_comment" && typeof msg.decoded_body?.text === "string"
        ? (msg.decoded_body.text as string)
        : undefined;
    out.push({
      txHash: t.hash,
      at: Number(t.utime ?? 0) * 1000,
      valueNano,
      fromRaw: src,
      comment,
      success: t.success === true && t.aborted !== true,
    });
  }
  return out;
}

/** TON per 1 VLR (== GRAM per VLR). */
export function parseVlrPrice(json: unknown, now: number): Price | null {
  const rates = (json as Json | null)?.rates as Json | undefined;
  if (!rates || typeof rates !== "object") return null;
  const first = Object.values(rates)[0] as Json | undefined;
  const p = Number(first?.prices?.TON);
  return Number.isFinite(p) && p > 0 ? { gramPerVlr: p, at: now } : null;
}

type FetchFn = (
  url: string,
  init?: { method?: string; headers?: Record<string, string>; body?: string },
) => Promise<{ ok: boolean; status?: number; json(): Promise<unknown> }>;

async function get(path: string, key: string, f: FetchFn): Promise<unknown> {
  const r = await f(`${BASE}${path}`, { headers: { Authorization: `Bearer ${key}` } });
  if (!r.ok) throw new Error("tonapi-request-failed");
  return r.json();
}

export async function fetchTreasuryTransfers(
  key: string, treasury: string, treasuryRaw: string, f: FetchFn = fetch as unknown as FetchFn,
): Promise<IncomingTransfer[]> {
  return parseIncomingTransfers(await get(`/v2/blockchain/accounts/${treasury}/transactions?limit=100`, key, f), treasuryRaw);
}

export async function fetchVlrPrice(
  key: string, jettonMaster: string, now = Date.now(), f: FetchFn = fetch as unknown as FetchFn,
): Promise<Price | null> {
  return parseVlrPrice(await get(`/v2/rates?tokens=${jettonMaster}&currencies=ton`, key, f), now);
}

export function parsePublicKey(json: unknown): string | null {
  const k = (json as Json | null)?.public_key;
  return typeof k === "string" && /^[0-9a-fA-F]{64}$/.test(k) ? k.toLowerCase() : null;
}

/** Public key of a deployed wallet. Undeployed wallets have none -> null -> proof rejected. */
export async function fetchPublicKey(
  key: string, addressRaw: string, f: FetchFn = fetch as unknown as FetchFn,
): Promise<string | null> {
  return parsePublicKey(await get(`/v2/accounts/${addressRaw}/publickey`, key, f));
}

// ---- hot wallet / payout helpers (shapes from public TonAPI docs; verify once against live responses) ----
export const VLR_DECIMALS = 9;

export async function fetchSeqno(key: string, addr: string, f: FetchFn = fetch as unknown as FetchFn): Promise<number> {
  const n = Number(((await get(`/v2/wallet/${addr}/seqno`, key, f)) as Json | null)?.seqno);
  if (!Number.isInteger(n) || n < 0) throw new Error("bad-seqno");
  return n;
}

/** The hot wallet's VLR jetton wallet address and balance (in whole VLR). */
export async function fetchJettonWallet(
  key: string, hotAddr: string, master: string, f: FetchFn = fetch as unknown as FetchFn,
): Promise<{ jettonWallet: string; balance: number }> {
  const j = (await get(`/v2/accounts/${hotAddr}/jettons/${master}`, key, f)) as Json | null;
  const addr = j?.wallet_address?.address;
  const bal = Number(j?.balance);
  if (typeof addr !== "string" || !Number.isFinite(bal)) throw new Error("bad-jetton-wallet");
  return { jettonWallet: addr, balance: bal / 10 ** VLR_DECIMALS };
}

export async function broadcastBoc(key: string, bocBase64: string, f: FetchFn = fetch as unknown as FetchFn): Promise<void> {
  const r = await f(`${BASE}/v2/blockchain/message`, {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify({ boc: bocBase64 }),
  });
  if (!r.ok) throw new Error("broadcast-failed");
}

export type MessageState = "success" | "failed" | "unknown";
export async function checkMessage(key: string, msgHash: string, f: FetchFn = fetch as unknown as FetchFn): Promise<MessageState> {
  const r = await f(`${BASE}/v2/blockchain/messages/${msgHash}/transaction`, { headers: { Authorization: `Bearer ${key}` } });
  if (!r.ok) return "unknown"; // not indexed yet (or lookup error): keep waiting
  const j = (await r.json()) as Json | null;
  if (typeof j?.hash !== "string") return "unknown";
  return j.success === true && j.aborted !== true ? "success" : "failed";
}

import type { JettonEvent } from "./sell-guard.ts";

/** Transfers of the VLR jetton to/from `walletRaw`, as sell-guard events. Anything unexpected is skipped. */
export function parseJettonHistory(json: unknown, walletRaw: string): JettonEvent[] {
  const events = (json as Json | null)?.events;
  if (!Array.isArray(events)) return [];
  const out: JettonEvent[] = [];
  for (const ev of events as Json[]) {
    const actions = Array.isArray(ev?.actions) ? (ev.actions as Json[]) : [];
    actions.forEach((a, idx) => {
      const t = a?.JettonTransfer as Json | undefined;
      if (a?.type !== "JettonTransfer" || a?.status !== "ok" || !t) return;
      const from = typeof t.sender?.address === "string" ? toRawAddress(t.sender.address) : null;
      const to = typeof t.recipient?.address === "string" ? toRawAddress(t.recipient.address) : null;
      const amount = Number(t.amount) / 10 ** VLR_DECIMALS;
      if (!Number.isFinite(amount) || amount <= 0 || typeof ev.event_id !== "string") return;
      const at = Number(ev.timestamp) * 1000;
      if (from === walletRaw) out.push({ id: `${ev.event_id}:${idx}`, at, direction: "out", amount, counterparty: to ?? undefined });
      else if (to === walletRaw) out.push({ id: `${ev.event_id}:${idx}`, at, direction: "in", amount, counterparty: from ?? undefined });
    });
  }
  return out;
}

export async function fetchJettonHistory(
  key: string, walletRaw: string, master: string, f: FetchFn = fetch as unknown as FetchFn,
): Promise<JettonEvent[]> {
  return parseJettonHistory(await get(`/v2/accounts/${walletRaw}/jettons/${master}/history?limit=100`, key, f), walletRaw);
}
