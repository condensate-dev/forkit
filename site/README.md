# site/

`site/forkit/` is the static page for **condensate.dev/forkit** (milestone 10). It is not deployed from this repo: the maintainers deploy it to condensate.dev.

## Deploying

Serve `site/forkit/` as-is at the `/forkit/` subpath, for example as a Cloudflare Pages directory. There is no build step and no framework.

- Every URL in the page is relative (`assets/site.css`, `assets/lockup.svg`, ...), so it works under `/forkit/` or any other subpath. Link to it with the trailing slash (`/forkit/`). Without the slash, relative URLs resolve against `/`. Cloudflare Pages redirects `/forkit` to `/forkit/` for a directory with an `index.html`.
- It loads nothing from the network: system fonts, no analytics, no CDN. The only external URLs are ordinary links (GitHub, condensate.dev).
- Light and dark follow `prefers-color-scheme`.

## Regenerating the generated parts

The explorer screenshots (`assets/explore-*.png`) and the terminal output inlined in `index.html` (between `<!-- terminal:start -->` and `<!-- terminal:end -->`) are generated from the repo:

```sh
bun site/tools/build-assets.ts
```

It needs anvil on `PATH` and Playwright's Chromium (`npx playwright install chromium` in `packages/forkit`). The screenshots come from the explorer's screenshot test over the committed showcase run record. The terminal output is the Base → Arbitrum Across e2e, replayed offline from its committed recording, printed by forkit's reporter with colour on.

## Checks

`bun run test:screens` includes `packages/forkit/test/screens/site.screens.ts`. It serves `site/` so the page loads at `/forkit/` and renders it at 390 and 1440 px in light and dark. It fails on a 404, a root-absolute URL, a network request, a console error or sideways scrolling. The PNGs land in `FORKIT_SCREENS_DIR`; they are never committed.
