# Cross-chain routes

Test a cross-chain route end to end on a [multi-chain fork](multi-chain.md), with no live relayer and no live quote API:

```ts
import { bridge } from "@condensate_dev/forkit/bridges";
import { http } from "@condensate_dev/forkit/http";

const f = await fork([{ chain: base, blockNumber: B }, { chain: arbitrum, blockNumber: A }]);
const across = bridge.across(f);                 // watch Base's SpokePool from now on

// Your app's own fetch calls: recorded once, replayed in CI (pinned to the Base block).
const quote = await http.with({ name: "across/base-arb-usdc", blockNumber: B, hosts: ["app.across.to"] }, () =>
  getAcrossQuote(),
);
await depositOnBase(quote);                      // your production code
const [fill] = await across.settle();            // the simulated relayer fills on Arbitrum
fill.outputAmount; fill.details.fee;             // assert on economics
```

| Piece | What it does | Guide |
|---|---|---|
| `@condensate_dev/forkit/http` | intercepts `globalThis.fetch`: records quote APIs once, replays them pinned to the fork block, and redacts secrets | [HTTP record/replay](http-replay.md) |
| `bridge.across(f)` | watches Across SpokePool deposits; `settle()` fills them on the destination as a funded relayer | [Across](bridges-across.md) |
| `bridge.relay(f)` | watches Relay's depository; a simulated solver pays the order you register | [Relay](bridges-relay.md) |
| `bridge.custom(f, { originEvent, destinationOf, onDeposit })` | any other bridge | below |

A simulator watches from the moment you create it. It notices an `evm_revert`, even one re-mined to the same height, by comparing block hashes, and it forgets the deposits the revert undid. `poll()` and `settle()` run one at a time. A deposit whose fill throws stays pending and throws again, loudly.

```ts
const toy = bridge.custom(f, {
  name: "toy",
  originEvent: { event: depositedEvent, address: { [base.id]: vault } },
  destinationOf: () => arbitrum.id,
  onDeposit: async ({ deposit, destination }) => {
    await destination.dealNative(deposit.args.account, deposit.args.amount - FEE);
    return { outputAmount: deposit.args.amount - FEE, details: { fee: FEE } };
  },
});
```

The repo's `packages/forkit/test/e2e/base-arbitrum-across.vitest.ts` shows the whole loop. An Across quote is replayed from a fixture, a Base USDC deposit is filled on Arbitrum, and the fee accounting matches the quote exactly.
