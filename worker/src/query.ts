/**
 * Query normalisation and cache keys for the search worker.
 *
 * Kept free of any Cloudflare imports so the unit tests can load it with plain
 * Bun, and so the same normalisation logic is testable without a live cache.
 *
 * Why normalisation matters here
 * ------------------------------
 * The whole reason this worker exists is that its cache turns a per-visitor
 * rate limit into a shared one. That only works if two people typing the same
 * thing collide on the same cache entry. Without normalisation,
 * "portfolio", "Portfolio", "portfolio " and "portfolio%20" are four distinct
 * keys, four upstream requests, and a cache that appears to work while never
 * actually hitting. Normalising is what makes the hit rate reflect reality.
 */

/** Collapse whitespace, trim, and lowercase: the query text a human means. */
export function normalizeQuery(raw: string): string {
  return String(raw ?? "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

/** Clamp a page number into the range GitHub will actually serve. */
export function clampPage(raw: string | null): number {
  const n = Number.parseInt(String(raw ?? "1"), 10);
  if (!Number.isFinite(n) || n < 1) return 1;
  // GitHub returns HTTP 422 for page 11 of a search, so never ask for one.
  return Math.min(n, 10);
}

/** Clamp per_page into the 1..100 the search API accepts. */
export function clampPerPage(raw: string | null): number {
  const n = Number.parseInt(String(raw ?? "100"), 10);
  if (!Number.isFinite(n) || n < 1) return 100;
  return Math.min(n, 100);
}

/**
 * Build the cache key for a search request.
 *
 * Only the three meaningful parameters survive, in a fixed order, so a client
 * that sends them in a different order or adds tracking noise still hits the
 * same entry. Page and per_page are coerced through the clamps first, otherwise
 * "?page=01" and "?page=1" would cache separately.
 */
export function searchCacheKey(url: URL): string {
  const u = new URL(url.origin);
  u.pathname = "/api/search";
  u.searchParams.set("q", normalizeQuery(url.searchParams.get("q")));
  u.searchParams.set("page", String(clampPage(url.searchParams.get("page"))));
  u.searchParams.set("per_page", String(clampPerPage(url.searchParams.get("per_page"))));
  return u.toString();
}

/**
 * Whether a URL is one this worker is allowed to probe.
 *
 * The liveness endpoint fetches a URL on behalf of whoever calls it, which is
 * the shape of a server-side request forgery bug: with no restriction, this
 * worker would happily fetch internal addresses for an attacker. The allowlist
 * is therefore narrow on purpose. This project only ever indexes GitHub Pages,
 * so anything that is not a github.io host is refused rather than fetched.
 */
export function isProbeAllowed(raw: string): boolean {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return false;
  }
  if (u.protocol !== "https:") return false;
  const host = u.hostname.toLowerCase();
  if (host === "github.io") return false;
  if (!host.endsWith(".github.io")) return false;
  // Credentials in a URL are never legitimate here and are a classic way to
  // make a request look like it is going somewhere it is not.
  if (u.username || u.password) return false;
  return true;
}

/**
 * Hosts that serve many independent sites, so a per-user host budget is enough.
 *
 * Split into two lists on purpose, because conflating them is a trap:
 *
 * - `github.io` is shared only as the bare apex. Its *subdomains* are the
 *   individual personal sites this index is made of, so they must not be
 *   swept in. Matching them by suffix would refuse the entire corpus, which is
 *   the opposite of the intent.
 * - `pages.github.io` is one shared host by name.
 * - `github.com` and `githubusercontent.com` are shared as whole domains, and
 *   matching subdomains does matter there: an exact-match set quietly lets
 *   `raw.githubusercontent.com` through the thing it was excluded for.
 */
export const PROBE_SHARED_HOSTS: ReadonlySet<string> = new Set([
  "github.io",
  "pages.github.io",
]);

/** Domains where every subdomain is equally shared. */
export const PROBE_SHARED_DOMAINS: ReadonlySet<string> = new Set([
  "github.com",
  "githubusercontent.com",
]);

/** Distinct hosts a single caller may probe through the shared endpoint. */
export const PROBE_MAX_HOSTS = 6;

/**
 * Count the distinct hosts a caller is asking about, and return them.
 *
 * Malformed entries are skipped rather than rejected: the caller is a browser
 * rendering a list, so one bad URL in a thousand should not throw away the rest.
 */
export function probeHosts(urls: string[]): Set<string> {
  const hosts = new Set<string>();
  for (const raw of urls) {
    let u: URL;
    try {
      u = new URL(raw);
    } catch {
      continue;
    }
    hosts.add(u.hostname.toLowerCase());
  }
  return hosts;
}

/**
 * Whether a host is shared: the bare apex, a named shared host, or any
 * subdomain of a wholly shared domain.
 */
function isSharedHost(host: string): boolean {
  if (PROBE_SHARED_HOSTS.has(host)) return true;
  for (const d of PROBE_SHARED_DOMAINS) {
    if (host === d || host.endsWith(`.${d}`)) return true;
  }
  return false;
}

/**
 * Whether a batch of URLs may be proxied, as a page of results rather than as
 * one deliberate check.
 *
 * A caller is refused once it exceeds the host budget, or names a shared host at
 * all. Everything else is left to the per-URL allowlist in `isProbeAllowed`.
 */
export function probeBatchAllowed(urls: string[]): boolean {
  const hosts = probeHosts(urls);
  if (hosts.size === 0) return true;
  if (hosts.size > PROBE_MAX_HOSTS) return false;
  for (const h of hosts) if (isSharedHost(h)) return false;
  return true;
}
