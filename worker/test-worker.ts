/**
 * Worker tests.
 *
 * These drive the real routing, caching and rate-limit paths through
 * handleRequest with a stub cache and a stubbed upstream fetch. Nothing here
 * touches the network, so no test spends GitHub rate limit and no test needs a
 * Wrangler dev server.
 */

import {
  clampPage,
  clampPerPage,
  isProbeAllowed,
  normalizeQuery,
  searchCacheKey,
} from "./src/query.ts";
import { handleRequest, __clearMemo } from "./src/index.ts";

let fail = 0;
const eq = (name: string, got: string, want: string) => {
  const ok = got === want;
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}`);
  if (!ok) {
    console.log(`        got:  ${got}`);
    console.log(`        want: ${want}`);
    fail++;
  }
};
const check = (name: string, ok: boolean, detail = "") => {
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}`);
  if (!ok) {
    if (detail) console.log(`        ${detail}`);
    fail++;
  }
};

// ---------------------------------------------------------------- fake cache

/** Minimal Cache API stand-in: a Map, plus the response text for assertions. */
function fakeCache() {
  const store = new Map<string, string>();
  let puts = 0;
  const cache = {
    async match(req: Request) {
      const key = typeof req === "string" ? req : req.url;
      const body = store.get(key);
      return body === undefined ? undefined : new Response(body, { status: 200 });
    },
    async put(req: Request, res: Response) {
      puts++;
      store.set(typeof req === "string" ? req : req.url, await res.text());
    },
  } as unknown as Cache;
  return { cache, store, puts: () => puts };
}

/** Collects waitUntil() work so tests can await background refreshes. */
function fakeCtx() {
  const pending: Promise<unknown>[] = [];
  return {
    ctx: { waitUntil: (p: Promise<unknown>) => { pending.push(p); } },
    drain: () => Promise.all(pending),
  };
}

// ------------------------------------------------------------- upstream stub

const realFetch = globalThis.fetch;

let ghCalls = 0;
__clearMemo();
let lastAuth: string | null = null;

function stubGithub(handler: (url: URL) => Response) {
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    if (url.hostname !== "api.github.com") return realFetch(input, init);
    ghCalls++;
    lastAuth = (init?.headers as Record<string, string>)?.Authorization ?? null;
    return handler(url);
  }) as typeof fetch;
}

const ghOk = (items: unknown[], total = 1000) =>
  new Response(JSON.stringify({ total_count: total, items }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });

const call = (
  url: string,
  env: Record<string, unknown> = {},
  cache: Cache | null = null,
  ctx: ReturnType<typeof fakeCtx>["ctx"] | null = null,
) => handleRequest(new Request(`https://edge.test${url}`), env, cache, ctx);

// ============================================================ normalisation

console.log("=== query normalisation ===");
eq("case folded", normalizeQuery("  Portfolio "), "portfolio");
eq("inner whitespace collapsed", normalizeQuery("expense   tracker"), "expense tracker");
eq("empty stays empty", normalizeQuery("   "), "");

const key = (qs: string) => searchCacheKey(new URL(`https://e.test${qs}`));
eq(
  "case and padding collide on one cache entry",
  key("/api/search?q=Portfolio") + key("/api/search?q=%20%20portfolio%20"),
  key("/api/search?q=portfolio") + key("/api/search?q=portfolio"),
);
eq(
  "param order does not matter",
  key("/api/search?per_page=50&page=2&q=x"),
  key("/api/search?q=x&page=2&per_page=50"),
);
eq(
  "page=01 and page=1 collide",
  key("/api/search?q=x&page=01"),
  key("/api/search?q=x&page=1"),
);
check("different queries still differ", key("/api/search?q=a") !== key("/api/search?q=b"));
check("unknown params are dropped", !key("/api/search?q=x&utm_source=t").includes("utm_source"));

eq("page clamps to 1", String(clampPage("0")), "1");
eq("page clamps to 10", String(clampPage("11")), "10");
eq("page rejects junk", String(clampPage("abc")), "1");
eq("per_page clamps to 100", String(clampPerPage("500")), "100");
eq("per_page defaults to 100", String(clampPerPage(null)), "100");

// ================================================================= SSRF

