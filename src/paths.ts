/**
 * Single source of truth for every filesystem path in the project.
 *
 * This exists because the paths used to be duplicated as string literals across
 * a dozen scripts, and every restructure broke half of them. One edit here now
 * moves the whole project.
 *
 * It is now a single key. The generated index shards, the per-site pages, the
 * report-link config and the harvest pipeline are all gone, and nothing here
 * points at them — a path that no tool reads is a lie about the layout.
 */
import { resolve } from "node:path";

const root = process.cwd();

export const PATHS = {
  /** Where the site is served from, and what GitHub Pages deploys. */
  site: "src/site",
} as const;

/** Absolute path, for tools that need one. */
export const abs = (p: string) => resolve(root, p);