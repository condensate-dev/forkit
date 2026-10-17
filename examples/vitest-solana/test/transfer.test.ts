/**
 * Fork Solana mainnet-beta with surfpool, give a fresh wallet wrapped SOL, and send an SPL
 * `TransferChecked` through the real Token program, loaded from mainnet the first time it runs.
 */
import { createHash } from "node:crypto";
import { describeSurfnet, itSurfnet } from "@condensate/forkit/svm/vitest";
import {
  address,
  appendTransactionMessageInstruction,
  assertIsTransactionWithBlockhashLifetime,
  createKeyPairSignerFromPrivateKeyBytes,
  createTransactionMessage,
  getSignatureFromTransaction,
  pipe,
  sendAndConfirmTransactionFactory,
  setTransactionMessageFeePayerSigner,
  setTransactionMessageLifetimeUsingBlockhash,
  signTransactionMessageWithSigners,
} from "@solana/kit";
import {
  findAssociatedTokenPda,
  getTransferCheckedInstruction,
  TOKEN_PROGRAM_ADDRESS,
} from "@solana-program/token";
import { expect } from "vitest";

// Wrapped SOL: the SPL token every cluster has.
const WSOL = address("So11111111111111111111111111111111111111112");
const SOL = 1_000_000_000n;

// Keys from a hash of a label: the same on every run, and (unlike a trivial seed such as 32 bytes
// of 0x01) not a key anyone uses on mainnet. On a live fork, an address that already exists there
// keeps its owner and data, and a fee payer must be a system account with no data.
const signer = (label: string) =>
  createKeyPairSignerFromPrivateKeyBytes(
    new Uint8Array(createHash("sha256").update(`forkit/vitest-solana/${label}`).digest()),
  );

// FORKIT_SVM_RPC_URL picks the fork source; the default is Solana's public mainnet-beta RPC.
// resetEach: every test starts from the fork source again.
describeSurfnet("SPL transfer on a mainnet-beta fork", { resetEach: true }, (s) => {
  itSurfnet("alice sends bob 0.5 wrapped SOL", async () => {
    const alice = await signer("alice");
    const bob = (await signer("bob")).address;
    await s.dealSol(alice.address, SOL); // pays the fee
    const aliceAta = await s.deal(WSOL, alice.address, 2n * SOL);
    const bobAta = await s.deal(WSOL, bob, 0n); // creates bob's token account, empty

    const { value: lifetime } = await s.rpc.getLatestBlockhash().send();
    const message = pipe(
      createTransactionMessage({ version: 0 }),
      (m) => setTransactionMessageFeePayerSigner(alice, m),
      (m) => setTransactionMessageLifetimeUsingBlockhash(lifetime, m),
      (m) =>
        appendTransactionMessageInstruction(
          getTransferCheckedInstruction({
            source: aliceAta,
            mint: WSOL,
            destination: bobAta,
            authority: alice,
            amount: SOL / 2n,
            decimals: 9,
          }),
          m,
        ),
    );
    const transaction = await signTransactionMessageWithSigners(message);
    assertIsTransactionWithBlockhashLifetime(transaction);
    await sendAndConfirmTransactionFactory(s)(transaction, { commitment: "confirmed" });

    const balance = async (ata: typeof aliceAta) =>
      (await s.rpc.getTokenAccountBalance(ata).send()).value.amount;
    expect(await balance(aliceAta)).toBe(String((3n * SOL) / 2n));
    expect(await balance(bobAta)).toBe(String(SOL / 2n));

    const tx = await s.rpc
      .getTransaction(getSignatureFromTransaction(transaction), {
        maxSupportedTransactionVersion: 0,
        encoding: "json",
      })
      .send();
    expect(tx?.meta?.logMessages).toContain(`Program ${TOKEN_PROGRAM_ADDRESS} success`);
  });

  itSurfnet("the next test starts clean: bob has no token account", async () => {
    const bob = (await signer("bob")).address;
    const [bobAta] = await findAssociatedTokenPda({
      owner: bob,
      mint: WSOL,
      tokenProgram: TOKEN_PROGRAM_ADDRESS,
    });
    const { value } = await s.rpc.getAccountInfo(bobAta, { encoding: "base64" }).send();
    expect(value).toBe(null);
  });

  itSurfnet("warp: a day later on the fork's clock", async () => {
    const before = await s.clock();
    const after = await s.warp(86_400);
    expect(after.unixTimestamp).toBeGreaterThanOrEqual(before.unixTimestamp + 86_400n);
  });
});
