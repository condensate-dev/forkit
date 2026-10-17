/**
 * Account and transaction helpers for the svm tests: a hand-encoded SPL mint, a deterministic
 * signer, and sending one instruction.
 */
import {
  type Address,
  appendTransactionMessageInstruction,
  createKeyPairSignerFromPrivateKeyBytes,
  createTransactionMessage,
  getAddressEncoder,
  getBase64EncodedWireTransaction,
  getSignatureFromTransaction,
  type KeyPairSigner,
  pipe,
  setTransactionMessageFeePayerSigner,
  setTransactionMessageLifetimeUsingBlockhash,
  signTransactionMessageWithSigners,
} from "@solana/kit";
import type { Surfnet } from "../../src/svm/index.ts";
import { eventually } from "./upstream.ts";

/**
 * An initialized SPL Token mint account's 82 bytes: mint authority (COption<Pubkey>), supply
 * (u64), decimals, is_initialized, freeze authority (COption<Pubkey>). The layout is SPL Token's
 * public `Mint` state.
 */
export function mintData(authority: Address, decimals: number, supply = 0n): Uint8Array {
  const data = new Uint8Array(82);
  const view = new DataView(data.buffer);
  view.setUint32(0, 1, true);
  data.set(getAddressEncoder().encode(authority), 4);
  view.setBigUint64(36, supply, true);
  data[44] = decimals;
  data[45] = 1;
  return data;
}

/** A signer from a fixed seed byte, so runs are repeatable. */
export function testSigner(seed: number): Promise<KeyPairSigner> {
  return createKeyPairSignerFromPrivateKeyBytes(new Uint8Array(32).fill(seed));
}

/** Send one instruction from `payer` and return the transaction's log lines once it lands. */
export async function sendInstruction(
  s: Surfnet,
  payer: KeyPairSigner,
  programAddress: Address,
  data: Uint8Array,
): Promise<readonly string[]> {
  const { value: lifetime } = await s.rpc.getLatestBlockhash().send();
  const message = pipe(
    createTransactionMessage({ version: 0 }),
    (m) => setTransactionMessageFeePayerSigner(payer, m),
    (m) => setTransactionMessageLifetimeUsingBlockhash(lifetime, m),
    (m) => appendTransactionMessageInstruction({ programAddress, accounts: [], data }, m),
  );
  const transaction = await signTransactionMessageWithSigners(message);
  const signature = getSignatureFromTransaction(transaction);
  await s.rpc
    .sendTransaction(getBase64EncodedWireTransaction(transaction), { encoding: "base64" })
    .send();
  let logs: readonly string[] = [];
  await eventually(async () => {
    const tx = await s.rpc
      .getTransaction(signature, { maxSupportedTransactionVersion: 0, encoding: "json" })
      .send();
    if (tx === null) return false;
    if (tx.meta?.err !== null && tx.meta?.err !== undefined) {
      throw new Error(
        `transaction failed: ${JSON.stringify(tx.meta.err)}\n${tx.meta.logMessages?.join("\n")}`,
      );
    }
    logs = tx.meta?.logMessages ?? [];
    return true;
  });
  return logs;
}
