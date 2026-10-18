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
 *    from GitHub, are not part of the curated index, and are unconfirmed.
 *
 * NOTE: plain JavaScript, not TypeScript. The publish pipeline has no build
 * step, so every file served to the browser is loaded exactly as written.
 */

/** GitHub caps a search at 1,000 results; say so rather than looking broken. */
const RESULT_CAP = 1000;

/**
 * Results per API call.
 *
 * 100 is the maximum the search API allows and would reach the same 1,000
 * results in 10 requests instead of 25. It is not used, because the number of
 * pages and the page size are not independent: GitHub serves page N only while
 * its first result falls inside the first 1,000, i.e. (page - 1) * per_page is
 * under 1,000. At 100 that caps the pager at 10 pages; at 40 it reaches 25.
 *
 * Forty-one is the largest page size that still allows a 25th page, but it would
 * leave that last page holding 16 results rather than 40, so 40 is used and every
 * page is the same size.
 */
const PER_PAGE = 40;

/**
 * Pages reachable per search. Not a free choice: it is the largest N for which
 * (N - 1) * PER_PAGE still sits under GitHub's 1,000-result ceiling, so this and
 * PER_PAGE are two views of the same limit. Twenty-five pages of forty still
 * reach exactly 1,000 results. Page 26 would begin at result 1,000, and GitHub
 * answers that with HTTP 422, "Only the first 1000 search results are
 * available".
 *
 * Twenty-five rather than ten because a pager the reader can stop partway through
 * is worth more than a longer one they cannot, and 40 results a page means less
 * scrolling to reach the same place. The cost is real: reaching the end costs 25
 * requests instead of 10, against a budget shared by every visitor.
 */
const MAX_PAGES = 25;

const API = "https://api.github.com/search/repositories";

/**
 * The optional edge worker, read from a meta tag so hosting can change without
 * touching this file.
 *
 * Why it is optional rather than hard-coded
 * ----------------------------------------
 * This project is served from *.github.io, which Cloudflare cannot sit in front
 * of, so the worker necessarily lives on its own hostname and is called
 * cross-origin. Until that hostname exists there is nothing to call, so the
 * direct path has to stay fully working on its own: if the meta tag is absent,
 * or the worker is unreachable, this module quietly talks to GitHub itself.
 */
const EDGE_META = "ghindex-edge";

