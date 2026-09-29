## What

<!-- The change, and why. Link the milestone or issue. -->

## Tests

<!-- What covers it. Fork tests: chain, pinned block, and whether the recording is committed. -->

## Checklist

- [ ] `bun run typecheck`, `bun run lint` and `bun run test` pass
- [ ] `bun run test:anvil` and `FORKIT_CACHE=offline bun run test:e2e` pass on anvil 1.7.1 **and** stable
- [ ] New fork tests are deterministic (pinned blocks, fixed keys, absolute deadlines) and their recordings are committed
- [ ] Docs updated (`docs/`), with a CHANGELOG line under **Unreleased** for user-facing changes
- [ ] Clean room: no code, types, comments or constants from other projects' private code; chain facts cite public sources