console.log("=== probe allowlist (SSRF guard) ===");
check("github.io subdomain allowed", isProbeAllowed("https://someone.github.io/site/"));
check("apex user page allowed", isProbeAllowed("https://someone.github.io/"));
check("http rejected", !isProbeAllowed("http://someone.github.io/"));
check("loopback rejected", !isProbeAllowed("http://127.0.0.1/"));
check("internal metadata host rejected", !isProbeAllowed("http://169.254.169.254/"));
check("non-github host rejected", !isProbeAllowed("https://evil.example.com/"));
check("lookalike host rejected", !isProbeAllowed("https://github.io.evil.com/"));
check("bare github.io rejected", !isProbeAllowed("https://github.io/"));
check("embedded credentials rejected", !isProbeAllowed("https://a@someone.github.io/"));
check("junk rejected", !isProbeAllowed("not a url"));

// ============================================================== caching

console.log("=== cache absorbs repeat queries ===");
ghCalls = 0;
__clearMemo();
stubGithub(() => ghOk([{ full_name: "a/b", has_pages: true }], 4321));
{
  const { cache, store } = fakeCache();
  const { ctx, drain } = fakeCtx();

  const first = await call("/api/search?q=portfolio", { GITHUB_TOKEN: "t" }, cache, ctx);
  await drain();
  const b1 = (await first.json()) as any;

  eq("first request is a miss", first.headers.get("x-cache") ?? "HIT", "MISS");
  eq("one upstream call for the first request", String(ghCalls), "1");
  check("total_count passed through", b1.total_count === 4321);
  check("cache entry written", store.size === 1, `store size ${store.size}`);

  const second = await call("/api/search?q=Portfolio", { GITHUB_TOKEN: "t" }, cache, ctx);
  await drain();
  const b2 = (await second.json()) as any;
  const tier = second.headers.get("x-cache") ?? "";

  check("differently-cased repeat is served from a cache tier",
    tier === "MEMO" || tier === "HIT", `got ${tier}`);
  eq("repeat costs no upstream call", String(ghCalls), "1");

  // The isolate tier answers first when it is warm, so force the edge tier by
  // dropping the memo and asking again: this is what a request landing in a
  // different isolate sees.
  __clearMemo();
  const third = await call("/api/search?q=portfolio", { GITHUB_TOKEN: "t" }, cache, ctx);
  await drain();
  const b3 = (await third.json()) as any;
  eq("a cold isolate is served by the edge cache", third.headers.get("x-cache") ?? "", "HIT");
  eq("and still no upstream call", String(ghCalls), "1");
  check("edge hit reports its age", typeof b3._cache.age === "number", JSON.stringify(b3._cache));
  check("edge hit is marked fresh", b3._cache.fresh === true);
  void b2;
}

console.log("=== stale-while-revalidate ===");
__clearMemo();
{
  const { cache, store } = fakeCache();
  const { ctx, drain } = fakeCtx();
  await call("/api/search?q=portfolio", {}, cache, ctx);
  await drain();

  // Age the stored entry past the soft window without letting the cache expire.
  const k = [...store.keys()][0];
  const aged = JSON.parse(store.get(k) as string);
  aged._cache.cachedAt = Math.round(Date.now() / 1000) - 5000;
  store.set(k, JSON.stringify(aged));

  // Make the upstream hang forever. If the request path waited on it, this
  // call would never return, which is a stronger assertion than counting
  // fetches: it proves the visitor's response does not depend on GitHub at all.
  ghCalls = 0;
__clearMemo();
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    if (url.hostname === "api.github.com") {
      ghCalls++;
      return new Promise<Response>(() => {}); // never settles
    }
    return realFetch(input, init);
  }) as typeof fetch;

  const res = await call("/api/search?q=portfolio", {}, cache, ctx);
  const body = (await res.json()) as any;
  check("stale entry is served, not a miss", res.headers.get("x-cache") === "STALE", String(res.headers.get("x-cache")));
  check("stale is flagged not fresh", body._cache.fresh === false);
  check("response returned despite a hanging upstream", true);

  check("a refresh was started", ghCalls === 1, `upstream calls ${ghCalls}`);
  // Put a working fetch back; the hung one is left dangling deliberately.
  stubGithub(() => ghOk([{ full_name: "a/b", has_pages: true }]));
  eq("background refresh hit GitHub once", String(ghCalls), "1");
}

