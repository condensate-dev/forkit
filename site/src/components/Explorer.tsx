import { asset } from "../base.ts";
import shots from "../generated/shots.json";

const VIEWS = [
  {
    file: "explore-tx-1440.png",
    alt: "forkit explore showing a swap's call tree: each call decoded, with a gas bar, the events it emitted in place, and an inspector for the selected call",
    caption: "A transaction: decoded call tree, gas per call, events in place, and an inspector.",
  },
  {
    file: "explore-1440.png",
    alt: "forkit explore showing a run: its tests, forks and cross-chain fills",
    caption: "A run: tests, forks and cross-chain fills.",
  },
  {
    file: "explore-test-390.png",
    alt: "forkit explore on a phone, showing one test's timeline",
    caption: "One test's timeline, at 390 px.",
  },
] as const;

export function Explorer() {
  return (
    <div className="fk-explorer">
      {VIEWS.map((v) => {
        const size = shots[v.file];
        return (
          <figure
            key={v.file}
            className={`fk-shot fk-shot-${v.file.includes("390") ? "phone" : "wide"}`}
          >
            <img
              src={asset(`explore/${v.file}`)}
              alt={v.alt}
              width={size.width}
              height={size.height}
              loading="lazy"
            />
            <figcaption>{v.caption}</figcaption>
          </figure>
        );
      })}
    </div>
  );
}
