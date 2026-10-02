/**
 * Edge search worker for ghindex.
 *
 * The problem it solves
 * ---------------------
 * Browsers cannot hold a GitHub token. Anything embedded in this project's
 * static files is public, so the only options were a private token typed in by
 * each visitor, or no token at all.
 *
 * Baking a token into the page would have been worse than useless, not merely
 * unsafe. Measured on the live API:
 *
 *   - unauthenticated search: X-RateLimit-Limit: 10 per minute, keyed to IP
 *   - authenticated search:   30 per minute, keyed to the token
 *
 * Today every visitor spends 10/minute out of their *own* IP bucket, so the
 * budget is per-person and nothing shared. One site-wide token would collapse
 * that into a single 30/minute bucket shared by every visitor, which two people
 * typing at the same moment would already exhaust. It trades a private quota
 * for a contended global one.
 *
 * So the token lives here, on the server, and never reaches a browser. What
 * makes that an improvement rather than a lateral move is the cache: responses
 * are cached at the edge, so the second person to search "portfolio" costs zero
 * upstream requests, and popular terms converge on a single GitHub call per
 * cache lifetime. The visitor-facing limit stops being the binding constraint.
 *
 * A second, quieter win: this worker can verify that a site is actually alive.
 * A browser cannot, because a cross-origin HEAD to some other user's site
 * returns an opaque response under CORS. From the server there is no such
 * restriction, so real-time results can finally be labelled verified or dead
 * rather than always "unknown".
 *
 * Hosting note
 * ------------
 * This cannot be routed in front of *.github.io. That domain is served by
 * GitHub, so Cloudflare never sees the traffic and cannot intercept it. It is
 * therefore reached on its own workers.dev hostname (or a custom domain, if
 * the project is ever moved off GitHub Pages), called cross-origin from the
 * page. The responses are public search data, so the CORS policy below is
 * deliberately permissive.
 */

import {
  clampPage,
  clampPerPage,
  isProbeAllowed,
  normalizeQuery,
  searchCacheKey,
} from "./query.ts";

/** How long the edge holds a response before it must be refetched. */
const HARD_TTL_SECONDS = 3600;

/**
 * How long a cached response is served without revalidating.
 *
 * A hit inside this window is returned immediately with no upstream call. Past
 * it the response is still returned, but a refresh is started in the
 * background, so a popular term degrades into "slightly stale for one visitor"
 * rather than "a GitHub request for every visitor".
 */
const SOFT_TTL_SECONDS = 600;

const LIVENESS_TTL_ALIVE = 86400;
const LIVENESS_TTL_DEAD = 3600;

const JSON_HEADERS = {
  "content-type": "application/json; charset=utf-8",
  // Public, immutable-ish search data. Wide CORS is intentional: the payload
  // is public GitHub metadata and nothing here is user-specific.
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET, OPTIONS",
  "access-control-expose-headers": "x-cache, x-gh-authed",
};

const GITHUB_API = "https://api.github.com/search/repositories";

/** CORS preflight, and a cheap way for the page to discover the worker. */
function healthResponse(env: Record<string, unknown>): Response {
  return new Response(
    JSON.stringify({
      ok: true,
      // A boolean, never the token itself. The page uses this to decide
      // whether the shared path is available at all.
      authed: Boolean(env.GITHUB_TOKEN),
      limitPerMinute: env.GITHUB_TOKEN ? 30 : 10,
    }),
    { headers: JSON_HEADERS },
  );
}

/**
 * Proxy one page of GitHub search, cached at the edge.
 *
 * Returns the upstream body with an extra `_cache` field describing where it
 * came from. The shape is otherwise untouched, because the browser module
 * already knows how to parse GitHub search results and duplicating that parsing
 * here would mean two copies to keep in step.
 */
