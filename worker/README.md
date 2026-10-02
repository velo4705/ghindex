# ghindex edge search worker

Holds the GitHub token on the server and caches search responses at the edge, so
the token never reaches a browser and repeat queries cost no rate limit.

## Why this is not a shared token in the page

Measured against the live API:

| path | limit | keyed to |
| --- | --- | --- |
| unauthenticated | 10/min | the visitor's IP |
| authenticated | 30/min | the token |

Baking a token into the static page would be worse than useless. Today each
visitor spends 10/min from their *own* IP bucket. One site-wide token collapses
that into a single 30/min bucket shared by everyone, which two simultaneous
searchers exhaust. It also publishes the credential, since anything in these
static files is readable via view-source.

Keeping the token server-side avoids both problems, and the cache is what makes
it a genuine improvement rather than a lateral move: repeat queries mostly avoid
upstream requests.

### Measured cache hit rate, and the caveat

Measured against the deployed worker: 16 identical requests issued ~300ms
apart, all landing in the same colo (`BOM`).

| build | served without an upstream call |
| --- | --- |
| `caches.default` only | ~50% (and often worse; one run showed 6%) |
| isolate memo + `caches.default` | 50-56% |

The isolate memo clearly does its job — runs show `MEMO=7`, `MEMO=8` — but the
total barely moves, which means requests are being spread across enough Worker
isolates that no single-tier cache covers them, and cross-isolate reads through
`caches.default` are missing far more often than they should.

So the honest claim is **"roughly halves upstream spend", not "repeat queries
are free"**. That is still worth having, and it is why the token matters most:
fixing the secret takes the shared budget from 10/min to 30/min, which is a
larger lever than any cache tuning here.

If this ever needs to be better than that, the fix is a durable KV namespace
rather than more cache tuning. KV is globally replicated and consistent, so a
miss means a genuine miss. It needs one namespace and a binding:

```sh
bunx wrangler kv:namespace create MEMO
```

It was not adopted here only because it adds a binding and a second
consistency model to reason about for a project whose real bottleneck is
GitHub's search cap.

## Why it cannot sit in front of `*.github.io`

Cloudflare only intercepts traffic on domains it serves. `*.github.io` is served
by GitHub, so a Worker never sees those requests and cannot be placed in front
of them. Until the project moves off GitHub Pages onto its own domain, the
Worker runs on its `workers.dev` hostname and the page calls it cross-origin.
The responses are public GitHub metadata, so the permissive CORS policy is
deliberate.

## Deploy

```sh
cd worker
bun install                      # pulls wrangler
bunx wrangler secret put GITHUB_TOKEN   # paste a token with no scopes, or read-only
bunx wrangler deploy
```

The token must never be written into `wrangler.jsonc`. Use a read-only or
no-scope token: this worker only ever calls the public search API, so it needs
no permissions at all. `/api/health` reports only whether a token is present,
never its value.

Then point the page at it, in `src/site/index.html`:

```html
<meta name="ghindex-edge" content="https://ghindex-search.<subdomain>.workers.dev" />
```

Left empty, the page talks to GitHub directly and everything still works. That
is the shipped default, because a configured-but-unreachable worker must never
be a hard dependency.

## Endpoints

| route | purpose |
| --- | --- |
| `GET /api/health` | `{ok, authed, limitPerMinute}`. Used to detect availability. |
| `GET /api/search?q=&page=&per_page=` | cached proxy for one page of search results. |
| `GET /api/live?u=<url>` | liveness HEAD for one `*.github.io` URL, cached. |

The search response is the upstream GitHub body unchanged, plus a `_cache` field
(`cachedAt`, `age`, `fresh`, `source`, `authed`). Keeping the shape untouched
means the browser module has one parser rather than two.

### Caching

- Hard TTL 3600s (the edge holds the entry), soft TTL 600s.
- Two tiers: a bounded in-isolate map (60s, 200 entries) checked first, then
  `caches.default`. The memo exists because the edge cache was observed missing
  on roughly half of near-simultaneous identical requests, and a reused isolate
  covers exactly those.
- Inside the soft window a hit is returned with no upstream call. `x-cache`
  reports `MEMO`, `HIT`, `STALE` or `MISS`.
- Past the soft window the entry is still returned immediately and revalidated
  in the background via `ctx.waitUntil`. A popular term degrades to "slightly
  stale for one visitor" rather than "a GitHub request per visitor".
- Upstream failures and rate limits are never cached at either tier, so the
  Worker does not replay its own failure to every visitor until the TTL expires.
- Cache keys are normalised (case-folded, whitespace-collapsed, parameters
  sorted and clamped). Without this, `portfolio`, `Portfolio` and `portfolio `
  are three entries and the cache never actually hits.

### Liveness and SSRF

`/api/live` fetches a URL on behalf of its caller, which is the shape of a
server-side request forgery bug. The allowlist is therefore narrow: HTTPS only,
`*.github.io` only, no embedded credentials, and bare `github.io` refused. The
tests cover loopback, the cloud metadata address, lookalike hosts such as
`github.io.evil.com`, and `http://`.

This endpoint exists because the browser genuinely cannot do the job: a
cross-origin `HEAD` to another user's site returns an opaque response under
CORS. GitHub's API says a repository *has* Pages enabled, which is a repo
setting and can be weeks out of date with reality. From the server there is no
such restriction, so real-time results can be labelled verified or dead rather
than permanently "unknown".

## Tests

```sh
bun run test:worker
```

Drives the real routing, caching, rate-limit and SSRF-guard paths through
`handleRequest` with a stub cache and a stubbed upstream fetch. No network
access, so it spends no GitHub rate limit and needs no Wrangler dev server.

The stale-while-revalidate test deliberately hangs the upstream and asserts the
visitor's response still returns, which proves the request path does not depend
on GitHub at all.