// ========================================================== rate limiting

console.log("=== rate limits are not cached ===");
ghCalls = 0;
__clearMemo();
let alwaysLimited = true;
stubGithub(() =>
  alwaysLimited
    ? new Response("no", { status: 403, headers: { "x-ratelimit-reset": String(Math.floor(Date.now() / 1000) + 30) } })
    : ghOk([]),
);
{
  const { cache, store } = fakeCache();
  const { ctx, drain } = fakeCtx();

  const res = await call("/api/search?q=portfolio", {}, cache, ctx);
  await drain();
  const body = (await res.json()) as any;

  eq("rate limit passes through as 403", String(res.status), "403");
  eq("body says rate-limited", String(body.error), "rate-limited");
  check("a wait hint is included", typeof body.wait === "number" && body.wait > 0);
  eq("nothing cached", String(store.size), "0");

  // The next visitor must retry rather than be handed the cached failure.
  alwaysLimited = false;
  const after = await call("/api/search?q=portfolio", {}, cache, ctx);
  await drain();
  eq("next visitor reaches GitHub again", String(ghCalls), "2");
  eq("and now succeeds", String(after.status), "200");
}

// ================================================================== token

console.log("=== token handling ===");
ghCalls = 0;
__clearMemo();
stubGithub(() => ghOk([]));
{
  const { cache } = fakeCache();
  const { ctx, drain } = fakeCtx();

  await call("/api/search?q=portfolio", { GITHUB_TOKEN: "secret-pat" }, cache, ctx);
  await drain();
  check("token is sent upstream as a bearer header", lastAuth === "Bearer secret-pat", String(lastAuth));

  const res = await call("/api/search?q=other", { GITHUB_TOKEN: "secret-pat" }, cache, ctx);
  const text = await res.text();
  check("token never appears in the response body", !text.includes("secret-pat"));
  check("token never appears in the response headers",
    ![...res.headers.values()].some((v) => String(v).includes("secret-pat")));
  check("client is told only whether a token exists", res.headers.get("x-gh-authed") === "true");

  lastAuth = null;
  await call("/api/search?q=third", {}, cache, ctx);
  await drain();
  check("no token means no Authorization header", lastAuth === null, String(lastAuth));
}

{
  const res = await call("/api/health", { GITHUB_TOKEN: "secret-pat" });
  const text = await res.text();
  const body = JSON.parse(text) as any;
  check("health reports authed true", body.authed === true);
  check("health reports the higher limit", body.limitPerMinute === 30, String(body.limitPerMinute));
  check("health does not echo the token", !text.includes("secret-pat"));

  const anon = await call("/api/health", {});
  const anonBody = (await anon.json()) as any;
  check("health without a token reports authed false", anonBody.authed === false);
  check("and the anonymous limit", anonBody.limitPerMinute === 10);
}

console.log("=== a rejected token degrades instead of failing ===");
ghCalls = 0;
__clearMemo();
/**
 * Behaves like the real API: a request carrying credentials is refused, a
 * request without them succeeds. A stub that 401'd everything would make the
 * retry look broken when it is the retry's whole point.
 */
stubGithub((_url) => {
  const hadToken = lastAuth !== null;
  return hadToken
    ? new Response(JSON.stringify({ message: "Bad credentials" }), { status: 401 })
    : ghOk([{ full_name: "a/b", has_pages: true }], 77);
});
{
  const { cache, store } = fakeCache();
  const { ctx, drain } = fakeCtx();

  const res = await call("/api/search?q=portfolio", { GITHUB_TOKEN: "broken-pat" }, cache, ctx);
  await drain();
  const body = (await res.json()) as any;

  eq("retried once without the token", String(ghCalls), "2");
  check("results still come back", body.total_count === 77, String(body.total_count));
  check("degradation is visible, not silent", body._cache?.degraded === "token-rejected", JSON.stringify(body._cache));
  check("reported as unauthenticated", body._cache?.authed === false);
  eq("response is a 200, not an error", String(res.status), "200");
  check("results are cached despite the downgrade", store.size === 1);
  check("the rejected token was never echoed", !(await (await call("/api/health", { GITHUB_TOKEN: "broken-pat" })).text()).includes("broken-pat"));
}

