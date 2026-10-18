/**
 * A local stand-in for the deployed worker, for the browser suite only.
 *
 * Why this exists
 * ---------------
 * The browser suite serves the page from localhost but the page takes its search
 * endpoint from `<meta name="ghindex-edge">`, which points at the *deployed*
 * worker. So every test run was spending the production token's shared
 * 30/minute GitHub budget, alongside real users. That is how a green suite starts
 * failing: it exhausts the budget, the cold queries stop returning, and the result
 * is a test error that looks like a broken feature.
 *
 * This runs the real `handleRequest` - the same routing, caching, clamping, sorting
 * and provenance code the deployed worker runs - over HTTP, with two substitutions:
 *
 *   1. GitHub is replaced by deterministic fixtures, so the suite costs no rate
 *      limit at all and cannot make production any slower.
 *   2. `caches.default` is shimmed by an in-memory Map, because Bun has no Cache
 *      API. That keeps the caching paths under test instead of stubbing them away.
 *
 * What this deliberately does NOT do
 * ----------------------------------
 * It does not verify the real GitHub response shape. That is the job of
 * test-wide-search.ts, which talks to GitHub for real. This exists so the browser
 * suite can test the parts that are actually about the browser: layout, rendering,
 * badges, paging, focus, and keyboard behaviour - deterministically, at no cost to
 * anyone.
 */

import { handleRequest, __clearMemo } from "../../worker/src/index.ts";

/**
 * Port.
 *
 * Zero means "any free port", which is deliberate. This worker used a fixed port,
 * and a leftover process from an earlier run held it: the new instance failed to
 * bind, the stale one answered the health check, and the suite spent its run
 * testing fixtures from code that had since changed — silently, because a live
 * port looks exactly like a healthy one. Binding ephemerally removes the whole
 * class of problem, and the chosen port is printed so the harness can use it.
 */
const PORT = Number(process.env.FIXTURE_WORKER_PORT ?? 0);

export interface FixtureResult {
  total_count: number;
  incomplete_results: boolean;
  items: unknown[];
}

/** Pages a fixture deliberately holds, keyed by owner name. */
const NAMES = [
  "ada-lovelace", "grace-hopper", "alan-turing", "katherine-j",
  "barbara-liskov", "edsger-dijkstra", "radia-perlman", "margaret-hamilton",
  "jean-bartik", "hedy-lamarr", "shafi-goldwasser", "leslie-lamport",
  "donald-knuth", "frances-allen", "tim-berners-lee", "anita-borg",
];

/**
 * Scramble an index into a well-spread integer.
 *
 * Needed because an arithmetic progression, however large the multiplier, still
 * arrives in order: `i * 7919 % 997` descends for the first few dozen values, so
 * "sort by stars" returned the list untouched and a page that must differ from
 * Best match looked identical to it. Two rounds of multiply-xor-shift (a murmur
 * finaliser) actually decorrelates the inputs.
 */
function mix(n: number): number {
  let x = Math.imul(n ^ 0x9e3779b9, 2654435761) >>> 0;
  x ^= x >>> 15;
  x = Math.imul(x, 2246822519) >>> 0;
  x ^= x >>> 13;
  x = Math.imul(x, 3266489917) >>> 0;
  x ^= x >>> 16;
  return x >>> 0;
}

function item(i: number) {
  const owner = NAMES[i % NAMES.length];
  const repo = ["portfolio", "notes", "site", "blog", "dashboard", "game"][i % 6];
  return {
    id: i + 1,
    name: repo,
    full_name: `${owner}/${repo}`,
    owner: { login: owner },
    html_url: `https://github.com/${owner}/${repo}`,
    homepage: `https://${owner}.github.io/${repo}/`,
    description: `A deterministic fixture project number ${i + 1}, for browser tests.`,
    /**
     * Scattered, not ascending.
     *
     * A simple `i * 7` makes the page's stars climb with the row order, so sorting
     * by stars returns the list unchanged — and a suite checking that Best match
     * and Most stars actually differ would then fail for a reason that has nothing
     * to do with the sort. A multiplicative scramble keeps it deterministic while
     * making the orderings genuinely different.
     */
    stargazers_count: mix(i) % 997,
    topics: ["github-pages", "fixture"],
    pushed_at: new Date(Date.UTC(2026, 0, 1 + (i % 28))).toISOString(),
    fork: false,
    /**
     * Load-bearing, and easy to miss.
     *
     * The client filters on this field rather than in the query, because GitHub
     * accepts `has:pages` and then ignores it. Without it every fixture row is
     * discarded and the page correctly reports "No Pages sites matched" — which
     * looks exactly like a broken search rather than an incomplete fixture.
     */
    has_pages: true,
  };
}

/**
 * Build a page of results for a query.
 *
 * Deterministic in the query so that different searches produce visibly different
 * lists — a suite that cannot tell two results apart cannot tell whether paging or
 * re-sorting did anything.
 *
 * The one exception is the nonsense query below. A fixture that always answers
 * with a full page cannot represent "no results", and the suite has a real check
 * for the empty state: the settling message, and the absence of a spinner that
 * would otherwise imply the search was still running. Returning nothing for one
 * specific query is what lets that state be exercised at all.
 */
