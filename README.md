# ghindex

Live search of [GitHub Pages](https://pages.github.com) sites. You type, and
GitHub is asked directly; every result is link-checked as it appears.

The site is static files on GitHub Pages. There is no index behind it.

## How it works

```
typing ──debounce──> browser ──> edge worker ──> GitHub search API
                         │              │
                         │              └── cache (isolate LRU + caches.default)
                         │
                         └──> link-check each result ──> edge worker ──> the site's host
```

Everything a visitor sees is requested at the moment they search. The page holds
no data of its own, so there is nothing to refresh on a schedule, nothing to go
stale, and no build step between a query and its answer.

The edge worker exists to hold the GitHub token server-side. This project is
served from `*.github.io`, which Cloudflare cannot sit in front of, so the worker
lives on its own hostname and is called cross-origin — see
`worker/README.md` for the caching measurements and the limits.

## Why there is no pre-built index

There was one, and it was the wrong shape. A nightly harvest generated a sharded
index, the page searched it locally, and the live GitHub search appeared
underneath as a secondary "also on GitHub" group. Two problems with that:

- **They disagreed.** The two halves were ranked differently and shown as one
  result set, so a query routinely reported "0 matches" in the local half while
  the live half below it had the answer.
- **The local half was a worse sample of the same thing.** It was limited to the
  topic shards the harvester happened to use, stale between runs, and cost
  8 MB of generated HTML plus 2,059 per-site pages to maintain.

So there is one result set now and it is live. What that costs is stated plainly
in `worker/README.md`: the edge holds one token, so the whole site shares a
30/minute budget and the cache absorbs roughly half of it. **That ceiling does
not scale.** It is fine at current traffic and is a hard wall at real traffic.
It is the honest price of not shipping a snapshot.

## The page

One centred search box, a line of help, a strip of topic chips, and results.

There is no navigation and no configuration. The chips collapse to a single line
with an "all 83" expander, because showing all of them pushed the results a full
screen down and made the picker the page's main content, which it is not.

## Layout

| Path | Purpose |
| --- | --- |
| `src/site/` | The static site. This is what Pages deploys. |
| `src/site/app.js` | Search, the tag picker, and rendering. |
| `src/site/github-search.js` | On-demand GitHub search and liveness checks. |
| `src/site/taxonomy.js` | The curated topic list and the classifier. Runs in the browser. |
| `worker/` | The edge worker: token, caching, liveness verdicts. |
| `spike/` | The original feasibility investigation, kept for provenance. |

Every path lives in `src/paths.ts`.

## Commands

```bash
bun run serve          # dev server on :8099
bun run reports        # rewrite the report-link config
bun run test           # classifier + live search
bun run test:all       # everything, including the browser check
```

`bun run test:browser` starts its own dev server, so it works standalone. It
needs a Chromium-family browser; set `CHROME_PATH` if it is somewhere unusual.

## What the front end can and cannot do

**The topic chips search `topic:<tag>`**, not the free text. GitHub's topic
qualifier is exact, so picking "portfolio" finds repos that carry that tag
rather than every repo that mentions portfolios — which is what someone clicking
a topic picker is asking for. Clicking the selected chip clears it.

**The list is curated, not complete.** GitHub has 11,677 distinct topics on this
corpus and 72% appear exactly once, so a literal "all tags" would be 11,677
buttons, most leading to one unrelated repo. The chips are the subset that
describes what a site *is* rather than what it was built with, and a test asserts
no technology-only tag is among them.

**`has_pages` is a repository setting**, and it can be weeks out of date with
reality — a project that moved to a custom domain still reports Pages enabled
while serving nothing. That is why each result is link-checked separately, and
why a verdict distinguishes `blocks bots` from `dead link`: a site refusing an
automated request is not the same as a site that is down.

**The fuzzy subsequence search is gone.** It lived in the local index's scorer.
GitHub's own ranking is what orders results now, and `github-search.js` re-sorts
by stars so long-tail sites are not buried under whatever GitHub ranked first.

**There are no per-site pages and no sitemap.** The site's entire crawlable
surface is one search page.

## Reporting and submissions

The site is static, so there is no backend to receive submissions. "Report
problem" and "Claim / submit" on each result open a pre-filled GitHub issue.
Point reports at your own fork with `REPORT_REPO=owner/repo`.

## Guarantees enforced in CI

- **No local index** — the front-end check fails if the page ever fetches a
  manifest, a shard, or instantiates a search worker again.
- **Correctness** — the classifier and the live search module are unit tested.
- **Edge behaviour** — proxy allowlist, token fallback, cache absorption, and
  liveness verdicts are tested with a stub cache and stubbed upstream.
- **Shape** — the page is asserted to be one search box with one results
  container. The star filter, preview grid and token field are all checked to be
  *absent*, because each one puts chrome between the visitor and the box.
- **The topic picker** — populated, collapsible to one line, no technology-only
  tags, and selecting one does not expand it.
- **Behaviour** — the UI is driven in a real headless browser: live results, tag
  selection and clearing, link badges, and clearing the box.