// The ONLY file that touches the hot wallet's private key and the @ton libraries.
// Keep it small so it is easy to review. Needs: npm install @ton/ton @ton/core @ton/crypto
// Imported dynamically so the rest of the app (and tests) work without these packages.
import { createHash } from "node:crypto";

export async function loadHotWallet(mnemonic: string) {
  const { mnemonicToPrivateKey } = await import("@ton/crypto");
  const { WalletContractV4 } = await import("@ton/ton");
  const words = mnemonic.trim().split(/\s+/);
  if (words.length !== 24) throw new Error("bad-mnemonic");
  const kp = await mnemonicToPrivateKey(words);
  const wallet = WalletContractV4.create({ workchain: 0, publicKey: kp.publicKey });
  return { wallet, secretKey: kp.secretKey, rawAddress: wallet.address.toRawString() };
}

type Hot = Awaited<ReturnType<typeof loadHotWallet>>;

/** TEP-74 jetton transfer from the hot wallet's jetton wallet to `destRaw`, signed as a wallet-v4 external message. */
export async function buildSignedJettonTransfer(
  hot: Hot,
  a: { seqno: number; jettonWallet: string; destRaw: string; vlr: number; buyId: string },
): Promise<{ boc: string; msgHash: string }> {
  const { Address, beginCell, external, internal, SendMode, storeMessage, toNano } = await import("@ton/ton");
  const units = BigInt(Math.floor(a.vlr * 1e6)) * 1_000n; // 6 dp precision, VLR has 9 decimals
  if (units <= 0n) throw new Error("bad-amount");
  const queryId = createHash("sha256").update(a.buyId).digest().readBigUInt64BE(0); // traceable, unique per buy
  const body = beginCell()
    .storeUint(0xf8a7ea5, 32)
    .storeUint(queryId, 64)
    .storeCoins(units)
    .storeAddress(Address.parseRaw(a.destRaw))
    .storeAddress(hot.wallet.address) // excess TON returns to the hot wallet
    .storeBit(0)
    .storeCoins(1n)
    .storeBit(0)
    .endCell();
  const transfer = hot.wallet.createTransfer({
    seqno: a.seqno,
    secretKey: hot.secretKey,
    sendMode: SendMode.PAY_GAS_SEPARATELY | SendMode.IGNORE_ERRORS,
    messages: [internal({ to: Address.parse(a.jettonWallet), value: toNano("0.05"), bounce: true, body })],
  });
  const ext = external({ to: hot.wallet.address, init: a.seqno === 0 ? hot.wallet.init : undefined, body: transfer });
  const cell = beginCell().store(storeMessage(ext)).endCell();
  return { boc: cell.toBoc().toString("base64"), msgHash: cell.hash().toString("hex") };
}
