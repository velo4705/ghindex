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

/**
 * Results per API call. 100 is the maximum the search API allows, and it is
 * worth using: the unauthenticated budget is 10 calls/minute, so per_page=30
 * would reach 300 repos total while per_page=100 reaches 1,000. Same number of
 * requests, ten times the coverage.
 */
const PER_PAGE = 100;

/**
 * Pages fetched per search. GitHub serves at most 10 pages of 100, which is
 * exactly the 1,000-result cap; asking for an 11th returns HTTP 422.
 */
const MAX_PAGES = 10;

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

/** Exposed for tests only. */
export const MAX_PAGES_FOR_TEST = MAX_PAGES;

/**
 * Map one API item to a result row, or null if it has no Pages site.
 *
 * `has_pages` is a field on each item rather than a usable query qualifier --
 * measured, `stars:100..299 has:pages` and `stars:100..299` return identical
 * totals of 287,226, so GitHub accepts the qualifier and ignores it. The filter
 * has to happen here.
 */
function toResult(r) {
  if (!r || !r.has_pages) return null;
  const owner = (r.owner && r.owner.login) || String(r.full_name || "").split("/")[0];
  return {
    full_name: r.full_name || `${owner}/${r.name}`,
    owner,
    repo: r.name,
    url: pagesUrlFor(owner, r.name, r.homepage || null),
    description: r.description || null,
    topics: Array.isArray(r.topics) ? r.topics : [],
    stars: Number(r.stargazers_count) || 0,
  };
}

/**
 * Order results the way a search engine should: most popular first.
 *
 * GitHub returns its own relevance ordering, which for an unqualified query
 * mixes in repos that merely mention the term. Stars are the only popularity
 * signal available, and they are also what makes niche finds reachable: a
 * long-tail site has few stars, so without this it sits below whatever
 * happened to rank first in GitHub's ordering.
 */
function byPopularity(a, b) {
  return (b.stars - a.stars) || a.full_name.localeCompare(b.full_name);
}

/** Read the search rate-limit reset, if the response carries one. */
function resetSeconds(res) {
  const reset = Number(res.headers.get("x-ratelimit-reset") || 0);
  return reset ? Math.max(1, Math.ceil((reset * 1000 - Date.now()) / 1000)) : 60;
}

/**
 * Fetch one page of results.
 *
 * Returns a discriminated result rather than throwing so the caller can decide
 * whether a mid-pagination rate limit is fatal (nothing found) or partial
 * (keep what we already have).
 */
async function fetchPage(input, page, opts) {
  const headers = {
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
  };
  if (opts.token) headers.Authorization = `Bearer ${opts.token}`;

  const url =
    `${API}?q=${encodeURIComponent(buildQuery(input))}` +
    `&per_page=${PER_PAGE}&sort=stars&order=desc&page=${page}`;

  const res = await fetch(url, { headers, signal: opts.signal });

  if (res.status === 403 || res.status === 429) {
    return { kind: "rate-limited", wait: resetSeconds(res) };
  }
  if (!res.ok) return { kind: "error", message: `GitHub search failed (HTTP ${res.status}).` };

  const body = await res.json();
  return {
    kind: "ok",
    total: Number(body.total_count) || 0,
    items: Array.isArray(body.items) ? body.items : [],
  };
}

/**
 * Search GitHub for Pages-enabled repositories.
 *
 * Pages are fetched sequentially rather than in parallel: the rate limit is a
 * fixed budget per minute, so firing page 4 alongside page 1 would not make it
 * finish sooner, it would just spend the budget faster and make the *next*
 * search fail sooner.
 *
 * @param {string} input free text from the user
 * @param {{token?: string, signal?: AbortSignal, pages?: number}} [opts]
 * @returns {Promise<{query:string, results:Array, total:number, truncated:boolean,
 *                    pagesFetched:number, hasMore:boolean, partial?:string, error?:string}>}
 */
export async function searchGitHub(input, opts = {}) {
  const q = buildQuery(input);
  const empty = {
    query: input,
    results: [],
    total: 0,
    truncated: false,
    pagesFetched: 0,
    hasMore: false,
  };
  if (!q) return empty;

  const wantPages = Math.max(1, Math.min(MAX_PAGES, opts.pages ?? 1));
  const seen = new Set();
  const results = [];
  let total = 0;
  let pagesFetched = 0;
  let partial = null;

  for (let page = 1; page <= wantPages; page++) {
    let res;
    try {
      res = await fetchPage(input, page, opts);
    } catch (err) {
      if (err && err.name === "AbortError") throw err;
      partial = results.length
        ? `Stopped early: could not reach GitHub (${String(err).slice(0, 60)}).`
        : `Could not reach GitHub (${String(err).slice(0, 60)}).`;
      break;
    }

    if (res.kind === "rate-limited") {
      partial = results.length
        ? `GitHub's public search limit resets in ${res.wait}s. Showing what loaded before the limit.`
        : `GitHub's public search limit resets in ${res.wait}s. ` +
          `Add a read-only token for a higher limit, or keep browsing the local index.`;
      break;
    }
    if (res.kind === "error") {
      partial = results.length ? `${res.message} Showing earlier pages.` : res.message;
      break;
    }

    total = res.total;
    pagesFetched++;
    const before = results.length;
    for (const item of res.items) {
      const row = toResult(item);
      if (!row || seen.has(row.full_name)) continue;
      seen.add(row.full_name);
      results.push(row);
    }
    // An empty page means the result set is exhausted; asking for more would
    // burn rate limit for nothing.
    if (res.items.length === 0 || results.length === before) break;
    if (page < wantPages && total <= page * PER_PAGE) break;
  }

  results.sort(byPopularity);

  return {
    query: input,
    results,
    total,
    truncated: total >= RESULT_CAP,
    pagesFetched,
    hasMore: pagesFetched < MAX_PAGES && total > results.length,
    partial: partial ?? undefined,
    ...(results.length === 0 && partial && !partial.startsWith("Showing") && !partial.startsWith("Stopped")
      ? { error: partial }
      : {}),
  };
}