async function handleSearch(
  url: URL,
  env: Record<string, unknown>,
  cache: Cache | null,
  ctx: { waitUntil(p: Promise<unknown>): void } | null,
): Promise<Response> {
  const q = normalizeQuery(url.searchParams.get("q") ?? "");
  if (!q) {
    return new Response(
      JSON.stringify({ error: "missing q", total_count: 0, items: [] }),
      { status: 400, headers: JSON_HEADERS },
    );
  }

  const key = searchCacheKey(url);
  const cached = cache ? await cache.match(new Request(key)) : null;

  if (cached) {
    const body = await cached.json();
    const age = Math.max(0, Math.round(Date.now() / 1000) - (body?._cache?.cachedAt ?? 0));
    const fresh = age < SOFT_TTL_SECONDS;
    if (!fresh && ctx) {
      // Stale-while-revalidate: hand back what we have, refresh behind it.
      const refresh = refreshSearch(key, q, url, env).then(
        (res) => res && cache && cache.put(new Request(key), res.clone()),
      );
      ctx.waitUntil(refresh);
    }
    return new Response(
      JSON.stringify({
        ...body,
        _cache: { ...body._cache, age, fresh, source: fresh ? "hit" : "stale" },
      }),
      { headers: { ...JSON_HEADERS, "x-cache": fresh ? "HIT" : "STALE", "x-gh-authed": String(Boolean(env.GITHUB_TOKEN)) } },
    );
  }

  const upstream = await refreshSearch(key, q, url, env);
  if (!upstream) {
    return new Response(
      JSON.stringify({ error: "github unreachable", total_count: 0, items: [] }),
      { status: 502, headers: { ...JSON_HEADERS, "x-cache": "MISS" } },
    );
  }

  // A rate-limited or failed upstream must not be cached, or the worker would
  // replay its own failure to every visitor until the TTL expired.
  if (upstream.status === 200 && cache) {
    ctx?.waitUntil(cache.put(new Request(key), upstream.clone()));
  }
  return new Response(upstream.body, { status: upstream.status, headers: upstream.headers });
}

/**
 * Perform the actual upstream call and wrap it with provenance metadata.
 *
 * If GitHub rejects the token with a 401, the call is retried once without it.
 * A misconfigured secret should degrade the shared budget from 30/min to 10/min,
 * not take search offline for every visitor, and the response says plainly that
 * it did so rather than failing quietly.
 */
async function refreshSearch(
  key: string,
  q: string,
  url: URL,
  env: Record<string, unknown>,
  retryAfterRejection = false,
): Promise<Response | null> {
  const page = clampPage(url.searchParams.get("page"));
  const perPage = clampPerPage(url.searchParams.get("per_page"));

  const headers: Record<string, string> = {
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    // GitHub rejects API requests with no User-Agent, and Workers do not set a
    // useful one by default.
    "User-Agent": "ghindex-edge",
  };
  const withToken = Boolean(env.GITHUB_TOKEN) && !retryAfterRejection;
  if (withToken) headers.Authorization = `Bearer ${env.GITHUB_TOKEN}`;

  const target =
    `${GITHUB_API}?q=${encodeURIComponent(`${q} in:name,description,readme`)}` +
    `&per_page=${perPage}&sort=stars&order=desc&page=${page}`;

  let res: Response;
  try {
    res = await fetch(target, { headers });
  } catch {
    return null;
  }

  if (res.status === 401 && withToken) {
    // The secret is present but unusable: expired, revoked, mistyped, or pasted
    // with surrounding quotes. Serve results anyway rather than serving nothing.
    // `withToken` is false on the retry, so this cannot recurse.
    return refreshSearch(key, q, url, env, true);
  }

  if (res.status !== 200) {
    const reset = Number(res.headers.get("x-ratelimit-reset") || 0);
    const limited = res.status === 403 || res.status === 429;
    const wait = limited
      ? reset
        ? Math.max(1, Math.ceil((reset * 1000 - Date.now()) / 1000))
        : 60
      : 0;
    /**
     * GitHub's own message is echoed because it is the difference between "rate
     * limited, wait" and "your secret is broken", and those need completely
     * different fixes. It contains no credential material.
     */
    const detail = await res
      .clone()
      .json()
      .then((b: Record<string, unknown>) => String(b?.message ?? ""))
      .catch(() => "");
    return new Response(
      JSON.stringify({
        error: res.status === 401 ? "bad-token" : limited ? "rate-limited" : "github-error",
        status: res.status,
        wait,
        detail: detail.slice(0, 120),
        total_count: 0,
        items: [],
      }),
      {
        status: res.status,
        headers: {
          ...JSON_HEADERS,
          "cache-control": "no-store",
          "x-cache": "MISS",
          "x-gh-authed": String(Boolean(env.GITHUB_TOKEN)),
        },
      },
    );
  }

  const body = (await res.json()) as Record<string, unknown>;
  const payload = {
    ...body,
    _cache: {
      cachedAt: Math.round(Date.now() / 1000),
      source: "miss",
      key,
      authed: withToken,
      // Surfaced so a silent downgrade to anonymous is visible rather than
      // looking like normal behaviour.
      ...(retryAfterRejection ? { degraded: "token-rejected" } : {}),
    },
  };
  return new Response(JSON.stringify(payload), {
    status: 200,
    headers: {
      ...JSON_HEADERS,
      // Long max-age, because freshness is judged against the embedded
      // timestamp rather than by the cache expiring underneath us.
      "cache-control": `public, max-age=${HARD_TTL_SECONDS}`,
      "x-cache": "MISS",
      "x-gh-authed": String(withToken),
    },
  });
}

