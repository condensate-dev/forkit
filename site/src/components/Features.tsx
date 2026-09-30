import { BASE } from "../base.ts";

const FEATURES = [
  {
    title: "Real forks",
    body: "anvil forks real chains at a pinned block. deal, prank, warp, roll and snapshot like Foundry; every write is a real transaction, and the fork cache replays CI offline.",
    href: "/docs/guides/fork-cache-and-ci",
    more: "The fork cache",
  },
  {
    title: "Any runner",
    body: "describeFork and itFork for vitest, bun:test, jest and node:test, with a snapshot and revert around every test. One fork boot per file, or one shared by every file.",
    href: "/docs/getting-started",
    more: "Pick your runner",
  },
  {
    title: "Cross-chain simulators",
    body: "Fork two chains side by side. Simulated Across and Relay relayers fill through the real destination contracts, and quote APIs replay pinned to the fork block.",
    href: "/docs/guides/cross-chain",
    more: "Cross-chain routes",
  },
  {
    title: "forkit explore",
    body: "Record a run and browse it offline like a block explorer for your tests: decoded call trees, events, balance moves and cross-chain fills.",
    href: "/docs/guides/explore",
    more: "The explorer",
  },
] as const;

export function Features() {
  return (
    <section className="fk-section" aria-labelledby="fk-features">
      <h2 id="fk-features" className="fk-visually-hidden">
        Features
      </h2>
      <ul className="fk-features">
        {FEATURES.map((f) => (
          <li key={f.title} className="fk-feature">
            <h3>{f.title}</h3>
            <p>{f.body}</p>
            <a href={`${BASE}${f.href}`}>{f.more} →</a>
          </li>
        ))}
      </ul>
    </section>
  );
}
