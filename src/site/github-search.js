/**
 * On-demand GitHub search, used to widen the net beyond the local index.
 *
 * Why this exists
 * ---------------
 * The local index is a fixed corpus built from a fixed set of topic shards, so
 * it has hard edges. Measured: querying six topics the harvester never used
 * turned up 127 owners with Pages enabled, and 122 of them (96%) were absent
 * from the local index. A site can be live, served from GitHub Pages, and
 * simply not be in our data, because nobody happened to tag it with a topic we
 * harvested.
 *
 * Pre-generating everything is not possible: the search API caps at 1,000
 * results per query and there is no endpoint that lists all Pages sites, so the
 * reachable ceiling is bounded by how many distinct queries we invent. The only
 * way to cover the long tail is to ask GitHub at the moment the user searches.
 *
 * So the design is a hybrid:
 *   - the local index answers the common case instantly, offline, and with
 *     fuzzy matching and categories that GitHub's API cannot do;
 *   - this module asks GitHub directly when the user wants to search wider.
 *
 * Constraints this must respect
 * -----------------------------
 *  - Unauthenticated search is 10 requests/minute, keyed to the visitor's IP.
 *    So this is explicit opt-in, never automatic, and is cached per query.
 *  - A token can be supplied by the user for the authenticated rate limit, but
 *    never stored: there is no backend to keep a secret in.
 *  - Results are shown as a separate group so it is always clear they came
 *    from GitHub, are not part of the curated index, and are unverified.
 *
 * NOTE: plain JavaScript, not TypeScript. The publish pipeline has no build
 * step, so every file served to the browser is loaded exactly as written.
 */

/** GitHub caps a search at 1,000 results; say so rather than looking broken. */
const RESULT_CAP = 1000;
const PER_PAGE = 30;
const API = "https://api.github.com/search/repositories";

/**
 * Resolve a Pages URL for a repository.
 *
 * Mirrors pagesUrlFor() in src/index/core.ts: only a repo literally named
 * "<owner>.github.io" is served at the apex; everything else is a subpath.
 * GitHub's `homepage` field is preferred when it is a real *.github.io URL for
 * this owner, because that is what the site owner configured.
 */
export function pagesUrlFor(owner, repo, homepage) {
  const o = String(owner || "").toLowerCase();
  if (homepage) {
    try {
      const u = new URL(homepage);
      const host = u.hostname.toLowerCase();
      if (
        host.endsWith(".github.io") &&
        (host === `${o}.github.io` || host.endsWith(`.${o}.github.io`))
      ) {
        return u.toString();
      }
    } catch {
      // Unparseable: fall through and derive the URL.
    }
  }
  if (String(repo).toLowerCase() === `${o}.github.io`) return `https://${o}.github.io/`;
  return `https://${o}.github.io/${String(repo).toLowerCase()}/`;
}

/**
 * Turn free text into a GitHub repository search.
 *
 * A bare term is matched against name, description and readme. Adding
 * `in:name` alone would bias toward repo names, which is not what a visitor
 * typing "portfolio" means.
 */
function buildQuery(input) {
  const term = String(input || "").trim().replace(/["\\]/g, "");
  if (!term) return "";
  // Quotes make GitHub treat the input as one phrase. A visitor typing a name
  // wants that; a visitor typing loose words should not be over-constrained.
  const quoted = /\s/.test(term) ? `"${term}"` : term;
  return `${quoted} in:name,description,readme`;
}

/** Exposed for tests only. */
export const buildQueryForTest = buildQuery;

/**
 * Search GitHub for Pages-enabled repositories.
 *
 * @param {string} input free text from the user
 * @param {{token?: string, signal?: AbortSignal}} [opts]
 * @returns {Promise<{query:string, results:Array, total:number, truncated:boolean, error?:string}>}
 */
export async function searchGitHub(input, opts = {}) {
  const q = buildQuery(input);
  if (!q) return { query: input, results: [], total: 0, truncated: false };

  const headers = {
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
  };
  if (opts.token) headers.Authorization = `Bearer ${opts.token}`;

  const url = `${API}?q=${encodeURIComponent(q)}&per_page=${PER_PAGE}`;

  try {
    const res = await fetch(url, { headers, signal: opts.signal });

    if (res.status === 403 || res.status === 429) {
      const reset = Number(res.headers.get("x-ratelimit-reset") || 0);
      const wait = reset ? Math.max(1, Math.ceil((reset * 1000 - Date.now()) / 1000)) : 60;
      return {
        query: input,
        results: [],
        total: 0,
        truncated: false,
        error:
          `GitHub's public search limit resets in ${wait}s. ` +
          `Add a read-only token for a higher limit, or keep browsing the local index.`,
      };
    }
    if (!res.ok) {
      return {
        query: input,
        results: [],
        total: 0,
        truncated: false,
        error: `GitHub search failed (HTTP ${res.status}).`,
      };
    }

    const body = await res.json();
    const items = Array.isArray(body.items) ? body.items : [];
    const total = Number(body.total_count) || 0;

    // has_pages is a field on each item, not a usable qualifier, so filter here.
    const results = items
      .filter((r) => r && r.has_pages)
      .map((r) => ({
        full_name: r.full_name,
        owner: (r.owner && r.owner.login) || String(r.full_name).split("/")[0],
        repo: r.name,
        url: pagesUrlFor((r.owner && r.owner.login) || "", r.name, r.homepage || null),
        description: r.description || null,
        topics: Array.isArray(r.topics) ? r.topics : [],
        stars: Number(r.stargazers_count) || 0,
      }));

    return { query: input, results, total, truncated: total >= RESULT_CAP };
  } catch (err) {
    if (err && err.name === "AbortError") throw err;
    return {
      query: input,
      results: [],
      total: 0,
      truncated: false,
      error: `Could not reach GitHub (${String(err).slice(0, 80)}).`,
    };
  }
}