ghCalls = 0;
__clearMemo();
stubGithub(() => new Response(JSON.stringify({ message: "Bad credentials" }), { status: 401 }));
{
  // No token configured at all: nothing to retry, so the failure surfaces.
  const res = await call("/api/search?q=portfolio", {}, null, null);
  const body = (await res.json()) as any;
  eq("401 passthrough status", String(res.status), "401");
  eq("401 is not mislabelled as rate-limited", String(body.error), "bad-token");
  eq("no pointless wait hint", String(body.wait), "0");
  check("GitHub's own message is echoed", String(body.detail).includes("Bad credentials"), String(body.detail));
}

// ============================================================== liveness

console.log("=== liveness ===");
ghCalls = 0;
__clearMemo();
let probed: string[] = [];
globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = new URL(String(input));
  if (url.hostname.endsWith("github.io")) {
    probed.push(url.toString());
    const alive = !url.pathname.includes("dead");
    return new Response(null, { status: alive ? 200 : 404 });
  }
  return realFetch(input, init);
}) as typeof fetch;
{
  const { cache } = fakeCache();
  const { ctx, drain } = fakeCtx();

  const res = await call("/api/live?u=https://alive-user.github.io/site/", {}, cache, ctx);
  await drain();
  const body = (await res.json()) as any;
  check("live site reports alive", body.alive === true, JSON.stringify(body));
  check("status is carried through", body.status === 200);
  check("probed with HEAD", body.viaHead === true);
  check("timestamped", typeof body.checkedAt === "string");

  const dead = await call("/api/live?u=https://dead-user.github.io/dead/", {}, cache, ctx);
  await drain();
  check("dead site reports not alive", ((await dead.json()) as any).alive === false);

  const before = probed.length;
  await call("/api/live?u=https://alive-user.github.io/site/", {}, cache, ctx);
  eq("repeat probe served from cache", String(probed.length), String(before));

  const blocked = await call("/api/live?u=http://169.254.169.254/latest/meta-data", {}, cache, ctx);
  const n = probed.length;
  check("non-github.io host refused", blocked.status === 400, String(blocked.status));
  eq("and never fetched", String(probed.length), String(n));
  check("refusal explains the rule",
    ((await blocked.json()) as any).allowed?.includes("github.io") === true);
}

// ================================================================ routing

console.log("=== routing ===");
{
  const missing = await call("/api/search");
  eq("search without q is a 400", String(missing.status), "400");
  eq("health is public", String((await call("/api/health")).status), "200");
  eq("unknown path is a 404", String((await call("/api/nope")).status), "404");

  const post = await handleRequest(
    new Request("https://edge.test/api/search?q=x", { method: "POST" }),
    {}, null, null,
  );
  eq("POST is refused", String(post.status), "405");

  const opt = await handleRequest(
    new Request("https://edge.test/api/search?q=x", { method: "OPTIONS" }),
    {}, null, null,
  );
  eq("preflight succeeds", String(opt.status), "204");
  check("preflight allows cross-origin", opt.headers.get("access-control-allow-origin") === "*");
}

console.log("=== degraded mode ===");
{
  // No cache available at all (e.g. caches.default missing): must still work.
  ghCalls = 0;
__clearMemo();
  stubGithub(() => ghOk([{ full_name: "a/b", has_pages: true }]));
  const res = await call("/api/search?q=portfolio", {}, null, null);
  eq("serves without a cache", String(res.status), "200");
  eq("and still reached GitHub", String(ghCalls), "1");
  check("response carries provenance", typeof (res.json() as any).then === "function");
}

console.log("=== isolate memo (tier 1) ===");
ghCalls = 0;
__clearMemo();
stubGithub(() => ghOk([{ full_name: "a/b", has_pages: true }], 12));
{
  const { ctx, drain } = fakeCtx();

  // No cache at all: the memo is the only defence, so it has to work alone.
  const first = await call("/api/search?q=portfolio", {}, null, ctx);
  await drain();
  eq("first call reaches GitHub", String(ghCalls), "1");
  eq("and is a MISS", first.headers.get("x-cache") ?? "", "MISS");

  const second = await call("/api/search?q=portfolio", {}, null, ctx);
  await drain();
  eq("second call is served from the isolate", second.headers.get("x-cache") ?? "", "MEMO");
  eq("with no upstream call at all", String(ghCalls), "1");
  check("and returns the same body", ((await second.json()) as any).total_count === 12);

  // The memo is keyed the same way the edge cache is, so it normalises too.
  const third = await call("/api/search?q=PORTFOLIO", {}, null, ctx);
  await drain();
  eq("case variant still hits", third.headers.get("x-cache") ?? "", "MEMO");
  eq("still one upstream call", String(ghCalls), "1");

  // A different query must not be served the wrong answer.
  const other = await call("/api/search?q=something-else", {}, null, ctx);
  await drain();
  eq("a different query still goes upstream", String(ghCalls), "2");
  check("and is not the memoised body", other.headers.get("x-cache") === "MISS");
}