/** The configured edge endpoint, or null when there is none. */
  export function edgeEndpoint() {
    if (typeof document === "undefined") return null;
    const el = document.querySelector(`meta[name="${EDGE_META}"]`);
    const url = el && el.getAttribute("content");
    if (!url) return null;
    /**
     * HTTPS everywhere, with one deliberate exception: loopback over plain HTTP.
     *
     * The worker holds a GitHub token and returns public search data, but it is
     * still a server-side endpoint and should not be reachable in the clear. That
     * reasoning does not apply to 127.0.0.1, and excluding it would make it
     * impossible to run the whole site — including the liveness badges, which need
     * a worker and so silently disappear — against a worker on the developer's own
     * machine. That is the case the browser suite exercises.
     *
     * The exception is by host, not by prefix, so `http://example.com` is still
     * refused and a hostile meta value cannot talk this into plaintext.
     */
    const loopback = /^https?:\/\/(?:127\.0\.0\.1|localhost|\[::1\])(?::\d+)?(?:\/|$)/;
    if (!/^https:\/\//.test(url) && !loopback.test(url)) return null;
    return url.replace(/\/+$/, "");
  }

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
/** Exposed so the results summary can offset by the real page size. */
export const PER_PAGE_FOR_TEST = PER_PAGE;
export const pageUrlForTest = pageUrl;

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
/** Read the search rate-limit reset, if the response carries one. */
function resetSeconds(res) {
  const reset = Number(res.headers.get("x-ratelimit-reset") || 0);
  return reset ? Math.max(1, Math.ceil((reset * 1000 - Date.now()) / 1000)) : 60;
}

/**
 * Build the request for one page of results.
 *
 * Two shapes, because the two upstreams are not the same thing:
 *
 *   - direct: the full GitHub query string, built here, with an optional
 *     visitor-supplied bearer token.
 *   - edge:   the raw user text only, because the worker appends
 *     `in:name,description,readme` itself. Sending the pre-built query would
 *     duplicate that qualifier and GitHub would reject it.
 */
function pageUrl(input, page, edge, sort) {
// "best" is GitHub's default relevance ranking, which it applies when no sort
// qualifier is sent. "stars" is the explicit most-stars-first ordering, and
// "updated" is most-recently-pushed-first.
//
// "updated" gets no `order` qualifier, matching the worker: GitHub's repository
// search already treats it as descending, and measured against the query this
// site sends its first page holds repos pushed seconds apart, which is the
// live tail rather than a snapshot. Adding order=desc is accepted but is not
// what produces that ordering.
const sortClause = sort === "stars" ? "&sort=stars&order=desc" : sort === "updated" ? "&sort=updated" : "";
if (edge) {
// sort is always sent, including for relevance.
//
// Omitting it made the relevance request byte-identical to the one the
// worker used to send while it hard-coded star sorting. Any HTTP cache keyed
// on the URL — the browser, Cloudflare, anything in between — could therefore
// hand a star-sorted body back for a relevance request, and nothing on the
// receiving end could tell the difference. Naming the ordering explicitly
// means a relevance request can never be answered from a star-sorted entry,
// however stale it is.
//
// The three values are sent as themselves rather than folded down to
// best/stars, so each ordering gets its own cache entry and a "recently
// updated" request can never be served from a relevance one.
return (
`${edge}/api/search?q=${encodeURIComponent(String(input).trim())}` +
`&page=${page}&per_page=${PER_PAGE}&sort=${sort}`
);
}
return (
`${API}?q=${encodeURIComponent(buildQuery(input))}` +
`&per_page=${PER_PAGE}${sortClause}&page=${page}`
);
}

/**
 * Fetch one page of results.
 *
 * Returns a discriminated result rather than throwing so the caller can decide
 * whether a mid-pagination rate limit is fatal (nothing found) or partial
 * (keep what we already have).
 */
async function fetchPage(input, page, opts, edge, sort) {
  const headers = { Accept: "application/vnd.github+json" };
  if (edge) {
    // No token, and none needed: the worker holds the credential server-side.
  } else {
    headers["X-GitHub-Api-Version"] = "2022-11-28";
    if (opts.token) headers.Authorization = `Bearer ${opts.token}`;
  }

  const res = await fetch(pageUrl(input, page, edge, sort), {
    headers,
    signal: opts.signal,
  });

  /**
   * A worker that is down must not take search with it. Fall back to talking to
   * GitHub directly for this page, which restores the visitor's own IP-based
   * budget rather than leaving them with nothing.
   */
  if (edge && (res.status >= 500 || res.status === 404)) {
    return fetchPage(input, page, { ...opts, _retried: true }, null, sort);
  }

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
 * How many pages of results exist for a query.
 *
 * GitHub reports a `total_count` that can be in the millions while refusing to
 * serve past 1,000 results, so the honest number is the reachable one: ten pages
 * of a hundred. Everything else is unreachable, and saying so is more useful than
 * a page count that implies browsing further would find something new.
 */
export function pageCount(total) {
  const t = Number(total) || 0;
  if (t <= 0) return 0;
  return Math.min(MAX_PAGES, Math.ceil(t / PER_PAGE));
}

/**
 * Search GitHub for Pages-enabled repositories: exactly one page of results.
 *
 * Why one page, not "everything so far"
 * -----------------------------------
 * This used to walk pages 1..N and return the union, so the page could ask for
 * "page 3" by requesting 3 pages and being handed 3 again. On a rate limit
 * shared by every visitor that is the whole budget: reaching page 3 cost three
 * requests, and clicking again cost three more, because pages 1 and 2 were
 * refetched to rebuild a list the reader already had.
 *
 * Pagination asks for the page it is going to show and nothing else. Going to
 * page 4 costs one request, the same as arriving on page 1, which is what makes
 * the control honest about what it spends.
 *
 * @param {string} input free text from the user
 * @param {{token?: string, signal?: AbortSignal, page?: number}} [opts]
 * @returns {Promise<{query:string, results:Array, total:number, page:number,
 *                    pages:number, truncated:boolean, partial?:string, error?:string}>}
 */
export async function searchGitHub(input, opts = {}) {
  const q = buildQuery(input);
  const page = Math.max(1, Math.min(MAX_PAGES, opts.page ?? 1));
  // Relevance first. It is what GitHub ranks by when asked for nothing in
  // particular, which is what a typed query means; sorting by stars instead
  // buries the thing that matched under every popular repo that also matched.
  //
  // The three orderings answer three different questions and none of them
  // subsumes another: "best" finds the repo you half-remember, "stars" finds
  // the well-known one, and "updated" finds what someone deployed minutes ago.
  // That last one is the one a visitor arrives with when they do not yet know
  // what they are looking for, which is why it is offered rather than derived.
  const sort = opts.sort === "stars" || opts.sort === "updated" ? opts.sort : "best";
  const empty = { query: input, results: [], total: 0, page, pages: 0, truncated: false, sort };
  if (!q) return empty;

  const edge = opts._retried ? null : edgeEndpoint();

  let res;
  try {
    res = await fetchPage(input, page, opts, edge, sort);
  } catch (err) {
    if (err && err.name === "AbortError") throw err;
    const partial = `Could not reach GitHub (${String(err).slice(0, 60)}).`;
    return { ...empty, partial, error: partial };
  }

  if (res.kind === "rate-limited") {
    const partial =
      `GitHub's public search limit resets in ${res.wait}s. ` +
      `Add a read-only token for a higher limit, or try again shortly.`;
    return { ...empty, partial, error: partial };
  }
  if (res.kind === "error") {
    return { ...empty, partial: res.message, error: res.message };
  }

  const results = [];
  const seen = new Set();
  for (const item of res.items) {
    const row = toResult(item);
    if (!row || seen.has(row.full_name)) continue;
    seen.add(row.full_name);
    results.push(row);
  }
  // Deliberately not re-sorted here. Sorting the filtered rows by stars
  // client-side threw away GitHub's ordering entirely, so "best match" and "most
  // stars" produced the same list and the control would have been a lie. GitHub
  // already sorts by stars when asked to; in relevance mode its ranking is the
  // answer, and filtering out repos without Pages sites preserves that order.
  return {
    query: input,
    results,
    sort,
    total: res.total,
    page,
    pages: pageCount(res.total),
    truncated: res.total >= RESULT_CAP,
  };
}

/**
 * Ask the edge whether a real-time result is actually serving.
 *
 * This is the one thing the browser genuinely cannot do. GitHub's API reports
 * that a repository *has* Pages enabled, which is a repository setting and can
 * be weeks out of date with reality. The site's own liveness pass covers the
 * curated index, but these results are outside it, so without a server they can
 * only ever be shown as unconfirmed.
 *
 * From the worker there is no CORS restriction, so a real HEAD can be made and
 * the answer is honest. Returns null when no edge is configured or the check
 * cannot be completed, so callers can treat null as "still unknown" rather than
 * as "dead".
 */
export async function verifyLiveness(url, opts = {}) {
  const edge = edgeEndpoint();
  if (!edge) return null;
  try {
    const res = await fetch(`${edge}/api/live?u=${encodeURIComponent(url)}`, {
      signal: opts.signal,
    });
    if (!res.ok) return null;
    const body = await res.json();
    return typeof body.alive === "boolean" ? body : null;
  } catch {
    // An unreachable worker is not evidence that a site is dead.
    return null;
  }
}

/**
 * Check several sites in one request, for a page that is already on screen.
 *
 * A result list can show dozens of rows. Asking about each one separately would
 * be dozens of Worker invocations, each of which would then be a cold cache
 * entry for the next visitor as well. One batch is one request and warms the
 * same per-URL cache entries, so the second person to load the page gets hits.
 *
 * The worker applies stricter limits here than to the single-URL endpoint, since
 * a page naming many hosts is the shape that could be turned into a fan-out over
 * other people's servers. Those limits are the worker's, not the caller's, and
 * exceeding them returns a 403 which surfaces below as "no answers" rather than
 * as any claim about the sites.
 *
 * Returns a Map of url -> verdict. A missing url means "not checked", which is
 * never the same as "dead".
 */
export async function verifyLivenessBatch(urls, opts = {}) {
  const edge = edgeEndpoint();
  const out = new Map();
  const list = (urls ?? []).filter((u) => typeof u === "string" && u);
  if (!edge || !list.length) return out;
  try {
    const res = await fetch(
      `${edge}/api/live/batch?u=${encodeURIComponent(list.join(","))}`,
      { signal: opts.signal },
    );
    if (!res.ok) return out;
    const body = await res.json();
    for (const [url, verdict] of Object.entries(body?.results ?? {})) {
      if (verdict && typeof verdict.verdict === "string") out.set(url, verdict);
    }
  } catch {
    // No answers is fine; the cards fall back to the offline probe date.
  }
  return out;
}
