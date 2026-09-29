# Gas snapshots

Like `forge snapshot`: label a transaction, and forkit records its gas in `.gas-snapshot`. The file has one `label (gas: N)` line per label, sorted, and is meant to be committed.

```ts
await f.gasSnapshot("deposit", () => vault.write.deposit({ value: 1n }));
// also accepts a hash, a receipt, or a promise of either; resolves to the gas used
```

| Mode | When | What it does |
|---|---|---|
| `write` | default locally | records the measurement; parallel workers merge their entries under a lock |
| `check` | default when `CI` is set | fails on a missing entry or a changed value: `gas for "deposit" changed: 51234 → 53012, +1778 (+3.47%)` |
| `off` | | just returns the gas |

- **Mode:** set it with `gasSnapshot` in the fork options, or with `FORKIT_GAS_SNAPSHOT`. An unknown value throws before anything boots.
- **File:** set it with `gasSnapshotFile`, or with `FORKIT_GAS_SNAPSHOT_FILE`. The default is `.gas-snapshot` in the working directory.
- **Re-recording:** after an intended change, run once with `FORKIT_GAS_SNAPSHOT=write` and commit the file.

Gas comes from the receipt. When anvil 1.8 cannot find a transaction after `evm_revert`, forkit takes it from the transaction's trace instead.
