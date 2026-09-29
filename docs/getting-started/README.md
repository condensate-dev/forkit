# Quickstarts

One page per test runner. Each page is self-contained: install, runner config, a first fork test on Base, what isolation means, running offline in CI, and that runner's gotchas.

| Runner | Import | Page |
|---|---|---|
| vitest | `@condensate/forkit/vitest` | [vitest.md](vitest.md) |
| bun:test | `@condensate/forkit/bun` | [bun.md](bun.md) |
| jest (native ESM) | `@condensate/forkit/jest` | [jest.md](jest.md) |
| node:test | `@condensate/forkit/node` | [node.md](node.md) |

Every adapter exports the same `describeFork` / `itFork` pair and behaves the same way: one anvil per `describeFork`, and a snapshot and revert around every test. The differences are in runner setup:

- **vitest** needs only raised timeouts.
- **bun** runs TypeScript directly; raise the 5 s test timeout.
- **jest** must run in native ESM mode (`NODE_OPTIONS=--experimental-vm-modules`, swc emitting ES modules).
- **node:test** needs Node 22.18 or newer, which runs `.ts` files by stripping types.

For any other runner, `createForkAdapter({ describe, it, hooks })` from `@condensate/forkit` builds the pair from that runner's `describe`, `it` and lifecycle hooks.

All four need foundry's `anvil` 1.7.1 or newer on `PATH`. The rest of the API is in the [guides](../SUMMARY.md) and the [cheatcode reference](../reference/cheatcodes.md).
