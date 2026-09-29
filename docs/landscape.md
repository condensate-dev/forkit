# Landscape: fork testing from TypeScript

What else exists for running tests against forked EVM chains, how each tool works, and when to pick it over forkit. Checked in late September 2026 against each project's docs, repository and npm registry; every claim about another project links to its source. Tools change fast, so re-check before relying on a detail.

forkit's own position (from [spec.md](spec.md)): **real anvil, your production TypeScript code, any test runner, Foundry ergonomics.**

## Summary

| Tool | What it is | EVM | Runners | Forking | Strengths | Limits |
|---|---|---|---|---|---|---|
| **forkit** | A fork-test harness over anvil: lifecycle, cheats, isolation, cache, assertions, traces | anvil (Foundry), one process per fork | vitest, bun:test, jest, node:test; others via `createForkAdapter` | Lazy anvil fork, pinned block, recorded RPC cache, several chains at once | Tests your production TS against a real fork node; Foundry-style cheats and traces; offline replay | Needs `anvil` on `PATH`; no Solidity tests, fuzzing or invariants; pre-alpha and unpublished |
| **tevm** | An Ethereum node embedded in JS, exposed through viem clients | Stable npm line: EthereumJS. `main` and rc: native ZEVM (Zig) | Any in principle; has Vitest helper packages | In-process lazy fork of an upstream transport | No separate binary on the stable line; TS-native API; JSON-RPC snapshotting for tests | Mid-migration to a new engine; published `latest` is a year old; some tx types unsupported |
| **prool** | Programmatic anvil, alto and tempo instances, pools and a proxy server | Whatever the instance runs (anvil for forks) | Vitest helpers (`prool/vitest`); the core is runner-agnostic | Pass anvil's fork flags | Small, maintained by wevm; per-worker instance pools; forkit builds on it | Process management only: no cheats, assertions or per-test isolation |
| **viem test actions** | Typed wrappers for `anvil_*`, `hardhat_*` and `evm_*` RPC methods | Whatever node you point it at | Any (it's a client) | None itself: connects to a node you started | Complete, typed, standard | Doesn't start nodes, isolate tests, deal ERC-20s or decode reverts |
| **Hardhat 3** | A full Solidity development framework with an in-process simulated network (EDR) | EDR (Rust, in-process) | `hardhat test` with node:test (recommended) or Mocha; Solidity tests | `edr-simulated` network with `forking.url`; `vm.createSelectFork` in Solidity tests | One framework for Solidity and TS tests; network helpers, viem assertions, traces, gas stats, coverage | Tests live in a Hardhat project and run through its tooling |
| **Foundry `forge test --fork-url`** | Solidity tests against a fork, run by forge | revm (in forge) | forge only | `--fork-url` or cheatcodes, several forks per test | The reference cheatcode set; fast; fuzzing and invariants; traces and gas snapshots | Tests are Solidity, so your TS code (routing, quoting, SDK calls) isn't under test |

## tevm

**What it is.** tevm describes itself as "an Ethereum Node built to run in Browser, Bun, Deno, and Node.js", exposed through viem-compatible clients ([repo](https://github.com/evmts/tevm-monorepo)). Its site lists `anvil_*`, `hardhat_*`, `evm_*`, `debug_*` and other JSON-RPC namespaces among those it handles ([tevm.sh](https://www.tevm.sh/)). It is the closest thing to forkit in spirit: an EVM you drive from TypeScript tests.

**Engine: in transition, and the state is unclear.** There are three tevm lines at once:

- npm `latest` is `1.0.0-next.149`, published 2025-10-06 ([npm](https://www.npmjs.com/package/tevm?activeTab=versions)). It pulls in `@tevm/evm@^1.0.0-next.148`, which depends on `@ethereumjs/evm` ([npm](https://www.npmjs.com/package/@tevm/evm?activeTab=versions)): a JavaScript EVM.
- npm `rc` is `1.0.0-rc.153`, published 2026-07-30. Its `@tevm/evm` and `@tevm/node` depend on `@evmts/zevm@0.0.0`, "TypeScript bindings for the ZEVM light-client C ABI" ([npm](https://www.npmjs.com/package/@evmts/zevm)).
- `main` merged [PR #2102](https://github.com/evmts/tevm/pull/2102) on 2026-09-05. It "replace[s] the EthereumJS execution stack with a native ZEVM node", is marked a breaking change across about 39 packages, and "must not be treated as a published release". Its release blockers include publishing the ZEVM platform packages.

On `main`, per the [migration guide](https://github.com/evmts/tevm-monorepo/blob/main/docs/native-engine-migration.md):

- tevm wraps ZEVM "through a C ABI and Node-API addon", and "the former in-browser memory engine is removed".
- Custom JS opcode and precompile hooks are gone, and so are tevm's own matchers.
- `debug_traceCall` gives opcode traces capped at 100,000 steps, with no custom tracers.
- A ZEVM fork "starts at block zero; upstream block headers/history are not imported".
- A fork's upstream "must run in a separate process", because fork HTTP is synchronous in native code.

The [docs site](https://node.tevm.sh/introduction/what-is-tevm-node) still says tevm "runs in-memory in any JS environment with no native client binary" and works in the browser, which contradicts the repo README ("The native addon is not a browser WASM engine"). Which of these holds for a given install depends on the version you pick.

**Forking.** It is lazy: accounts, code and storage are fetched on first access and cached, and local writes overlay the fork ([docs](https://node.tevm.sh/core/forking)). The docs recommend pinning `blockTag` in tests. Optimism deposit transactions are supported, but Arbitrum transaction types `0x6a`–`0x6f` "are not supported yet". Snapshots and reverts are there; to change the fork block you create a new client.

**Testing story.**

- [`@tevm/test-node`](https://www.npmjs.com/package/@tevm/test-node) (source in [`extensions/test-node`](https://github.com/evmts/tevm-monorepo)) gives Vitest a forked tevm instance. It caches JSON-RPC responses to `__rpc_snapshots__/<file>.snap.json`, so later runs replay from disk. This is the closest analogue to forkit's fork cache.
- [`@tevm/test-matchers`](https://www.npmjs.com/package/@tevm/test-matchers) adds Vitest matchers such as `toChangeTokenBalance`, `toEmit` and `toBeRevertedWithError`.
- Both are published at `rc.151` (May 2026). The migration guide lists "matchers" among the retired pieces on `main`.

**Trade-offs against forkit.**

- *For tevm:*
  - It is a dependency you install from npm, not a binary on `PATH`. That is true of the stable line; on `main` it becomes a native addon.
  - It runs in-process, so a test can reach engine internals: on the EthereumJS line you get `getVm` and opcode hooks.
- *Against tevm:*
  - The engine is changing under users, and the published `latest` is a year old.
  - Chain coverage has documented gaps (Arbitrum transaction types).
  - Fidelity depends on a newer EVM implementation than anvil's (revm) or Hardhat's EDR. The migration guide itself warns that "existing fixture evidence must be rerun before claiming parity across hardforks".
- *Unverified:* speed. We found no published benchmark comparing tevm and anvil on fork workloads, so we make no speed claim either way.

## prool (wevm)

**What it is.** prool is "a library that provides programmatic HTTP testing instances for Ethereum", from wevm (the viem authors) ([repo](https://github.com/wevm/prool)). The core parts:

- `Instance` defines a process: anvil, tempo and alto are built in, and `Instance.define` adds your own.
- `Pool.create` gives "a bounded pool of exclusively leased instances", with a `reset` hook that runs before an instance is reused.
- `Server.create` puts a keyed proxy in front, with a URL per instance (`/1`, `/2`, …).
- Since 0.2.x, `prool/vitest` adds `Server.setup` (lazy, one instance per worker) and `Pool.setup` (eager, one per worker). Both handle named instances, e.g. `l1` and `l2`, isolated per worker.
- Version 0.2.16 (2026-09-16) ships these along with a `prool/testcontainers` entry point ([npm](https://www.npmjs.com/package/prool?activeTab=code)).

`@viem/anvil` (anvil.js), its predecessor, is archived and says "This library is deprecated. We recommend consumers to use Prool" ([repo](https://github.com/wevm/anvil.js)). Don't start new work on it.

**Relation to forkit.** forkit uses prool's `Instance.anvil` to start and stop each anvil (see `packages/forkit/src/fork.ts`). prool owns the process, and forkit owns everything above it:

- port allocation and the fail-loud boot with an install hint;
- OP-stack detection;
- the RPC cache proxy;
- cheats and per-test snapshot/revert;
- assertions, traces and labels;
- adapters for four runners.

prool's `Pool`/`Server` and forkit's `startSharedForks` overlap: both share instances across workers with exclusive leases.

**When prool alone is enough.** Plain Vitest, with one anvil (or alto) per worker driven through viem's test actions, and no cheats beyond what viem offers. Pimlico's testing guide uses prool this way with a Base fork ([Pimlico](https://docs.pimlico.io/guides/how-to/testing/prool)).

## viem test actions

**What they give you.** A Test Client (`createTestClient({ mode: "anvil" | "hardhat" | "ganache", transport })`) exposes typed actions that "map one-to-one with 'test' Ethereum RPC methods" ([Test Client](https://viem.sh/docs/clients/test), [Test Actions](https://viem.sh/docs/actions/test/introduction)). In viem 2.56 the set is:

- accounts: `impersonateAccount`, `stopImpersonatingAccount`, `setBalance`, `setCode`, `setNonce`, `setStorageAt`;
- state: `snapshot`, `revert`, `reset`, `dumpState`, `loadState`;
- blocks and time: `mine`, `increaseTime`, `setNextBlockTimestamp`, `setAutomine`, `setIntervalMining`, `setBlockGasLimit`;
- transaction pool: `dropTransaction`, `getTxpoolContent`, `inspectTxpool`;
- and a few more ([source](https://github.com/wevm/viem/tree/main/src/actions/test)).

You can extend one client with public and wallet actions. viem does not start a node: you point the transport at one you started.

**What forkit adds on top.** `f.client` *is* a viem test client extended with public and wallet actions, so everything above still works. forkit adds:

- **Lifecycle:** it boots and stops anvil through prool, one fork per `describeFork`. It fails loudly when anvil is missing, allocates ports from the OS, passes `--optimism` for OP-stack chains, and bounds teardown.
- **Isolation:** it snapshots and reverts around every test by default, across every chain of a multi-fork.
- **Cheats viem lacks:**
  - `deal` for ERC-20s: `anvil_dealERC20`, falling back to storage-slot discovery, then a `balanceOf` read-back;
  - `prank` as a scoped impersonation that is always stopped;
  - `warp` and `roll`, which also mine.
- **Cache:** it records the fork's RPC answers per pinned block to `.forkit-cache/`, which you can commit and replay offline in CI.
- **Assertions:** `expectRevert`, `expectEmit`, `expectBalanceChange`, with decoded errors and diffs.
- **Traces:** a reverted write carries a decoded, Foundry-style call tree. There are also labels and gas snapshots.
- **Runner adapters:** vitest, bun:test, jest and node:test.

If you only need a handful of `setBalance` / `impersonateAccount` calls against a node you already run, viem alone is the smaller dependency.

## Hardhat 3

**State.** Hardhat 3 shipped as a production-ready beta in August 2025 ([release](https://github.com/NomicFoundation/hardhat/releases/tag/hardhat@3.0.0)) and was declared stable on 2026-06-01 ([blog](https://blog.nomic.foundation/hardhat-3-is-now-stable/)). The current version is 3.18.0 ([npm](https://www.npmjs.com/package/hardhat)). Hardhat 2 remains on the `hh2` tag and has an announced end-of-life policy. Its simulated network is EDR, which "is written in Rust and provides bindings for the Node API" ([EDR](https://github.com/NomicFoundation/edr)). Networks run in-process, each `network.create()` is "a new, independent blockchain simulation", and `hardhat node` exposes one over JSON-RPC ([docs](https://hardhat.org/docs/explanations/edr-simulated-networks)).

**Forking.** You declare a network with `type: "edr-simulated"` and `forking: { url, blockNumber }`. Then you either run a whole suite on it with `--network`, or connect to it inside a test with `network.create("mainnetFork")` ([forking guide](https://hardhat.org/docs/guides/forking)). The guide recommends pinning `blockNumber` for determinism and for "caching state between runs". Simulated networks can take `chainType: "op"` ([configuration](https://hardhat.org/docs/reference/configuration)). Solidity tests fork through `test.solidity.forking` or `vm.createSelectFork`.

**How tests are written.**

- TypeScript tests use `node:test`, described as "our recommended setup", or Mocha. You run them with `hardhat test` / `hardhat test nodejs` ([viem guide](https://hardhat.org/docs/guides/testing/using-viem)).
- Inside a test you get `viem` and `networkHelpers` from the connection. Assertions come from `hardhat-viem-assertions`: `emitWithArgs`, `revertWith`.
- `hardhat-network-helpers` gives `impersonateAccount`, `setBalance`, `setStorageAt`, `time.increase`, `takeSnapshot` and `loadFixture` ([helpers](https://hardhat.org/docs/plugins/hardhat-network-helpers)).
- Solidity tests are first-class too, with fuzzing and invariants ([testing](https://hardhat.org/docs/guides/testing)).
- Hardhat 3 added execution tracing for TS tests (3.3), gas statistics and gas snapshots ([blog](https://blog.nomic.foundation/hardhat-3-is-now-stable/)).

**Compared with forkit.** Hardhat 3 covers much of the same ground: forked chains, TS tests with viem, impersonation, snapshots and fixtures, revert and event assertions, and traces. It adds Solidity tests, fuzzing, coverage and compilation in the same tool. The difference is the frame:

- Hardhat tests run inside a Hardhat project through its runner and plugin system, against its in-process simulator.
- forkit is a library you import into the runner your app already uses, against the same anvil Foundry uses, with no project structure required.
- forkit also covers things the Hardhat docs we read don't describe:
  - ERC-20 `deal` with a read-back check;
  - a committable, offline RPC recording;
  - several chains booted as one handle;
  - simulated cross-chain relayers and quote record/replay.

If your repository is already a Hardhat project, Hardhat's own fork testing is the natural choice.

## Foundry: `forge test --fork-url`

**What it is.** forge runs Solidity tests against a fork:

- `forge test --fork-url <rpc>`, with `--fork-block-number` "for reproducible tests" ([fork testing](https://getfoundry.sh/forge/tests/fork-testing)).
- Fork data is cached under `~/.foundry/cache/rpc/<chain>/<block>/`.
- A test can open and switch between several forks with `vm.createFork` and `vm.selectFork`.

Cheatcodes are the reference set that forkit copies: environment (`warp`, `roll`, `prank`, `deal`), assertions (`expectRevert`, `expectEmit`), forking, state snapshots and labels ([cheatcodes](https://getfoundry.sh/reference/cheatcodes/overview), [Vm.sol](https://github.com/foundry-rs/forge-std/blob/master/src/Vm.sol)). You also get fuzzing, invariant testing, `-vvvv` traces and `forge snapshot`.

Foundry is actively released:

- v1.7.0 (April 2026) and v1.7.1 (May 2026);
- v1.8.x since, with 1.8.1 around late August ([changelog](https://www.getfoundry.sh/changelog), [releases](https://github.com/foundry-rs/foundry/releases)).

anvil, the node forkit runs, is part of this toolchain. It documents `anvil_dealERC20` (aliases `anvil_setERC20Balance`, `hardhat_dealERC20`) and `anvil_setERC20Allowance` among its custom methods ([RPC methods](https://www.getfoundry.sh/anvil/rpc-methods)).

**Compared with forkit.** For contract logic, forge is better: faster, with the full cheatcode set, fuzzing and invariants. What it can't test is off-chain TypeScript: your router, quote parsing, SDK calls, calldata builders and relayer handling. You'd have to reimplement that logic in Solidity or shell out through `vm.ffi`. forkit exists for that gap. It borrows forge's vocabulary (`deal`, `prank`, `warp`, `roll`, snapshot/revert, `expectRevert`, `expectEmit`, labels, gas snapshots, traces) and runs it on anvil, so the chain behaviour matches what a forge fork test would see.

## Others considered

- **`@viem/anvil`:** archived in June 2024 and deprecated in favour of prool ([repo](https://github.com/wevm/anvil.js)). Listed only because older guides still recommend it.
- **Hand-rolled setups:** many projects spawn anvil themselves (execa, a port per `VITEST_POOL_ID`) and drive it with viem ([viem discussion #275](https://github.com/wevm/viem/discussions/275)). That works, but it is the boilerplate forkit and prool replace.
- We found no other maintained, general-purpose TypeScript fork-test harness in September 2026. Python has equivalents, e.g. `eth_defi`'s `fork_network_anvil` ([docs](https://web3-ethereum-defi.readthedocs.io/api/provider/_autosummary_provider/eth_defi.provider.anvil.fork_network_anvil.html)), but they are out of scope here.

## When to use which

- **Testing Solidity contracts:** use **Foundry**. Use **Hardhat 3** if your project is already a Hardhat project. Both do fork tests with cheatcodes, fuzzing and invariants better than any TS harness.
- **A Hardhat project that also tests TS against a fork:** **Hardhat 3**'s `edr-simulated` fork, viem integration and network helpers keep everything in one tool.
- **You need an EVM with no external binary, or engine-level hooks from JS:** **tevm**, once you've checked which engine your version ships (EthereumJS on the stable npm line, native ZEVM on `main`) and that it supports your chains.
- **You only need anvil processes per Vitest worker:** **prool** plus **viem test actions**, and write the cheats yourself.
- **Your production TypeScript must run against real forked state:** use **forkit**. That covers routing, quoting, SDK calls and cross-chain flows, especially across several chains, in whichever runner you already use, with Foundry-style cheats, per-test isolation, readable traces and an offline cache for CI.

The costs of forkit:

- It needs Foundry's `anvil` installed.
- It doesn't test Solidity in Solidity.
- It is pre-alpha and not yet on npm.
