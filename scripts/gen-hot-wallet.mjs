// Creates a brand-new, EMPTY wallet to be the server's payout ("hot") wallet.
// Run on YOUR computer:  npm run gen:hot-wallet
// Prints a 24-word secret phrase and the wallet address. Nothing is saved or sent anywhere.
import { mnemonicNew, mnemonicToPrivateKey } from "@ton/crypto";
import { WalletContractV4 } from "@ton/ton";

const words = await mnemonicNew(24);
const kp = await mnemonicToPrivateKey(words);
const w = WalletContractV4.create({ workchain: 0, publicKey: kp.publicKey });
console.log("\nHOT WALLET ADDRESS (send funds here):");
console.log("  " + w.address.toString({ bounceable: false }));
console.log("\nSECRET PHRASE -> put ONLY in the private server environment as HOT_WALLET_MNEMONIC. Never share it, never put it in code or chat:");
console.log("  " + words.join(" ") + "\n");
