/**
 * The site is served from condensate.dev/forkit/. Vocs applies `basePath` to routes and its own
 * assets; files from public/ that the site references directly (logos, screenshots) carry it
 * through `asset()`.
 */
export const BASE = "/forkit";

/** URL of a file in site/public, under the base path. */
export const asset = (path: string) => `${BASE}/${path.replace(/^\//, "")}`;
