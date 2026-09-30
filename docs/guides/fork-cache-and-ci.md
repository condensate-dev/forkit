# The fork cache, and running in CI

## Record once, replay offline

anvil forks lazily. Each account and storage slot a test touches is fetched from the RPC the first time, which is slow and rate limited on a public RPC. At a **pinned** block those answers never change, so forkit puts a small recording proxy between anvil and the RPC:

- The first run records every answer to `.forkit-cache/<chainId>/<block>.json`.
- Later runs replay it from disk with **zero network calls**.
- `f.cacheStats()` reports hits and misses per method, and `FORKIT_DEBUG=1` logs every miss.

| `FORKIT_CACHE` / `cache:` | Behaviour |
|---|---|
| `readwrite` (default) | replay hits, fetch and record misses |
| `readonly` | replay hits, fetch misses, never write |
| `offline` | replay hits, fail misses loudly, no network (CI) |
| `off` | no proxy: anvil talks to the RPC directly |

`FORKIT_CACHE_DIR` or the `cacheDir` option moves the recordings.

Unpinned forks are never cached, and they warn, because they are not reproducible.

The recordings work across anvil versions, because the cache keys reads by block number, not by the block hash that anvil 1.8 uses. Either form of an account read (`eth_getAccountInfo`, or the balance/nonce/code triple) is answered from the other.

## Making replays deterministic

A replay can only serve what a previous run asked for, so every run must ask the same questions:

- **Pin blocks.** On several chains, pin them at the same moment.
- **Derive keys and addresses from fixed strings**, never randomly.
- **Use absolute deadlines and timestamps.** An offset counted from the fork's wall clock changes on every run.
- **Pin ERC-4337 nonce keys** (`getNonce({ key: 0n })`). viem's default key is `Date.now()`.
- **Pin block times on Ethereum forks.** anvil 1.8 runs the EIP-4788 beacon-roots system call on every block it mines, and that call touches storage slot `timestamp % 8191` of the beacon-roots contract, which anvil first reads from the fork. anvil stamps blocks with the wall clock, so every run reads a different slot and the replay misses. Mine at a fixed interval instead, set once before the per-test snapshots (anvil keeps it across `evm_revert`):

  ```ts
  beforeAll(() => f.client.setBlockTimestampInterval({ interval: 12 }));
  ```
- **Re-record after changing a pin**, or after adding a test that touches new state: run once with network and `FORKIT_CACHE=readwrite` (the default).

## CI

The recording is plain JSON with sorted keys. There are three ways to use it in CI:

- **Commit it.** CI then runs fork tests offline with no RPC key, using `FORKIT_CACHE=offline`. forkit's own CI does this.
- **Cache it in CI:**

  ```yaml
  - uses: actions/cache@v4
    with:
      path: "**/.forkit-cache"
      key: forkit-${{ hashFiles('**/*.fork.test.ts') }}
      restore-keys: forkit-
  ```

- **Let turbo cache the test task.** A pinned, replayed fork test is a pure function of its inputs:

  ```json
  { "tasks": { "test:fork": { "inputs": ["src/**", "test/**", ".forkit-cache/**"], "env": ["FORKIT_CACHE"], "outputs": [".forkit-cache/**"] } } }
  ```

A GitHub Actions job needs foundry and Node (for the jest/node:test runners and the 4337 bundler):

```yaml
- uses: foundry-rs/foundry-toolchain@v1
  with: { version: stable }
- uses: oven-sh/setup-bun@v2
- uses: actions/setup-node@v4
  with: { node-version: 24 }
- run: bun install --frozen-lockfile
- run: bun test          # or vitest / jest / node --test
  env: { FORKIT_CACHE: offline }
```

## Which RPC

forkit picks the RPC for each fork in this order:
1. the `forkUrl` option;
2. `FORKIT_RPC_URL_<chainId>` (e.g. `FORKIT_RPC_URL_8453`);
3. the viem chain's default RPC.

URLs are redacted in every error. OP-stack chains get anvil's `--optimism` flag automatically. Public RPCs are rate limited, and some (Arbitrum's) keep only recent state, so record against a paid RPC when you can.
