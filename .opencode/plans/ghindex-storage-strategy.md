# ghindex: storage strategy — pre-generated index vs. real-time search

## Recommendation: hybrid, leaning real-time. Do not pick A or B.

Measured this session. The binary framing hides the real trade-off: real-time is
**cheaper and fresher** than expected, but it cannot see the most famous Pages
sites, and it cannot produce category counts. Keep a small verified index for
those two jobs; stop treating it as a census.

## Measured facts

### Real-time is cheaper than expected

| Measurement | Value |
| --- | --- |
| `has_pages` hit rate | ~28% (20–37% across queries) |
| Calls per usable result | 0.035 (10 calls → 287 usable for `portfolio`) |
| Rate limit used per user search | 1–10 of 30/min |
| Search returns `topics` | yes (8/10 items) |
| Search returns `homepage` | yes (8/10 items) |
| Real-time liveness cost | 40 HEAD checks ≈ 0.5s at 87 sites/sec |

Because topics and homepage come back, **categories and URL resolution survive
real-time**. That was the main capability I expected to lose.

### Real-time has two hard limits

1. **Famous Pages sites are invisible.** `tldraw/tldraw` and `withastro/astro`
   both report `has_pages=false` because their sites are on custom domains.
   Searching `tldraw` or `astro` returns **zero** usable results.
2. **25% of `has_pages=true` results are dead** (measured: 30/40 alive). Real-time
   must verify liveness per query or it shows broken links.

### The local index has the same blind spot

Searching our own 5,772 records for the same names:

```
tldraw      absent        excalidraw   absent
astro       absent*       tailwindcss  absent
vitepress   absent        vercel       absent
docusaurus  absent
(* only unrelated owners like "astroclubiitk")
```

So the pre-generated index is **not currently solving the famous-site problem
either** — it misses the same projects, for a different reason (it was built
from topic shards, and these repos are tagged by technology, not by "portfolio").
Neither approach finds them. This is a **genuine data-source gap**, not a
storage-strategy problem, and no choice between A and B fixes it.

### Pre-generation costs, measured

- Reach = `windows × 1000 × 0.272`. 4,000 windows → ~1.1M sites, costing
  ~40,000 calls ≈ **22 hours on one token**.
- At 1M+ the per-site SEO pages become **1,000,000 files**, 10× GitHub's
  100,000-file repo limit. Per-site pages cannot be committed at that scale.
- Full re-probe of 1M sites ≈ 3.2 hours at the measured 87/sec ceiling.

### Current corpus quality is good

5,772 published, 78.6% alive, 0 duplicates, 0 invalid URLs, 0 mojibake.
The 25% dead figure for real-time does **not** apply here — the index is
already filtered and verified.

## Plan

### Phase 1 — free speedup

Raise prober concurrency 20 → 100 in `src/index/probe.ts`. Measured 45.9 →
86.6 sites/sec (**1.89x**), no rewrite. Throughput degrades past 100, so cap
there and comment why.

### Phase 2 — shrink the local index to a "verified hot set"

Stop growing it toward a census. It exists to guarantee liveness and to power
category browse, not to be complete.

- Reduce harvest shards to high-value topics only (portfolio, games, docs, blog,
  dashboards). Cheaper nightly run, same usefulness.
- Cap published records (~25k by stars) so the repo stays small and the
  100,000-file limit is never approached.
- Keep the existing state machine unchanged: alive refreshes monthly, dead
  backs off 30/90/180 days, tombstoned retained but unpublished.
- Add a guard that fails the build if generated pages exceed ~20k, since that is
  where repo-file limits become a risk.

### Phase 3 — invert the search path

Today the local index is default and GitHub is opt-in. Invert it:

- **Default: real-time.** Query GitHub, filter `has_pages`, HEAD-verify each
  result, show only live sites.
- **Local index** as fallback when rate-limited, and for fuzzy/partial names
  GitHub's token matching won't find.
- **Category browse stays local**, because facet counts need corpus-wide tallies.
- **Label provenance per result**: "verified" vs "from GitHub, unverified".

### Phase 4 — rate-limit resilience

30 calls/min is shared per IP, so a few simultaneous users exhaust it.

- Debounce and cache per query in `sessionStorage`; repeat queries are free.
- Coalesce in-flight identical requests.
- On 403/429 fall back to the local index and say why.
- Offer the token option only *after* a rate-limit hit, stating the real gain
  (3x, search-only) rather than overselling it.

### Phase 5 — close the famous-site gap (separate from A vs. B)

Neither approach finds custom-domain Pages sites, so this needs its own source.
Options, cheapest first:

1. **Claim flow.** A site owner submits their Pages URL; we verify and add it.
   This inverts the problem: instead of discovering famous sites, let them
   present. The "Claim / submit" link already exists — make it the intake path.
2. **Check `homepage` for `*.github.io`** on repos that report `has_pages=false`.
   Cheap to test; may catch a meaningful slice.
3. **CT logs** for `*.github.io` specifically. Was rejected in M0 because it is
   biased to dead sites, but as a *supplementary* source for well-known domains
   it may still be worth a sample.

## Not recommended, and why

- **Full pre-generation to 1M+**: ~22h of API time, hits the 100k-file limit,
  and still misses custom-domain sites.
- **Pure real-time, delete the local index**: loses category counts, fuzzy
  search, and the 404-free guarantee; leaves the site dead when GitHub's API is
  down.
- **Go rewrite**: benchmarked. The concurrency curve plateaus at 87/sec and
  degrades past 100, so the bottleneck is the network. Phase 1 captures the
  available win for free.

## Open questions

1. **Category browse** — keep it? It is the one feature that genuinely needs a
   local corpus, and a large part of why this is a browser rather than just a
   lookup box.
2. **Target corpus size** — is ~25k acceptable, or is a specific number important?
3. **Rate-limit tolerance** — falling back to a smaller cached index when GitHub
   limits us: acceptable, or should we require a token?
4. **Claim flow** — worth building as the answer to the famous-site gap?
