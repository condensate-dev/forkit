import { HomePage } from "vocs";
import { asset, BASE } from "../base.ts";
import { Badges } from "./Badges.tsx";
import { InstallTabs } from "./InstallTabs.tsx";
import { VaporFork } from "./VaporFork.tsx";

/**
 * The home page hero, in the viem/Reth pattern: the copy on one side and a piece of artwork on
 * the other, as viem has its Colosseum. forkit's artwork is Condensate's forked-vapor shader,
 * given its own panel so the stream and its split sit in the middle of the frame. On phones the
 * panel becomes a band above the lockup.
 */
export function Hero() {
  return (
    <section className="fk-hero">
      <div className="fk-hero-art">
        <VaporFork y={0.5} yPhone={0.5} />
      </div>
      <div className="fk-hero-copy">
        <h1 className="fk-wordmark">
          <img
            className="fk-light"
            src={asset("lockup.svg")}
            alt="forkit"
            width={1089}
            height={320}
          />
          <img
            className="fk-dark"
            src={asset("lockup-dark.svg")}
            alt="forkit"
            width={1089}
            height={320}
          />
        </h1>
        <HomePage.Tagline className="fk-hero-tagline">
          Foundry-style fork tests for TypeScript
        </HomePage.Tagline>
        <HomePage.Description className="fk-hero-description">
          Fork real chains with anvil. Deal, prank, warp, snapshot and assert on what actually
          landed, in the runner you already use.
        </HomePage.Description>
        <InstallTabs />
        <HomePage.Buttons className="fk-hero-buttons">
          <HomePage.Button href="/docs/getting-started" variant="accent">
            Get started
          </HomePage.Button>
          <HomePage.Button href="/docs/landscape">Why forkit</HomePage.Button>
          <HomePage.Button href="https://github.com/condensate-dev/forkit">GitHub</HomePage.Button>
        </HomePage.Buttons>
        <Badges base={BASE} />
      </div>
    </section>
  );
}
