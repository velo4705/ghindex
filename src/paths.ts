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

/**
 * URL path segment for a site page: sites/<owner>/<repo>.
 *
 * Lives here rather than in pages.ts because two places need to agree on it
 * exactly. The generator writes pages to these paths, and health.ts compares
 * them against the published index to catch pages left behind by a record that
 * is no longer published. When the two disagreed, health could not tell an
 * orphaned page from a real one.
 *
 * Repo names can be things like "ademcancertel.github.io", so after replacing
 * unsafe characters the segment can still END in a dot ("ademcancertel."). A
 * trailing dot is not a valid Windows directory name and mkdir fails, so dots
 * are stripped from the end. Case is preserved because GitHub owners are
 * case-insensitive but distinct users differ only by case on Pages.
 */
export function sitePath(owner: string, repo: string): string {
  const safe = (s: string) => {
    const cleaned = s.replace(/[^A-Za-z0-9._-]/g, "_").replace(/^[.]+/, "").replace(/[.]+$/, "");
    // Guard against a name that reduces to nothing (e.g. "...").
    return cleaned.length ? cleaned : "_";
  };
  return `sites/${safe(owner)}/${safe(repo)}`;
}
