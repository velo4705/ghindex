/**
 * Single source of truth for every filesystem path in the project.
 *
 * This exists because the paths used to be duplicated as string literals across
 * a dozen scripts, and every restructure broke half of them. One edit here now
 * moves the whole project.
 */
import { resolve } from "node:path";

const root = process.cwd();

export const PATHS = {
  /** Where the site is served from, and what GitHub Pages deploys. */
  site: "src/site",
  /**
   * Static assets inside the site directory.
   *
   * This held the generated index shards and the per-site HTML pages, both of
   * which are gone: results are asked of GitHub live instead. What remains is
   * the report-link config written by `bun run reports`.
   *
   * Note it is written but not read: report links were dropped from result rows
   * during the redesign, so nothing in the page consumes it. `bun run reports`
   * and this file are the last of that system; see the README before reviving
   * either.
   */
  data: "src/site/data",
} as const;

/** Absolute path, for tools that need one. */
export const abs = (p: string) => resolve(root, p);