const NO_MATCH = "zzqxvnotarealprojectname12345";

function fixtureFor(
  q: string,
  perPage: number,
  page: number,
  sort: string,
  order: string,
): FixtureResult {
  if (q.includes(NO_MATCH)) {
    return { total_count: 0, incomplete_results: false, items: [] };
  }
  const seedBase = [...q].reduce((a, c) => a + c.charCodeAt(0), 0);
  const start = (page - 1) * perPage;
  let items = Array.from({ length: perPage }, (_, i) => item(start + i + seedBase));
  const desc = order !== "asc";
  if (sort === "stars") {
    // Both directions supported, because the point is that the parameter arrived
    // at all — a fixture that ignored `order` would pass a check that only ever
    // asked for one of them.
    items = [...items].sort((a: any, b: any) =>
      desc ? b.stargazers_count - a.stargazers_count : a.stargazers_count - b.stargazers_count);
  } else if (sort === "updated") {
    items = [...items].sort((a: any, b: any) =>
      desc ? (a.pushed_at < b.pushed_at ? 1 : -1) : (a.pushed_at > b.pushed_at ? 1 : -1));
  }
  return { total_count: 256_000 + seedBase, incomplete_results: true, items };
}

/** In-memory Cache API, close enough for the paths the worker actually uses. */
function makeCache(): Cache {
  const store = new Map<string, { body: ArrayBuffer; headers: Headers }>();
  return {
    async match(req: Request) {
      const hit = store.get(req.url);
      if (!hit) return undefined;
      return new Response(hit.body.slice(0), { headers: new Headers(hit.headers) });
    },
    async put(req: Request, res: Response) {
      store.set(req.url, {
        body: await res.clone().arrayBuffer(),
        headers: new Headers(res.headers),
      });
    },
  } as unknown as Cache;
}

/**
 * Answer GitHub searches from the fixtures and let everything else through.
 *
 * Liveness probes are intercepted too, and that is the point: a fixture suite that
 * fetched forty real Pages sites would be slow, flaky, and rude to sites that have
 * nothing to do with this test. Repositories whose name contains "dead" answer 404
 * so the dead-link badge has something real to assert against, and everything else
 * answers 200. `probe()` uses the global fetch, so this is the whole interception.
 */
const realFetch = globalThis.fetch;
let searchCalls = 0;
let probeCalls = 0;
globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = new URL(String(input instanceof Request ? input.url : input));

  if (url.hostname === "api.github.com" && url.pathname.includes("/search/")) {
    searchCalls++;
    const q = url.searchParams.get("q") ?? "";
    const page = Number(url.searchParams.get("page") ?? "1");
    const perPage = Number(url.searchParams.get("per_page") ?? "30");
    const sort = (url.searchParams.get("sort") ?? "best").toLowerCase();
    // The worker sends `sort` and `order` as separate parameters, and this shim is
    // downstream of that rewrite, so `sort=stars` arrives here as
    // sort=stars&order=desc. Concatenating the two made "starsdesc", which matched
    // nothing below and left the fixture silently unsorted.
    const order = (url.searchParams.get("order") ?? "").toLowerCase();
    return new Response(JSON.stringify(fixtureFor(q, perPage, page, sort, order)), {
      status: 200,
      headers: {
        "content-type": "application/json",
        // The real API reports what is left, and the worker surfaces it.
        "x-ratelimit-limit": "30",
        "x-ratelimit-remaining": String(Math.max(0, 29 - searchCalls)),
      },
    });
  }

  // A probe to somebody's Pages site, answered from the fixtures rather than the
  // internet. `redirect: manual` is preserved so the 3xx path still behaves.
  if (/(^|\.)github\.io$/.test(url.hostname)) {
    probeCalls++;
    const dead = /dead/i.test(url.pathname);
    return new Response(null, {
      status: dead ? 404 : 200,
      headers: { "content-type": "text/html" },
    });
  }

  return realFetch(input, init);
}) as typeof fetch;

const cache = makeCache();

/** Live sites the fixtures point at, so badge checks have something real to find. */
const server = Bun.serve({
  port: PORT,
  async fetch(req) {
    const url = new URL(req.url);
    // Introspection for the test harness: how much budget was spent, and
    // confirmation that nothing reached the network.
    if (url.pathname === "/__stats") {
      return Response.json({ searchCalls, probeCalls });
    }
    if (url.pathname === "/site" || url.pathname.startsWith("/site/")) {
      // Stands in for a GitHub Pages site. Alive, so liveness checks have a real
      // answer to give without leaving the machine.
      return new Response(
        "<!doctype html><meta charset=utf-8><title>fixture site</title><h1>fixture site</h1>",
        { status: 200, headers: { "content-type": "text/html" } },
      );
    }
    const res = await handleRequest(req, {}, cache, {
      waitUntil: () => {},
    } as unknown as ExecutionContext);
    return res;
  },
});

/**
 * Announce the port on stdout, in a form the harness can read without guessing.
 *
 * Parsed rather than hard-coded, so the two can never drift apart.
 */
console.log(`ghindex fixture worker: http://127.0.0.1:${server.port}`);

export { __clearMemo };