ghCalls = 0;
__clearMemo();
stubGithub(() => new Response(JSON.stringify({ message: "rate limited" }), { status: 403 }));
{
  // A failure must not be memoised, or one rate limit would be served to
  // everyone in this isolate for the rest of the TTL.
  const { ctx, drain } = fakeCtx();
  await call("/api/search?q=failtest", {}, null, ctx);
  await drain();
  const second = await call("/api/search?q=failtest", {}, null, ctx);
  await drain();
  eq("failure is retried, not memoised", String(ghCalls), "2");
  check("second attempt is still a MISS", second.headers.get("x-cache") !== "MEMO");
}

console.log("=== provenance is reconciled when the secret is fixed ===");
ghCalls = 0;
__clearMemo();
stubGithub(() => {
  const bad = lastAuth === "Bearer broken-pat";
  return bad
    ? new Response(JSON.stringify({ message: "Bad credentials" }), { status: 401 })
    : ghOk([{ full_name: "a/b", has_pages: true }], 55);
});
{
  const { cache, store } = fakeCache();
  const { ctx, drain } = fakeCtx();

  // Fetch once while the secret is broken: this populates the cache degraded.
  const broken = await call("/api/search?q=reconcile", { GITHUB_TOKEN: "broken-pat" }, cache, ctx);
  await drain();
  const brokenBody = (await broken.json()) as any;
  check("entry is cached while degraded", brokenBody._cache.degraded === "token-rejected", JSON.stringify(brokenBody._cache));
  check("cached body records it was unauthenticated", brokenBody._cache.authed === false);

  // Now the secret is repaired. The cached entry must stop claiming to be
  // degraded, because that describes the old request path, not this one.
  __clearMemo();
  const fixed = await call("/api/search?q=reconcile", { GITHUB_TOKEN: "good-pat" }, cache, ctx);
  await drain();
  const fixedBody = (await fixed.json()) as any;

  check("header reports authenticated", fixed.headers.get("x-gh-authed") === "true");
  check("body no longer claims degradation", fixedBody._cache.degraded === undefined, JSON.stringify(fixedBody._cache));
  check("body reports authenticated", fixedBody._cache.authed === true);
  check("the historical fact is kept", fixedBody._cache.fetchedAuthed === false);
  check("recovery is reported", fixedBody._cache.recovered === "token-restored", JSON.stringify(fixedBody._cache));
  check("a still-degraded entry is not trusted fresh",
    fixedBody._cache.fresh === false, `fresh=${fixedBody._cache.fresh}`);

  // And the isolate memo must not reintroduce the stale claim either.
  const memoed = await call("/api/search?q=reconcile", { GITHUB_TOKEN: "good-pat" }, cache, ctx);
  const memoBody = (await memoed.json()) as any;
  check("memo path reconciles too", memoBody._cache.degraded === undefined, JSON.stringify(memoBody._cache));
  check("memo path reports recovery", memoBody._cache.recovered === "token-restored");

  // Still degraded (no secret at all): the flag stays, because it is still true.
  __clearMemo();
  const anon = await call("/api/search?q=reconcile2", {}, cache, ctx);
  await drain();
  const anonBody = (await anon.json()) as any;
  check("unauthenticated entry is not falsely marked recovered",
    anonBody._cache.recovered === undefined && anonBody._cache.authed === false, JSON.stringify(anonBody._cache));
}

