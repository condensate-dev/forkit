# @condensate_dev/forkit

Foundry-style fork tests in TypeScript, for any test runner.

Fork real chains with anvil, fund any account, impersonate, warp time, snapshot and revert, then assert on what actually landed. Your production TypeScript (routers, quoting, SDK calls, bundlers, bridges) runs against real mainnet state, inside the runner you already use: vitest, bun:test, jest or node:test.

```sh
npm install -D @condensate_dev/forkit viem
curl -L https://foundry.paradigm.xyz | bash && foundryup   # anvil 1.7.1+
```

```ts
import { erc20Abi, parseEther, parseUnits } from "viem";
import { base } from "viem/chains";
import { describeFork, itFork } from "@condensate_dev/forkit/vitest";

const USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913"; // USDC on Base
const alice = "0x778dd60929c5b6f928aeab807fec6986f6ea3d82";
const bob = "0x4a3bcc777d2982e91fc24c678af32f7119c48883";

describeFork("USDC on Base", { chain: base, blockNumber: 51_800_000n }, (f) => {
  itFork("alice pays bob", async () => {
    await f.deal(USDC, alice, parseUnits("1000", 6));
    await f.dealNative(alice, parseEther("1")); // for gas
    await f.expectBalanceChange(USDC, bob, parseUnits("250", 6), () =>
      f.prank(alice, (c) =>
        c.writeContract({ address: USDC, abi: erc20Abi, functionName: "transfer", args: [bob, parseUnits("250", 6)] }),
      ),
    );
  });
});
```

| Import | For |
|---|---|
| `@condensate_dev/forkit` | `fork()`, assertions, labels, events |
| `@condensate_dev/forkit/vitest`, `/bun`, `/jest`, `/node` | `describeFork` / `itFork` per runner |
| `@condensate_dev/forkit/http`, `/bridges` | quote-API record/replay; Across, Relay and custom bridge simulators |
| `@condensate_dev/forkit/4337` | an ERC-4337 bundler (alto) on a fork |
| `@condensate_dev/forkit/payments` | EIP-2612, EIP-3009 and Permit2 signatures, USDT and USDC quirks, payment assertions |
| `@condensate_dev/forkit/reporter` | terminal output |
| `@condensate_dev/forkit/explore` and the `forkit` command | run records and the post-test explorer |

Documentation: [the forkit book](https://github.com/condensate-dev/forkit/blob/main/docs/README.md), with a quickstart per runner and a [Foundry → forkit cheatcode reference](https://github.com/condensate-dev/forkit/blob/main/docs/reference/cheatcodes.md).
