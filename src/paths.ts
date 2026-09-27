/**
 * Single source of truth for every filesystem path in the pipeline.
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
  /** Generated index shards, inside the site directory. */
  data: "src/site/data",

  /** The harvested corpus (source of truth; never published directly). */
  corpus: "src/index/data/corpus.json",
  /** Completed-shard ledger, makes the harvest resumable. */
  shards: "src/index/data/shards.json",

  /** Perf budget limits and baseline. */
  budget: "src/quality/perf-budget.json",
  /** Rolling probe history for anomaly detection. */
  history: "src/quality/data/probe-history.json",
} as const;

/** Absolute path, for tools that need one. */
export const abs = (p: string) => resolve(root, p);
