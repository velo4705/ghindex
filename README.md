# ghindex

A searchable index of [GitHub Pages](https://pages.github.com) sites. Deployed
to GitHub Pages; the entire read side is static files.

Search by owner, repo, title, or topic, with a subsequence fallback for when
you only half-remember a name. Results can be browsed by category or filtered by
topic, and rendered as a dense list or a grid of live previews.

## How it works

The GitHub Pages deployment serves only static files, so all the work happens
in a scheduled pipeline that commits its output back into the repository.

```
GitHub Search API ──> discover/ ──> index/ ──> classify/ ──> publish/ ──> site/
   (which repos          (liveness     (topics to     (shard into    (static
    have Pages?)          state         categories)    JSON)          files)
                          machine)
                              └──────────── quality/ ────────────┘
                              (tests, health, perf budget, anomaly detection)
```

Discovery queries the GitHub Search API for Pages-enabled repositories and
filters `has_pages` client-side, because GitHub exposes it as a response field
but not as a search qualifier. Search results cap at 1,000 per query, so the
harvester works by shard **width** (many distinct queries) rather than depth.

Liveness is tracked per record through a state machine rather than by deletion,
so a site that 404s once is retried on a backoff schedule before being
tombstoned. Tombstoned records are retained but never published.

## Layout

| Path | Purpose |
| --- | --- |
| `src/discover/` | Harvests Pages-enabled repos from the GitHub API. Resumable. |
| `src/index/` | Record model, dead-link state machine, link checker, URL resolution. |
| `src/classify/` | Derives browse categories from raw topics. |
| `src/publish/` | Packs the corpus into sharded JSON, generates static pages. |
| `src/quality/` | Tests, index health, performance budget, anomaly detection. |
| `src/site/` | The static site. This is what Pages deploys. |
| `spike/` | The original feasibility investigation, kept for provenance. |

Every path lives in `src/paths.ts`.

## Commands

```bash
bun run serve          # dev server on :8099
bun run harvest        # discover new repos (respects a time budget)
bun run probe          # check liveness of records that are due
bun run build          # corpus -> sharded JSON in src/site/data
bun run publish        # build + generate pages + report links
bun run test           # unit + data tests
bun run test:all       # everything, including browser, budget, and page checks
```

`bun run test:browser` starts its own dev server, so it works standalone.

## Reporting and submissions

The site is static, so there is no backend to receive submissions. Rather than
depend on a third-party form service, "Report problem" and "Claim / submit" on
each result open a pre-filled GitHub issue. Every report lands in the repository
as a reviewable issue, and the nightly job re-probes reported sites on its next
run. Point reports at your own fork with `REPORT_REPO=owner/repo`.

## Generated pages

The app renders client-side, so a crawler would see an empty page. Each site
with a usable title also gets a real static page under `sites/`, plus category
landing pages, `sitemap.xml`, `robots.txt`, and a `404.html`. Text scraped from
third-party pages is escaped, and mojibake is rejected — but non-Latin scripts
are kept, because a Chinese or Arabic title is content, not corruption.

## Guarantees enforced in CI

- **Correctness** — URL resolution, classifier, and search are unit tested
  against real harvested data.
- **Freshness** — the index fails if older than 48h, so a silently dead cron
  cannot go unnoticed.
- **Integrity** — no duplicate, invalid, or dead URLs may be published.
- **Size** — a gzip budget on the critical path, the largest shard, and
  bytes-per-record, so an unbounded field cannot be added quietly.
- **Reproducibility** — a rebuild must produce no diff, including the manifest
  and generated pages.
- **Page quality** — generated pages must have titles, descriptions, canonical
  links, and no mojibake.
- **Behaviour** — the UI is driven in a real headless browser.
