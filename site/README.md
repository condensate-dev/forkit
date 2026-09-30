# site/

The forkit docs site for **condensate.dev/forkit**, built with [Vocs](https://vocs.dev), the MIT framework from wevm that also runs getfoundry.sh, viem.sh and reth.rs. It is not deployed from this repo: the operator deploys `site/dist/` after maintainer approval.

- **Home page:** `src/pages/index.mdx`, with the components in `src/components/`.
- **Docs:** the forkit book in `docs/`, copied in at build time.
- **Features:** ⌘K search, and light and dark themes.

## Commands

The site has its own install, separate from the bun workspace (see "Why a separate install" below).

```sh
bun run site:install     # bun install in site/ (frozen lockfile); site:build and site:dev run it too
bun run site:dev         # sync the book, then vocs dev
bun run site:build       # install site deps, sync the book, vocs build, write the static site to site/dist
bun run site:check       # offline link check of site/dist
bun run site:typecheck   # tsc over site/src, site/tools and vocs.config.ts
```

## Deploying

Serve `site/dist/` at the `/forkit/` subpath, for example as a Cloudflare Pages directory. `basePath` is `/forkit`, so every URL in the build is root-absolute under `/forkit/`. The site cannot be served at another path without rebuilding.

- **Offline:** it loads nothing from outside the site: no analytics, no CDN, no web fonts from a third party. The only external URLs are ordinary links (GitHub, condensate.dev). Vocs' "Ask AI" box and "Copy page for AI" menu, which send readers to ChatGPT or Claude, are switched off on every page.
- **Strict CSP:** condensate.dev serves `Content-Security-Policy: default-src 'self'; script-src 'self'; …` with no `'unsafe-inline'` and no `'unsafe-eval'`. Vocs' output needs both, so the build makes it comply:
  - **Inline scripts:** the theme bootstrap, Waku's bootstrap and each page's RSC payload are moved into files under `assets/inline/`, loaded by `<script src>` in the same place, in the same order. Without that, pages never hydrate: no theme, no search, no hero.
  - **`new Function`:** Vocs revives function-valued config in the browser with `new Function`, and its default search `boostDocument` is one. `vocs.config.ts` sets it to `false`, which only drops Vocs' path-depth tie-breaker in search ranking.

  The screenshot test serves the site with that exact policy.
- **Static:** `renderStrategy` is `full-static`, so every page is pre-rendered HTML.

## How it is put together

- **The book is the source.** `tools/sync-docs.ts` copies `docs/**/*.md` and the root `CHANGELOG.md` into `src/pages/docs/`, which is gitignored. Edit `docs/`, never the copies.
  - **Links:** `.md` links become routes (a link whose text is a file name, like `vitest.md`, takes the page title); links to other repository files become GitHub URLs.
  - **Sidebar:** `vocs.config.ts` builds it from `docs/SUMMARY.md`, through the same module (`tools/book.ts`).
  - **Left out:** the design spec (`docs/spec.md`).
  - **Site-only edits:** there are three. Each is asserted, so a change in the book fails the build instead of leaving a stale page.
- **Home page:** a two-column hero in the viem/Reth pattern. The copy is on the left, the artwork on the right, and on phones the artwork is a band above the copy. The copy is an HTML heading with the lockup (`public/lockup*.svg`), and Vocs' `HomePage` tagline, description and buttons. On top of those:
  - an npm / pnpm / bun install box;
  - static badges (runners; CI links to the workflow; licence "MIT OR Apache-2.0");
  - four feature cards;
  - the USDC quickstart;
  - the real terminal output;
  - the explorer screenshots.
- **Hero artwork:** `src/components/VaporFork.tsx` is Condensate's forked-vapor WebGL shader, ported from the forkit page draft. It has its own panel, feathered into the page, with a contrast lift on the light ground, so the stream and its split read like viem's Colosseum etching. Its behaviour is intact:
  - a 30 fps cap and half resolution on phones;
  - paused offscreen or when the tab is hidden;
  - one static frame for reduced motion, and a CSS gradient without WebGL;
  - light and dark tint sets that follow the theme toggle live.
- **Brand:**
  - **Logo:** the top-left logo is the forkit mark (`public/mark*.svg`).
  - **Footer:** says "by Condensate", from `src/pages/_slots.tsx`.
  - **Accent:** seam violet, `#5a2ee6` light and `#a394ff` dark, set as Vocs' `accentColor`.
  - **Contrast:** everything else is neutral. Each text colour in `src/components/home.css` meets WCAG AA (4.5:1) against its background. The accent measures 7.1:1 on white and 7.5:1 on the dark background, the terminal colours 5.5–15.9:1, and muted text 7.9:1 and 9.1:1.

### Vocs 2.10 quirks worked around

- **`basePath` and logos:** `basePath` is not applied to `logoUrl`/`iconUrl`, so they carry `/forkit` themselves (`src/base.ts`).
- **`baseUrl`:** it renders `<base href>`, which makes the browser fetch lazy chunks from production. It is left unset, so canonical and OpenGraph URLs are relative.
- **Skip link:** the "skip to content" link is rendered without the base path. `tools/build.ts` rewrites it to the in-page `#vocs-content`.
- **Build output:** Vocs writes a server bundle next to the static site. `tools/build.ts` copies only the static `public/` tree to `site/dist`.
- **Pinned versions:** Waku is pinned to `1.0.0-rc.1`, because `rc.2` fails the build ("virtual:vite-rsc-waku/html-transform").

### Why a separate install

`site/` is not a workspace package. It has its own `bun.lock` and a hoisted linker (`bunfig.toml`).

- **Duplicate copies:** in the workspace, bun's isolated linker gave Vocs, Vite and `@vitejs/plugin-rsc` two copies each (one per peer-dependency set), and the build failed.
- **Library lockfile:** it also keeps Vocs' large dependency tree out of the library's lockfile.

## Third-party code

The home page's WebGL background (`src/components/VaporFork.tsx`) uses the 2D simplex noise from [webgl-noise](https://github.com/stegu/webgl-noise): `mod289`, `permute` and `snoise`. It is Copyright (C) 2011 Ashima Arts and (C) 2011-2016 Stefan Gustavson, under the MIT License, whose notice must ship with every copy. So:

- the source credits it above the shader;
- the shader string itself carries the notice, which survives minification into the bundle;
- `public/THIRD_PARTY_NOTICES.txt` has the full licence text and ships as `/forkit/THIRD_PARTY_NOTICES.txt`. The footer links to it.

Everything else in `src/` and `tools/` is this repo's own. Vocs, React and Waku are dependencies, not vendored. Add an entry to `THIRD_PARTY_NOTICES.txt` for any third-party code copied in.

## Generated assets

The explorer screenshots (`public/explore/*.png`, with their sizes in `src/generated/shots.json`) and the terminal output (`src/generated/terminal.html`) are generated from the repo:

```sh
bun site/tools/build-assets.ts
```

It needs anvil on `PATH` and Playwright's Chromium (`npx playwright install chromium` in `packages/forkit`).

- **Screenshots:** they come from the explorer's screenshot test over the committed showcase run record.
- **Terminal output:** it is the Base → Arbitrum Across e2e, replayed offline from its committed recording and printed by forkit's reporter with colour on.

## Checks

- **Link check:** `bun run site:check` checks every file in `site/dist`:
  - every local `href`/`src` resolves to a file under `/forkit/`;
  - every `#fragment` exists on its page;
  - nothing escapes the subpath, and there is no `<base>` tag;
  - no `.md` links: book links must be routes, and no link text may be a bare `.md` file name. Third-party `.md` documents are fine;
  - no inline executable scripts, which the CSP would block;
  - no Ask AI or third-party AI links;
  - no build-machine paths.

  External links are listed, not fetched. Vocs also fails the build on dead page links (`checkDeadlinks`).
- **Screenshots:** `bun run test:screens` includes `packages/forkit/test/screens/site.screens.ts`, which needs `site:build` first.
  - **What it renders:** the home page and a docs page, served under `/forkit/`, at 390 and 1440 px, in light and dark.
  - **Policy:** it serves the pages with condensate.dev's Content-Security-Policy.
  - **What fails it:** a 404, a network request outside the site, a console error (a CSP violation is one), a page that did not hydrate (no `data-vocs-theme`), any Ask AI widget, a home-page shader that never mounted or fell back, an image that doesn't load, or sideways scrolling.
  - **Output:** PNGs land in `FORKIT_SCREENS_DIR` and are never committed. CI uploads them as the `screenshots` artifact.
