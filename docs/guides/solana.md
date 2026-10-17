# Solana forks with surfpool: `@condensate/forkit/svm`

`@condensate/forkit/svm` gives Solana code the same kind of fork tests the EVM side has. Each test suite gets its own [surfpool](https://github.com/solana-foundation/surfpool) surfnet. That is a local Solana node with a full JSON-RPC server, forked from mainnet-beta or any RPC you name. Your production TypeScript talks to it with `@solana/kit` exactly as it talks to a real cluster. Cheatcodes set accounts, deal SOL and SPL tokens, move the clock, and deploy programs.

```ts
import { describeSurfnet, itSurfnet } from "@condensate/forkit/svm/vitest";
import { address } from "@solana/kit";
import { expect } from "vitest";

const WSOL = address("So11111111111111111111111111111111111111112");
const alice = address("Fg6PaFpoGXkYsidMpWTK6W2BeZ7FEfcYkg476zPFsLnS");

describeSurfnet("on a mainnet-beta fork", {}, (s) => {
  itSurfnet("alice holds 2 wrapped SOL", async () => {
    const ata = await s.deal(WSOL, alice, 2_000_000_000n); // exact, read back
    const { value } = await s.rpc.getTokenAccountBalance(ata).send();
    expect(value.uiAmountString).toBe("2");
  });
});
```

[examples/vitest-solana](../../examples/vitest-solana) goes further. It signs and sends an SPL `TransferChecked` through the real Token program, loaded from mainnet the first time the transaction touches it.

## Install

forkit/svm needs two things that the EVM side does not:

- **`@solana/kit` 8.** It is an optional peer dependency, so EVM-only users never install it.
- **The surfpool binary, 1.6.1 or newer.** forkit is built and tested against 1.6.1 (`SURFPOOL_VERSION`). It refuses older releases and accepts newer ones.

```sh
pnpm add -D "github:condensate-dev/forkit#<commit-sha>&path:/packages/forkit" @solana/kit
```

Install surfpool from its [release page](https://github.com/solana-foundation/surfpool/releases) (`surfpool-<os>-<arch>.tar.gz`). Then put it on `PATH`, or point `FORKIT_SURFPOOL_BIN` at it. Inside this repository, `scripts/install-surfpool.sh` does that for the pinned release. It downloads into `.tools/`, checks the sha256, and needs no sudo; `bun run test:svm` calls it for you.

A missing or too-old surfpool throws `SurfpoolNotFoundError` while the tests are being collected. A suite that cannot run is a broken environment, not a skipped test.

## Lifecycle

`describeSurfnet(name, options, body)` boots one surfnet before the suite's first test and stops it after the last. `itSurfnet(name, fn)` hands each test the nearest enclosing surfnet. They exist for vitest (`@condensate/forkit/svm/vitest`) and bun:test (`@condensate/forkit/svm/bun`). A nested `describeSurfnet` gets its own surfnet.

Without a runner, call `surfnet()` yourself:

```ts
import { surfnet } from "@condensate/forkit/svm";

const s = await surfnet({ rpcUrl: process.env.SOLANA_RPC_URL });
console.log(await s.rpc.getSlot().send());
await s.stop();
```

What forkit does for you:

- **Headless start.** It runs `surfpool start` with no TUI, no Studio and no project deploys, so your `txtx.yml` or `Anchor.toml` is never read. Every listener gets a free loopback port, and logs and state go to a temp directory that `stop()` removes.
- **Readiness.** `surfnet()` resolves when `surfnet_getSurfnetInfo` reports the startup phase `ready`. A failed startup, an early exit or the boot ceiling (`bootTimeoutMs`, 60 s) throws `SurfnetBootError` with surfpool's last output.
- **Secrets stay out of `ps`.** The fork URL reaches surfpool through its environment, never the command line, and it is masked in every error.
- **Bounded stop.** `stop()` is idempotent, and it kills surfpool if it has not exited within `stopTimeoutMs` (10 s).

The handle:

| Member | What |
|---|---|
| `s.rpc` | `@solana/kit` `Rpc<SolanaRpcApi>` over `s.rpcUrl` |
| `s.rpcSubscriptions` | `@solana/kit` subscriptions over `s.wsUrl` (pass `s` itself to `sendAndConfirmTransactionFactory`) |
| `s.request(method, params)` | raw JSON-RPC, for any `surfnet_*` method forkit does not wrap |
| `s.info()` | `surfnet_getSurfnetInfo` |
| `s.source` | the fork source, masked, or `"offline"` |
| `s.surfpoolVersion` | the running surfpool's version |

## The fork source

| Option | Default | |
|---|---|---|
| `rpcUrl` | `FORKIT_SVM_RPC_URL`, else `https://api.mainnet-beta.solana.com` | where accounts are forked from |
| `offline` | `false` | no fork source at all; only what you set, plus surfpool's built-in programs |
| `surfpoolBinary` | `FORKIT_SURFPOOL_BIN`, else `surfpool` | |
| `slotTimeMs` | 400 | surfpool's `--slot-time` |
| `args` | none | extra `surfpool start` flags |
| `bootTimeoutMs`, `stopTimeoutMs` | 60 s, 10 s | |
| `resetEach` (suites only) | `false` | see [Isolation](#isolation-no-snapshot-no-revert) |

**A surfnet forks live state, not a pinned slot.** Solana RPCs cannot serve an account as it was at an old slot. So surfpool fetches each account the first time the surfnet reads it, as it is at that moment. After that, the account is local. Two consequences:

- A fork test can see different mainnet state from one run to the next. Assert on what your code did, such as balance changes and logs, not on absolute mainnet values that move.
- There is no record-and-replay like the EVM fork cache, so a mainnet fork test needs network in CI. For a test that must be hermetic, use `offline: true` and set up every account it needs with the cheatcodes below.

The public mainnet-beta RPC is rate limited. Use your own RPC for anything beyond a quick try.

## Cheatcodes

Every cheatcode is a `surfnet_*` method of surfpool 1.6.1. Balances that a cheatcode sets are read back, and a mismatch throws `DealError`, as on the EVM side.

| Foundry | forkit/svm | surfpool method | Note |
|---|---|---|---|
| `vm.deal(who, amount)` | `s.dealSol(wallet, lamports)` | `surfnet_setAccount` | sets the balance to exactly `lamports` |
| `deal(token, who, amount)` | `s.deal(mint, owner, amount)` | `surfnet_setTokenAccount` | sets `owner`'s associated token account to exactly `amount` base units, creating it if needed; returns its address. The token program (Token or Token-2022) comes from the mint's owner; pass `{ tokenProgram }` to override |
| `vm.store`, `vm.setNonce`, … | `s.setAccount(address, { lamports, data, owner, executable, rentEpoch })` | `surfnet_setAccount` | any field you leave out keeps its current (or forked) value |
| `vm.etch(addr, code)` | `s.etch(programId, so)` | `surfnet_writeProgram` | deploys a `.so` (bytes or a file path) as an upgradeable program, in 2 MiB chunks; `{ authority }` sets its upgrade authority |
| (none) | `s.setProgramAuthority(programId, authority \| null)` | `surfnet_setProgramAuthority` | `null` makes the program immutable |
| `vm.warp(ts)` | `s.warp(seconds)` | `surfnet_timeTravel` `absoluteTimestamp` | relative: moves the `Clock` sysvar forward that many seconds |
| `vm.roll(n)` | `s.roll(slots)` | `surfnet_timeTravel` `absoluteSlot` | relative, in slots |
| (absolute) | `s.warpTo({ unixTimestamp } \| { slot } \| { epoch })` | `surfnet_timeTravel` | forward only: surfpool refuses the past |
| (none) | `s.pauseClock()`, `s.resumeClock()` | `surfnet_pauseClock`, `surfnet_resumeClock` | stop and restart slot production |
| (none) | `s.clock()` | reads the `Clock` sysvar | `{ slot, epoch, unixTimestamp }` |
| `vm.snapshot` / `vm.revertTo` | **none** | **none** | surfpool 1.6.1 has no runtime snapshot or revert; see below |
| `vm.prank(who)` | none | none | Solana transactions carry signatures; sign with a test keypair (`createKeyPairSignerFromPrivateKeyBytes` with a fixed seed) |

Lamports, token amounts, slots and timestamps are bigints, and they reach surfpool as exact u64s.

### Programs

```ts
await s.etch(MY_PROGRAM_ID, "target/deploy/my_program.so");
// …then send transactions to MY_PROGRAM_ID as usual.
```

`etch` replaces whatever is at `programId`, a mainnet program included. That lets you test a patched build against mainnet's real accounts. When the new program is smaller than the one it replaces, forkit zeroes the old tail, because `surfnet_writeProgram` never shrinks the account. The target must be a new address or an upgradeable-loader program.

## Isolation: no snapshot, no revert

On the EVM side, every test starts from the same snapshot. **surfpool 1.6.1 has no runtime snapshot or revert method**, so forkit/svm does not pretend to have one. The `surfnet_*` methods of that release include `surfnet_exportSnapshot` (dump accounts as JSON) and a startup `--snapshot` flag (load that JSON at boot), but nothing restores a saved state at runtime. What exists:

- **`s.reset()`** (`surfnet_resetNetwork`) drops every local change, clock included. Accounts load again from the fork source on their next read, **as they are now**. It is a reset to the source's current state, not a revert to a saved one.
- **`s.reset(account, { includeOwnedAccounts })`** (`surfnet_resetAccount`) resets one account, and optionally the accounts it owns.
- **`resetEach: true`** on `describeSurfnet` calls `s.reset()` after every test.

By default tests in a suite share their surfnet's state, so order matters. Use `resetEach`, or one `describeSurfnet` per scenario, when it should not.

## CI

The forkit repository's own CI installs the pinned surfpool with `scripts/install-surfpool.sh`. That script checks the release asset's sha256, so CI and local runs test against the same binary. In your project, the equivalent is:

```yaml
- name: install surfpool
  run: |
    curl -fsSL -o surfpool.tar.gz https://github.com/solana-foundation/surfpool/releases/download/v1.6.1/surfpool-linux-x64.tar.gz
    echo "64cff3fd6bb00bb0d5c7edef2915a491338d14eb19b7130abf9c81ee5357d165  surfpool.tar.gz" | sha256sum -c
    mkdir -p "$RUNNER_TEMP/surfpool" && tar -xzf surfpool.tar.gz -C "$RUNNER_TEMP/surfpool"
    echo "FORKIT_SURFPOOL_BIN=$(find "$RUNNER_TEMP/surfpool" -type f -name surfpool)" >> "$GITHUB_ENV"
- run: npx vitest run
  env:
    FORKIT_SVM_RPC_URL: ${{ secrets.SOLANA_RPC_URL }}
```

## litesvm or surfpool?

Both run the Solana VM locally. They answer different questions, and surfpool is in fact built on litesvm (surfpool 1.6.1 depends on litesvm 0.16).

| | [litesvm](https://github.com/litesvm/litesvm) | surfpool (forkit/svm) |
|---|---|---|
| What it is | an SVM library, in your test process | a local node with a JSON-RPC and WebSocket server |
| Mainnet state | none; you load every program and account yourself | fetched on demand from the fork source, the first time it is read |
| How your code reaches it | litesvm's own API (`sendTransaction`, `setAccount` on the VM object) | any Solana RPC client: `@solana/kit`, an SDK, your app's own code |
| Speed | in-process calls; nothing to boot, no network | a process to boot (well under a second offline); an RPC round trip per call |
| Determinism | full | full offline; a mainnet fork sees live state |
| Use it for | unit tests of your own program: fast, local, no fork | integration tests of client code against real mainnet programs and accounts |

Use **litesvm** when you test your own program's logic, you can build every account the test needs, and speed matters: thousands of cases, fuzzing, CU budgets.

Use **surfpool** when the code under test talks RPC, when it depends on other protocols' programs and accounts as they really are on mainnet, or both. A router, a quote, a wallet flow, or an SDK you do not control are all in that category. That is the Solana version of what forkit does on the EVM side.

## Troubleshooting

- **`SurfpoolNotFoundError`**: no surfpool on `PATH` or at `FORKIT_SURFPOOL_BIN`, or it is older than 1.6.1.
- **`SurfnetBootError: … exited … before it was ready`**: the message ends with surfpool's own output. An unreachable or rate-limited fork source is the usual cause; try your own `rpcUrl`.
- **`SurfnetRpcError`**: surfpool answered a `surfnet_*` call with an error. It carries the JSON-RPC `code`; a time travel into the past is one example.
- **`DealError`**: the balance did not read back as set, or the "mint" is not owned by the Token or Token-2022 program.
- **A stop takes about half a second longer than expected**: surfpool 1.6.1 can ignore a SIGTERM that arrives just after it reports ready, so `stop()` sends another every 500 ms until it exits.