/**
 * Check whether one GitHub Pages URL is actually serving.
 *
 * Only github.io hosts are accepted; see isProbeAllowed for why that
 * restriction is load-bearing rather than cosmetic.
 */
async function handleLive(
  url: URL,
  cache: Cache | null,
  ctx: { waitUntil(p: Promise<unknown>): void } | null,
): Promise<Response> {
  const target = url.searchParams.get("u") ?? "";
  if (!isProbeAllowed(target)) {
    return new Response(
      JSON.stringify({ error: "not a github.io url", allowed: "*.github.io over https only" }),
      { status: 400, headers: { ...JSON_HEADERS, "cache-control": "no-store" } },
    );
  }

  const key = `https://ghindex.internal/live?u=${encodeURIComponent(target)}`;
  const cached = cache ? await cache.match(new Request(key)) : null;
  if (cached) {
    return new Response(cached.body, {
      headers: { ...cached.headers, "x-cache": "HIT" },
    });
  }

  const result = await probe(target);
  const out = new Response(JSON.stringify(result), {
    headers: {
      ...JSON_HEADERS,
      "cache-control": `public, max-age=${result.alive ? LIVENESS_TTL_ALIVE : LIVENESS_TTL_DEAD}`,
      "x-cache": "MISS",
    },
  });
  if (cache) ctx?.waitUntil(cache.put(new Request(key), out.clone()));
  return out;
}

/**
 * One liveness probe.
 *
 * HEAD is tried first because it transfers no body. A minority of static hosts
 * answer HEAD with 405 even though GET works fine, so that specific failure
 * falls back to a ranged GET rather than being recorded as a dead site.
 */
async function probe(target: string): Promise<Record<string, unknown>> {
  const checkedAt = new Date().toISOString();
  const attempt = async (method: "HEAD" | "GET") => {
    try {
      return await fetch(target, {
        method,
        redirect: "follow",
        signal: AbortSignal.timeout(6000),
        headers: method === "GET" ? { Range: "bytes=0-0" } : {},
      });
    } catch (err) {
      return { failed: String(err) } as unknown as Response;
    }
  };

  let res = await attempt("HEAD");
  let fellBack = false;
  const unusable =
    res instanceof Response && (res.status === 405 || res.status === 501);
  if (unusable) {
    fellBack = true;
    res = await attempt("GET");
  }

  if (!(res instanceof Response)) {
    return { url: target, alive: false, status: 0, error: "unreachable", checkedAt };
  }
  return {
    url: target,
    alive: res.ok,
    status: res.status,
    viaHead: !fellBack,
    checkedAt,
  };
}

/**
 * The worker entrypoint.
 *
 * `handleRequest` takes its cache and context as arguments rather than reaching
 * for the Cloudflare globals, so the tests can drive the real routing, caching
 * and rate-limit paths with a stub cache and a stubbed upstream fetch, without
 * a Wrangler dev server.
 */
export async function handleRequest(
  request: Request,
  env: Record<string, unknown>,
  cache: Cache | null,
  ctx: { waitUntil(p: Promise<unknown>): void } | null,
): Promise<Response> {
  const url = new URL(request.url);

  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: JSON_HEADERS });
  }
  if (request.method !== "GET" && request.method !== "HEAD") {
    return new Response(JSON.stringify({ error: "method not allowed" }), {
      status: 405,
      headers: { ...JSON_HEADERS, allow: "GET, HEAD, OPTIONS" },
    });
  }

  switch (url.pathname) {
    case "/api/health":
      return healthResponse(env);
    case "/api/search":
      return handleSearch(url, env, cache, ctx);
    case "/api/live":
      return handleLive(url, cache, ctx);
    default:
      return new Response(JSON.stringify({ error: "not found" }), {
        status: 404,
        headers: { ...JSON_HEADERS },
      });
  }
}

export default {
  fetch(request: Request, env: Record<string, unknown>, ctx: ExecutionContext) {
    // caches.default is the per-datacentre cache; null just disables caching,
    // which is the correct degraded behaviour rather than an error.
    const cache = typeof caches !== "undefined" ? caches.default : null;
    return handleRequest(request, env, cache ?? null, ctx);
  },
};
