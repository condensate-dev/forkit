/**
 * Live e2e: Relay from Base to Optimism on two real forks at pinned blocks, with a simulated solver.
 * The deposits go into Relay's real RelayDepository on Base; the fills land on Optimism, the calls
 * through Relay's real RelayRouterV3 there.
 *
 * Addresses, all from public sources:
 * - RelayDepository (Base), RelayRouterV3 (Optimism): https://api.relay.link/chains
 *   (`protocol.v2.depository`, `contracts.erc20Router`), verified on Basescan / Optimistic Etherscan;
 *   see src/bridges/relay-contracts.ts.
 * - USDC on Base and on Optimism: Circle, https://developers.circle.com/stablecoins/usdc-contract-addresses
 * - WETH on Optimism: the OP-stack predeploy 0x4200…0006 (also Relay's featured WETH on chain 10).
 *
 * RPCs: FORKIT_RPC_URL_8453 / FORKIT_RPC_URL_10 if set, else viem's defaults (https://mainnet.base.org,
 * https://mainnet.optimism.io), which serve archive state. (Arbitrum's public RPC does not, which is
 * why this route lands on Optimism.) Recorded to .forkit-cache/relay, so CI replays it offline.
 */
import {
  type Address,
  encodeFunctionData,
  erc20Abi,
  getAddress,
  type Hex,
  keccak256,
  parseAbi,
  parseEther,
  slice,
  toHex,
} from "viem";
import { base, optimism } from "viem/chains";
import { expect } from "vitest";
import { relay } from "../../src/bridges/relay.ts";
import { encodeRelayOrderCall, RelayFillError } from "../../src/bridges/relay-plan.ts";
import { NATIVE } from "../../src/index.ts";
import { describeFork, itFork } from "../../src/vitest.ts";

const BASE_BLOCK = 51_900_000n;
const OPTIMISM_BLOCK = 157_490_000n;
const CACHE_DIR = ".forkit-cache/relay";

const USDC_BASE: Address = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const USDC_OPTIMISM: Address = "0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85";
const WETH_OPTIMISM: Address = "0x4200000000000000000000000000000000000006";
const wethAbi = parseAbi(["function deposit() payable", "function transfer(address, uint256)"]);

// Derived from hashes, so no one holds anything there on the real chains.
const who = (name: string): Address =>
  getAddress(slice(keccak256(toHex(`forkit e2e ${name}`)), 12));
const alice = who("relay alice");
const bob = who("relay bob");
const orderId = (name: string): Hex => keccak256(toHex(`forkit e2e relay order ${name}`));

