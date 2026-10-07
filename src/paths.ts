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
   * the report-link config, which is written by `bun run reports` and read by
   * the page to decide which repository a report issue opens in.
   */
  data: "src/site/data",
} as const;

/** Absolute path, for tools that need one. */
export const abs = (p: string) => resolve(root, p);