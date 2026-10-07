/**
 * M7 — on-demand GitHub search.
 *
 * The local index cannot be a complete census: the API caps at 1,000 results
 * per query and there is no endpoint that lists all Pages sites. Measured
 * against topics the harvester never used, 96% of Pages-enabled owners found
 * that way were absent from the local index. This module is the escape hatch,
 * so the URL-resolution rules and the filter for has_pages are worth pinning.
 */

import { pagesUrlFor, buildQueryForTest } from "../../src/site/github-search.js";

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
const check = (name: string, ok: boolean | string, detail = "") => {
  const pass = ok === true || ok === "ok";
  console.log(`  ${pass ? "PASS" : "FAIL"}  ${name}`);
  if (!pass) {
    if (detail) console.log(`        ${detail}`);
    fail++;
  }
};

console.log("=== URL resolution matches the crawler (core.ts) ===");
eq("apex when repo is <owner>.github.io",
  pagesUrlFor("alice", "alice.github.io", null), "https://alice.github.io/");
eq("subpath otherwise",
  pagesUrlFor("alice", "my-portfolio", null), "https://alice.github.io/my-portfolio/");
eq("owner github.io homepage kept",
  pagesUrlFor("squidfunk", "mkdocs-material", "https://squidfunk.github.io/mkdocs-material/"),
  "https://squidfunk.github.io/mkdocs-material/");
eq("foreign homepage rejected",
  pagesUrlFor("jkunst", "foo", "http://jkunst.com/jbkunst.github.io3/"),
  "https://jkunst.github.io/foo/");
eq("another user's homepage rejected",
  pagesUrlFor("alice", "site", "https://mallory.github.io/x"),
  "https://alice.github.io/site/");
eq("github.com/wiki rejected",
  pagesUrlFor("mauriceling", "mauriceling.github.io", "https://github.com/mauriceling/mauriceling.github.io/wiki"),
  "https://mauriceling.github.io/");
eq("case-insensitive owner",
  pagesUrlFor("Alice", "Alice.github.io", null), "https://alice.github.io/");

console.log("=== query construction ===");
eq("single word is not over-quoted", buildQueryForTest("portfolio"),
  "portfolio in:name,description,readme");
eq("multi word is quoted as a phrase", buildQueryForTest("react portfolio"),
  '"react portfolio" in:name,description,readme');
eq("quotes in input are stripped", buildQueryForTest('we"ird'),
  "weird in:name,description,readme");
eq("empty input yields empty query", buildQueryForTest("   "), "");
eq("backslashes stripped", buildQueryForTest("a\\b"), "ab in:name,description,readme");

/**
 * Pagination is the feature that makes niche sites findable: before it, one
 * call of per_page=30 yielded ~8 Pages sites per query. These pin the pure
 * logic with fetch stubbed, so they never spend rate limit.
 */
console.log("=== pagination and ranking (fetch stubbed) ===");

const realFetch = globalThis.fetch;

/** Build an API item; `pages` toggles the has_pages flag. */
const item = (fullName: string, stars: number, pages = true) => {
  const [owner, repo] = fullName.split("/");
  return {
    full_name: fullName,
    name: repo,
    owner: { login: owner },
    stargazers_count: stars,
    has_pages: pages,
    description: "d",
    topics: ["t"],
    homepage: null,
  };
};

type Call = { url: string };

/**
 * Stub fetch to serve `perPage` items per page from a pool, so the test can
 * assert how many requests a given `pages` argument costs.
 */