console.log("=== verdicts distinguish dead from merely unfriendly ===");
{
  // Status -> expected verdict, including the cases a flat alive/dead flag
  // would get wrong.
  const cases: Array<[number, string]> = [
    [200, "alive"],
    [204, "alive"],
    [301, "alive"],
    [404, "gone"],
    [410, "gone"],
    [403, "blocked"],   // bot filter or Cloudflare: the site may be fine
    [429, "blocked"],
    [401, "blocked"],
    [500, "error"],
    [503, "error"],
  ];
  for (const [status, want] of cases) {
    let got = "";
    let alive: boolean | null = null;
    globalThis.fetch = (async () => new Response(null, { status })) as typeof fetch;
    const res = await call("/api/live?u=https://verdict-user.github.io/", {}, null, null);
    const body = (await res.json()) as any;
    got = body.verdict;
    alive = body.alive;
    eq(`HTTP ${status} -> ${want}`, got, want);
    if (want === "alive") {
      eq(`HTTP ${status} sets alive`, String(alive), "true");
    } else {
      eq(`HTTP ${status} does not claim alive`, String(alive), "false");
    }
  }

  // A blocked site must not be cached for as long as a live one.
  globalThis.fetch = (async () => new Response(null, { status: 200 })) as typeof fetch;
  const live = await call("/api/live?u=https://ttl-user.github.io/", {}, null, null);
  const liveMax = Number((live.headers.get("cache-control") ?? "").match(/max-age=(\d+)/)?.[1]);
  globalThis.fetch = (async () => new Response(null, { status: 404 })) as typeof fetch;
  const dead = await call("/api/live?u=https://ttl2-user.github.io/", {}, null, null);
  const deadMax = Number((dead.headers.get("cache-control") ?? "").match(/max-age=(\d+)/)?.[1]);
  globalThis.fetch = (async () => new Response(null, { status: 403 })) as typeof fetch;
  const blocked = await call("/api/live?u=https://ttl3-user.github.io/", {}, null, null);
  const blockedMax = Number((blocked.headers.get("cache-control") ?? "").match(/max-age=(\d+)/)?.[1]);
  check("live is cached longest", liveMax > blockedMax && liveMax > deadMax, `live=${liveMax} gone=${deadMax} blocked=${blockedMax}`);
  check("gone is cached briefly, since sites return", deadMax < liveMax, `gone=${deadMax} live=${liveMax}`);
}

{
  // A host that does not resolve must be 'unreachable', not 'gone'.
  globalThis.fetch = (async () => { throw new Error("getaddrinfo ENOTFOUND"); }) as typeof fetch;
  const res = await call("/api/live?u=https://nope-nobody.github.io/", {}, null, null);
  const body = (await res.json()) as any;
  eq("DNS failure is unreachable", String(body.verdict), "unreachable");
  eq("and not reported as gone", String(body.status), "0");
}

globalThis.fetch = realFetch;

console.log("=== a redirect is an answer, not a failure ===");
{
  // The real case: a Pages site 301s to a custom domain the Worker cannot
  // complete. With `redirect: "follow"` the fetch threw and the site was
  // reported "unreachable" — factually wrong, and it applies to every Pages
  // site that has moved to its own domain.
  globalThis.fetch = (async () =>
    new Response(null, {
      status: 301,
      headers: { location: "http://example-personal-site.com/" },
    })) as typeof fetch;

  const res = await call("/api/live?u=https://redirects-user.github.io/", {}, null, null);
  const body = (await res.json()) as any;
  eq("a 301 is alive", String(body.verdict), "alive");
  eq("and reports where it went", String(body.redirectsTo), "http://example-personal-site.com/");

  for (const status of [301, 302, 307, 308]) {
    globalThis.fetch = (async () =>
      new Response(null, { status, headers: { location: "https://elsewhere.example/" } })) as typeof fetch;
    const r = (await (await call(`/api/live?u=https://r${status}-user.github.io/`, {}, null, null)).json()) as any;
    eq(`HTTP ${status} counts as alive`, String(r.verdict), "alive");
    check(`HTTP ${status} surfaces the destination`, typeof r.redirectsTo === "string", String(r.redirectsTo));
  }

  // A 200 must not claim a destination it does not have.
  globalThis.fetch = (async () => new Response(null, { status: 200 })) as typeof fetch;
  const plain = (await (await call("/api/live?u=https://plain-user.github.io/", {}, null, null)).json()) as any;
  check("a direct 200 has no redirect target", plain.redirectsTo === undefined, String(plain.redirectsTo));
}

