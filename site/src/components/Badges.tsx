/**
 * Static badges: nothing loads from the network (no shields.io), and the repository is private,
 * so there is no live status to read. "tests" therefore names where they run (CI) and links
 * there, rather than claiming a result that could be stale. The licence stays "unlicensed" until
 * the maintainers decide.
 */
const BADGES = [
  { label: "vitest", href: "/docs/getting-started/vitest" },
  { label: "bun:test", href: "/docs/getting-started/bun" },
  { label: "jest", href: "/docs/getting-started/jest" },
  { label: "node:test", href: "/docs/getting-started/node" },
] as const;

export function Badges({ base }: { base: string }) {
  return (
    <ul className="fk-badges" aria-label="Runners, CI and licence">
      {BADGES.map((b) => (
        <li key={b.label}>
          <a className="fk-badge" href={`${base}${b.href}`}>
            <span className="fk-badge-key">runner</span>
            <span className="fk-badge-value">{b.label}</span>
          </a>
        </li>
      ))}
      <li>
        <a
          className="fk-badge"
          href="https://github.com/condensate-dev/forkit/actions/workflows/ci.yml"
        >
          <span className="fk-badge-key">tests</span>
          <span className="fk-badge-value">CI</span>
        </a>
      </li>
      <li>
        <span className="fk-badge">
          <span className="fk-badge-key">license</span>
          <span className="fk-badge-value">unlicensed</span>
        </span>
      </li>
    </ul>
  );
}