function stubPool(pool: unknown[], total: number, perPage = 100) {
  const calls: Call[] = [];
  globalThis.fetch = (async (url: string) => {
    calls.push({ url });
    const page = Number(new URL(url).searchParams.get("page") ?? "1");
    const start = (page - 1) * perPage;
    const items = pool.slice(start, start + perPage);
    return new Response(JSON.stringify({ total_count: total, items }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
  return calls;
}

const { searchGitHub, pageCount, MAX_PAGES_FOR_TEST } = await import("../../src/site/github-search.js");

// A pool of 250 Pages items plus non-Pages noise, which must be filtered out.
const pool: unknown[] = [];
for (let i = 0; i < 250; i++) pool.push(item(`owner${i}/repo${i}`, 500 - i));
for (let i = 0; i < 50; i++) pool.push(item(`nope${i}/lib${i}`, 10000, false));

console.log("=== one page costs exactly one call ===");

{
  // The bug this replaced: asking for page 3 used to request pages 1, 2 and 3 and
  // return all three. On a rate limit shared by every visitor that made paging
  // cost three times what it says on the label, and made the second click on the
  // control cost three again to rebuild a list the reader already had.
  const calls = stubPool(pool, 7354);
  const r = await searchGitHub("portfolio", { page: 3 });
  globalThis.fetch = realFetch;

  eq("page 3 costs exactly one call", String(calls.length), "1");
  check("and it is page 3 that was requested",
    calls.every((c) => c.url.includes("page=3")),
    calls.map((c) => c.url).join(", "));
  check("per_page is 100, not 30", calls.every((c) => c.url.includes("per_page=100")));
  check("sorted by stars, descending",
    r.results.every((x, i, a) => i === 0 || a[i - 1].stars >= x.stars));
  check("has_pages=false rows are dropped",
    r.results.every((x) => !x.full_name.startsWith("nope")));
  eq("the result names its page", String(r.page), "3");
  // Page 3 of a 250-item pool is the tail, so fewer than 100 rows come back.
  check("only that page's rows come back", r.results.length === 50 ? "ok" : `got ${r.results.length}`);
}

{
  // Same pool, page 1: a different page, and still one call.
  const calls = stubPool(pool, 7354);
  const r = await searchGitHub("portfolio", { page: 1 });
  globalThis.fetch = realFetch;
  eq("page 1 costs one call", String(calls.length), "1");
  check("one page returns 100 rows", r.results.length === 100 ? "ok" : `got ${r.results.length}`);
}

{
  // Paging must not refetch: going 1 then 2 is two calls total, not three.
  const calls = stubPool(pool, 7354);
  await searchGitHub("portfolio", { page: 1 });
  await searchGitHub("portfolio", { page: 2 });
  globalThis.fetch = realFetch;
  eq("two pages visited cost two calls", String(calls.length), "2");
}

console.log("=== how many pages exist ===");

{
  // GitHub reports millions while refusing past 1,000 results, so the honest
  // count is the reachable one. A pager showing 73,540 pages would be a lie.
  check("page count is the reachable one, not the reported total",
    pageCount(7354) === MAX_PAGES_FOR_TEST, `got ${pageCount(7354)}`);
  check("a short result set is one page", pageCount(40) === 1, `got ${pageCount(40)}`);
  check("exactly 100 results is one page", pageCount(100) === 1, `got ${pageCount(100)}`);
  check("101 results is two pages", pageCount(101) === 2, `got ${pageCount(101)}`);
  check("no results is no pages", pageCount(0) === 0, `got ${pageCount(0)}`);

  const calls = stubPool(pool, 7354);
  const r = await searchGitHub("portfolio", {});
  globalThis.fetch = realFetch;
  eq("the response reports its page count", String(r.pages), String(MAX_PAGES_FOR_TEST));
}

console.log("=== page numbers are clamped ===");

{
  // GitHub returns HTTP 422 for page 11 of a search, so page 11 must never be
  // requested no matter what the caller asks for.
  const calls = stubPool(pool, 7354);
  const r = await searchGitHub("portfolio", { page: 99 });
  globalThis.fetch = realFetch;
  eq("page 99 still costs one call", String(calls.length), "1");
  check("clamped to the last real page", r.page === MAX_PAGES_FOR_TEST, `got ${r.page}`);
  check("never requests page 11", !calls.some((c) => c.url.includes("page=11")) ? "ok" : "requested page 11");

  const zero = stubPool(pool, 7354);
  const r0 = await searchGitHub("portfolio", { page: 0 });
  globalThis.fetch = realFetch;
  check("page 0 clamps up to page 1",
    r0.page === 1 && zero.every((c) => c.url.includes("page=1")) ? "ok" : `page ${r0.page}`);
}

console.log("=== the 1,000 result cap is stated ===");

{
  // A pool that never runs out, so the cap is what decides the page count.
  const calls: Call[] = [];
  globalThis.fetch = (async (url: string) => {
    calls.push({ url });
    const page = Number(new URL(url).searchParams.get("page") ?? "1");
    const items = Array.from({ length: 100 }, (_, i) => item(`gen${page}/repo${i}`, 1000 - i));
    return new Response(JSON.stringify({ total_count: 999999, items }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;

  const r = await searchGitHub("portfolio", {});
  globalThis.fetch = realFetch;
  eq("a huge result set still reports ten pages", String(r.pages), String(MAX_PAGES_FOR_TEST));
  check("truncated flag set at the 1,000 cap", r.truncated ? "ok" : "got false");
}

console.log("=== failures are not silent ===");

{
  // A rate limit on a single-page search has nothing to fall back on, so it is
  // an error the page must show rather than an empty list.
  const reset = Math.floor(Date.now() / 1000) + 42;
  globalThis.fetch = (async () =>
    new Response("rate limited", {
      status: 403,
      headers: { "x-ratelimit-reset": String(reset) },
    })) as typeof fetch;

  const r = await searchGitHub("portfolio", {});
  globalThis.fetch = realFetch;
  check("rate limit reports a partial", r.partial ? "ok" : "no partial set");
  check("rate limit is an error, not an empty result set",
    r.error ? "ok" : "no error set");
  check("and it quotes the reset time", (r.partial ?? "").includes("42s"), r.partial);
}

{
  // An unreachable GitHub must surface too, not render as "no matches".
  globalThis.fetch = (async () => {
    throw new Error("network down");
  }) as typeof fetch;

  const r = await searchGitHub("portfolio", {});
  globalThis.fetch = realFetch;
  check("an unreachable upstream reports an error", r.error ? "ok" : "no error set");
  check("and returns no rows rather than throwing", r.results.length === 0 ? "ok" : `got ${r.results.length}`);
}

console.log("=== edge worker routing ===");

/** Minimal DOM stand-in: github-search.js reads the endpoint from a meta tag. */
const withEdge = (content: string) => {
  (globalThis as any).document = {
    querySelector: (sel: string) =>
      sel === 'meta[name="ghindex-edge"]' ? { getAttribute: () => content } : null,
  };
};

{
  const { edgeEndpoint } = await import("../../src/site/github-search.js");
  delete (globalThis as any).document;
  eq("no DOM means no edge", String(edgeEndpoint()), "null");

  withEdge("");
  eq("empty meta means no edge", String(edgeEndpoint()), "null");
  withEdge("http://insecure.example");
  eq("non-https edge is refused", String(edgeEndpoint()), "null");
  withEdge("https://edge.example/");
  eq("trailing slash is trimmed", String(edgeEndpoint()), "https://edge.example");
  withEdge("https://edge.example/api");
  check("a path is preserved", edgeEndpoint()!.endsWith("/api"));
  delete (globalThis as any).document;
}

{
  // The worker appends `in:name,description,readme` itself, so the client must
  // send raw text. Sending the pre-built query would duplicate the qualifier.
  withEdge("https://edge.example");
  const urls: string[] = [];
  globalThis.fetch = (async (url: string) => {
    urls.push(String(url));
    return new Response(JSON.stringify({ total_count: 1, items: [item("a/b", 1)] }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;

  await searchGitHub("expense tracker", { pages: 1, token: "visitor-token" });
  globalThis.fetch = realFetch;
  delete (globalThis as any).document;

  check("requests go to the edge", urls.every((u) => u.startsWith("https://edge.example/api/search")), urls[0]);
  check("edge gets the raw text", urls[0].includes("q=expense%20tracker"), urls[0]);
  check("edge does not get the built query",
    !urls[0].includes("in%3Aname"), urls[0]);
}

{
  // A worker that is down must not take search down with it.
  withEdge("https://edge.example");
  const urls: string[] = [];
  globalThis.fetch = (async (url: string) => {
    urls.push(String(url));
    if (String(url).startsWith("https://edge.example")) return new Response("boom", { status: 503 });
    return new Response(JSON.stringify({ total_count: 1, items: [item("a/b", 7)] }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;

  const r = await searchGitHub("portfolio", { pages: 1 });
  globalThis.fetch = realFetch;
  delete (globalThis as any).document;

  check("edge is tried first", urls[0].startsWith("https://edge.example"), urls[0]);
  check("falls back to GitHub on a 5xx", urls.some((u) => u.includes("api.github.com")), urls.join(" "));
  check("and still returns results", r.results.length === 1 ? "ok" : `got ${r.results.length}`);
}

{
  // A 403 from the edge is the worker's own rate limit, not an outage, so it
  // must NOT silently fall back: that would burn the visitor's IP budget.
  withEdge("https://edge.example");
  const urls: string[] = [];
  globalThis.fetch = (async (url: string) => {
    urls.push(String(url));
    return new Response(JSON.stringify({ error: "rate-limited", wait: 30 }), { status: 403 });
  }) as typeof fetch;

  const r = await searchGitHub("portfolio", { pages: 1 });
  globalThis.fetch = realFetch;
  delete (globalThis as any).document;

  eq("no fallback on 403", String(urls.length), "1");
  check("rate limit is reported", typeof r.partial === "string", String(r.partial));
}

{
  // Liveness cannot be checked without a server; it must return null, never
  // claim a site is dead.
  const { verifyLiveness } = await import("../../src/site/github-search.js");
  delete (globalThis as any).document;
  eq("no edge means no liveness claim", String(await verifyLiveness("https://x.github.io/")), "null");

  const probe = (body: unknown, status = 200) => {
    globalThis.fetch = (async () =>
      new Response(JSON.stringify(body), { status })) as typeof fetch;
  };

  withEdge("https://edge.example");

  probe({ alive: true, status: 200, verdict: "alive" });
  const alive = await verifyLiveness("https://x.github.io/");
  check("edge reports alive", alive?.alive === true);
  eq("verdict passes through", alive?.verdict, "alive");

  // The distinction that matters: a bot filter is not a dead site, and showing
  // it as one would libel a working site that is often highly starred.
  probe({ alive: false, status: 403, verdict: "blocked" });
  const blocked = await verifyLiveness("https://x.github.io/");
  eq("a refused request is blocked, not gone", blocked?.verdict, "blocked");
  check("and not reported as dead", blocked?.alive === false);

  probe({ alive: false, status: 404, verdict: "gone" });
  const gone = await verifyLiveness("https://x.github.io/");
  eq("404 is gone", gone?.verdict, "gone");

  probe({ alive: false, status: 0, verdict: "unreachable" });
  eq("no response is unreachable", (await verifyLiveness("https://x.github.io/"))?.verdict, "unreachable");

  // A legacy response with no verdict must still yield something renderable,
  // rather than an undefined class name in the UI.
  probe({ alive: true, status: 200 });
  const legacy = await verifyLiveness("https://x.github.io/");
  check("missing verdict degrades safely", legacy?.verdict === null || legacy?.verdict === undefined,
    String(legacy?.verdict));

  globalThis.fetch = (async () => { throw new Error("network down"); }) as typeof fetch;
  const down = await verifyLiveness("https://x.github.io/");
  globalThis.fetch = realFetch;
  delete (globalThis as any).document;

  check("an unreachable edge is not 'dead'", down === null ? "ok" : `got ${JSON.stringify(down)}`);
}

console.log(`\n${fail === 0 ? "ON-DEMAND SEARCH OK" : `${fail} CHECK(S) FAILED`}`);
process.exit(fail === 0 ? 0 : 1);