console.log("=== batch liveness is bounded where a single check is not ===");
{
  // A front page renders many rows at once, so the batch endpoint is the one
  // that can be turned into a fan-out over other people's servers. These checks
  // are the limit that stops it.
  const probeable = Array.from(
    { length: 7 },
    (_, i) => `https://h${i}.github.io/`,
  );

  globalThis.fetch = (async () => new Response(null, { status: 200 })) as typeof fetch;

  const ok = await call(`/api/live/batch?u=${probeable.slice(0, 5).join(",")}`);
  eq("a small batch of personal hosts is allowed", String(ok.status), "200");
  const okBody = (await ok.json()) as any;
  eq("every requested url gets an answer", String(Object.keys(okBody.results).length), "5");
  eq("and the answer is a verdict", String(okBody.results[probeable[0]].verdict), "alive");

  const tooMany = await call(`/api/live/batch?u=${probeable.join(",")}`);
  eq("more hosts than the budget is refused", String(tooMany.status), "403");

  // Shared hosts are refused in a batch even though a single explicit check
  // allows them: one origin can carry thousands of unrelated sites, so a page
  // that named thousands of paths under it would be a bot aimed at one host.
  for (const shared of [
    "https://pages.github.io/x",
    "https://github.io/x",
    "https://github.com/a/b",
    "https://raw.githubusercontent.com/a",
    "https://gist.githubusercontent.com/a",
  ]) {
    const r = await call(`/api/live/batch?u=${encodeURIComponent(shared)}`);
    eq(`shared host refused in a batch: ${new URL(shared).hostname}`, String(r.status), "403");
  }

  // Subdomains of github.io ARE the personal sites this index is made of, so
  // they must stay allowed. Treating github.io as a suffix-matched shared host
  // would refuse all 7,813 of them, which is the bug this pins down.
  const personal = await call("/api/live/batch?u=https://someone.github.io/,https://other.github.io/");
  eq("personal github.io subdomains are allowed in a batch", String(personal.status), "200");

  // ...but the same host is fine for one deliberate check. This is the whole
  // point of the two tiers: the reader who clicks a link learns whether it
  // works, but a page cannot farm that endpoint for a whole domain.
  const single = await call(`/api/live?u=${encodeURIComponent("https://pages.github.io/one-page")}`);
  eq("shared host still allowed for one explicit check", String(single.status), "200");

  const oversize = await call(
    `/api/live/batch?u=${Array.from({ length: 13 }, (_, i) => `https://x${i}.github.io/`).join(",")}`,
  );
  eq("a batch over the size cap is refused", String(oversize.status), "400");

  const empty = await call("/api/live/batch?u=");
  eq("an empty batch is refused", String(empty.status), "400");

  // A refused url inside an otherwise fine batch must be visible as refused,
  // not silently missing, or the caller cannot tell "not checked" from "no".
  const mixed = await call(
    `/api/live/batch?u=${["https://ok1.github.io/", "https://evil.example.com/"].join(",")}`,
  );
  const mixedBody = (await mixed.json()) as any;
  eq("a bad url does not sink the batch", String(mixed.status), "200");
  check(
    "and is reported as not allowed",
    String(mixedBody.results["https://evil.example.com/"].detail).includes("not a github.io"),
    JSON.stringify(mixedBody.results["https://evil.example.com/"]),
  );
  eq("while the good url is still probed", String(mixedBody.results["https://ok1.github.io/"].verdict), "alive");
}

{
  // A batch must warm the same cache entries the single-URL endpoint reads, so
  // the second visitor to check a front page gets hits instead of misses.
  const { cache } = fakeCache();
  const ctx = fakeCtx();
  globalThis.fetch = (async () => new Response(null, { status: 200 })) as typeof fetch;

  await call("/api/live/batch?u=https://warm-user.github.io/", {}, cache, ctx.ctx);
  await ctx.drain();
  const afterBatch = await call("/api/live?u=https://warm-user.github.io/", {}, cache, null);
  eq("the single check then hits cache", afterBatch.headers.get("x-cache"), "HIT");
}

globalThis.fetch = realFetch;

console.log(`\n${fail === 0 ? "WORKER OK" : `${fail} CHECK(S) FAILED`}`);
process.exit(fail === 0 ? 0 : 1);