describeFork(
  "Relay: Base -> Optimism through a simulated solver",
  [
    { chain: base, blockNumber: BASE_BLOCK, cacheDir: CACHE_DIR },
    { chain: optimism, blockNumber: OPTIMISM_BLOCK, cacheDir: CACHE_DIR },
  ],
  (f) => {
    const balanceOf = (token: Address, holder: Address, chain: typeof base | typeof optimism) =>
      f.on(chain).client.readContract({
        address: token,
        abi: erc20Abi,
        functionName: "balanceOf",
        args: [holder],
      });

    /** Alice deposits `amount` USDC into Relay's depository on Base, tagged with `id`. */
    const depositUsdc = async (id: Hex, amount: bigint) => {
      await f.dealNative(alice, parseEther("1"));
      await f.deal(USDC_BASE, alice, amount);
      await f.prank(alice, async (c) => {
        await c.writeContract({
          address: USDC_BASE,
          abi: erc20Abi,
          functionName: "approve",
          args: [relay.DEPOSITORY, amount],
        });
        await c.writeContract({
          address: relay.DEPOSITORY,
          abi: relay.depositoryAbi,
          functionName: "depositErc20",
          args: [alice, USDC_BASE, amount, id],
        });
      });
    };

    itFork("the forks are pinned and Relay's contracts are there", async () => {
      expect(await f.client.getBlockNumber()).toBe(BASE_BLOCK);
      expect(await f.on(optimism).client.getBlockNumber()).toBe(OPTIMISM_BLOCK);
      expect(await f.client.getCode({ address: relay.DEPOSITORY })).toMatch(/^0x6080/);
      expect(await f.on(optimism).client.getCode({ address: relay.ROUTER })).toMatch(/^0x6080/);
    });

    itFork("USDC: deposit on Base, the solver pays the recipient minus the fee", async () => {
      const b = relay(f, { fee: { bps: 10, fixed: 20_000n } }); // 0.1% + 0.02 USDC
      const id = orderId("usdc");
      const amount = 1_000n * 10n ** 6n;
      b.expect(id, { destinationChainId: optimism.id, recipient: bob, currency: USDC_OPTIMISM });

      const depositoryBefore = await balanceOf(USDC_BASE, relay.DEPOSITORY, base);
      await depositUsdc(id, amount);
      expect(await balanceOf(USDC_BASE, relay.DEPOSITORY, base)).toBe(depositoryBefore + amount);
      expect(await balanceOf(USDC_OPTIMISM, bob, optimism)).toBe(0n);

      const [deposit] = await b.poll();
      expect(deposit).toMatchObject({
        originChainId: base.id,
        destinationChainId: optimism.id,
        address: relay.DEPOSITORY,
        args: { kind: "erc20", id, from: alice, token: USDC_BASE, amount },
      });

      const fee = amount / 1_000n + 20_000n;
      const fills = await b.settle();
      expect(fills).toHaveLength(1);
      expect(fills[0]).toMatchObject({
        destinationChainId: optimism.id,
        outputAmount: amount - fee,
        details: {
          orderId: id,
          kind: "erc20",
          solver: b.solver,
          inputAmount: amount,
          outputAmount: amount - fee,
          fee,
          recipient: bob,
          currency: USDC_OPTIMISM,
          calls: 0,
        },
      });
      expect(fills[0]?.txHashes).toHaveLength(1);
      expect(await balanceOf(USDC_OPTIMISM, bob, optimism)).toBe(amount - fee);
      expect(await balanceOf(USDC_OPTIMISM, b.solver, optimism)).toBe(0n);
      expect(b.pending).toHaveLength(0);
      expect(await b.settle()).toEqual([]);
    });

    itFork(
      "ETH with calls, from a quote-shaped order: the router wraps it and sends WETH on",
      async () => {
        const id = orderId("eth-with-calls");
        const input = parseEther("0.1");
        const output = parseEther("0.0995");
        // The shape of a real Relay quote (`protocol.v2`): the payment goes to the router, which
        // runs the calls with itself as msg.sender.
        const quote = {
          requestId: keccak256(toHex("forkit e2e relay request")),
          details: { currencyOut: { currency: { chainId: optimism.id } } },
          protocol: {
            v2: {
              orderId: id,
              orderData: {
                output: {
                  chainId: "optimism",
                  payments: [
                    {
                      recipient: relay.ROUTER,
                      currency: relay.NATIVE,
                      minimumAmount: parseEther("0.099").toString(),
                      expectedAmount: output.toString(),
                    },
                  ],
                  calls: [
                    encodeRelayOrderCall({
                      to: WETH_OPTIMISM,
                      data: encodeFunctionData({ abi: wethAbi, functionName: "deposit" }),
                      value: output,
                    }),
                    encodeRelayOrderCall({
                      to: WETH_OPTIMISM,
                      data: encodeFunctionData({
                        abi: wethAbi,
                        functionName: "transfer",
                        args: [bob, output],
                      }),
                    }),
                  ],
                  extraData: `0x000000000000000000000000${relay.ROUTER.slice(2)}` as Hex,
                },
              },
            },
          },
        };
        const b = relay(f);
        expect(b.expectQuote(quote)).toBe(id);

        await f.dealNative(alice, parseEther("1"));
        await f.expectBalanceChange(NATIVE, relay.DEPOSITORY, input, () =>
          f.prank(alice, (c) =>
            c.writeContract({
              address: relay.DEPOSITORY,
              abi: relay.depositoryAbi,
              functionName: "depositNative",
              args: [alice, id],
              value: input,
            }),
          ),
        );

        const routerBefore = await f.on(optimism).client.getBalance({ address: relay.ROUTER });
        const [fill] = await b.settle();
        expect(fill?.details).toMatchObject({
          kind: "native",
          inputAmount: input,
          outputAmount: output,
          minimumAmount: parseEther("0.099"),
          calls: 2,
          router: getAddress(relay.ROUTER),
        });
        expect(fill?.details?.fee).toBeUndefined();
        expect(fill?.txHashes).toHaveLength(1); // the payment rides along with the multicall
        expect(await balanceOf(WETH_OPTIMISM, bob, optimism)).toBe(output);
        expect(await f.on(optimism).client.getBalance({ address: relay.ROUTER })).toBe(
          routerBefore,
        );
      },
    );

    itFork("fills deposits in order; an unknown order id fails loudly", async () => {
      const b = relay(f);
      const known = orderId("known");
      b.expect(known, {
        destinationChainId: optimism.id,
        recipient: bob,
        currency: USDC_OPTIMISM,
        amount: 5n * 10n ** 6n,
      });
      await depositUsdc(orderId("unknown"), 10n ** 6n);
      await expect(b.settle()).rejects.toThrow(RelayFillError);
      await expect(b.settle()).rejects.toThrow(
        /carries id 0x[0-9a-f]{64}, and no fill is registered/,
      );
      expect(await balanceOf(USDC_OPTIMISM, bob, optimism)).toBe(0n);

      // Once registered, the stuck deposit fills, then the next one, in deposit order.
      b.expect(orderId("unknown"), {
        destinationChainId: optimism.id,
        recipient: bob,
        currency: USDC_OPTIMISM,
        amount: 1n,
      });
      await depositUsdc(known, 10n ** 6n);
      const fills = await b.settle();
      expect(fills.map((x) => x.deposit.args.id)).toEqual([orderId("unknown"), known]);
      expect(await balanceOf(USDC_OPTIMISM, bob, optimism)).toBe(5n * 10n ** 6n + 1n);
    });

    itFork(
      "opt-in: a deposit through the older RelayReceiver, keyed by its forwarded data",
      async () => {
        const b = relay(f, { receiver: true });
        const requestId = keccak256(toHex("forkit e2e relay receiver request"));
        const input = parseEther("0.01");
        b.expect(requestId, {
          destinationChainId: optimism.id,
          recipient: bob,
          currency: relay.NATIVE,
          fee: 1_000n,
        });
        await f.dealNative(alice, parseEther("1"));
        await f.prank(alice, (c) =>
          c.writeContract({
            address: relay.RECEIVER,
            abi: relay.receiverAbi,
            functionName: "forward",
            args: [requestId],
            value: input,
          }),
        );
        const before = await f.on(optimism).client.getBalance({ address: bob });
        const [fill] = await b.settle();
        expect(fill?.details).toMatchObject({
          kind: "receiver",
          orderId: requestId,
          inputAmount: input,
          fee: 1_000n,
        });
        expect(await f.on(optimism).client.getBalance({ address: bob })).toBe(
          before + input - 1_000n,
        );
      },
    );
  },
);
