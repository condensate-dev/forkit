import { defineConfig } from "vocs/config";
import { asset, BASE } from "./src/base.ts";
import { sidebar } from "./tools/book.ts";

// Built static under /forkit/ for condensate.dev/forkit (see site/README.md). Not deployed from
// this repo.
export default defineConfig({
  title: "forkit",
  titleTemplate: "%s · forkit",
  description:
    "Foundry-style fork tests for TypeScript: real anvil forks, deal, prank, warp, snapshots and assertions, in vitest, bun:test, jest or node:test.",
  basePath: BASE,
  // Vocs writes its server bundle next to the static site; site/tools/build.ts copies only the
  // static part to site/dist.
  outDir: ".vocs/build",
  // No baseUrl: Vocs turns it into <base href="https://condensate.dev">, which makes the browser
  // fetch lazy chunks from production (and breaks local preview and the screenshot check).
  renderStrategy: "full-static",
  // condensate.dev serves `script-src 'self'` without 'unsafe-eval'. Vocs ships function-valued
  // config to the browser as strings and revives them with `new Function`, which that policy
  // blocks, and its default search `boostDocument` is such a function. `false` (not nullish, so
  // Vocs keeps it) means MiniSearch applies no per-document boost; the only loss is Vocs'
  // path-depth tie-breaker in search ranking.
  search: { query: { boostDocument: false as never } },
  checkDeadlinks: true,
  // Vocs applies basePath to routes, not to logoUrl / iconUrl.
  logoUrl: { light: asset("mark.svg"), dark: asset("mark-dark.svg") },
  iconUrl: { light: asset("mark.svg"), dark: asset("mark-dark.svg") },
  // Seam violet; everything else stays Vocs' neutral, high-contrast palette.
  accentColor: "light-dark(#5a2ee6, #a394ff)",
  colorScheme: "light dark",
  sidebar: { "/docs": sidebar() },
  topNav: [
    { text: "Docs", link: "/docs", match: "/docs" },
    { text: "Changelog", link: "/docs/changelog" },
  ],
  socials: [{ icon: "github", link: "https://github.com/condensate-dev/forkit" }],
});
