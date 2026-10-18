<div align="center">

# ghindex

**A Live GitHub IO Indexer — A Search Engine Made For GitHub IO Pages**

**[🔎 Explore the Search Engine](https://velo4705.github.io/ghindex/)**

</div>

## How it works

Like a regular search engine, **Search anything you wanted**, just to look for some unique IO pages made by many open-source contributors. Tags are helpful if you can't think of searching something. You can also find and enter a random IO page by clicking the "**Surprise me**" button, which works just as if you are feeling lucky.

This uses a **Live Index** of GitHub IO Pages loaded from keywords or tags. Perhaps, you might be able to explore some niche IO pages that you are unfamiliar with.

The Search Engine has **three orderings** - "Best match" (default), "Most stars", and "Recently updated", which appear after searching from a query.

They answer three different questions, and none of them replaces the others. **Best match** finds the repository you half-remember. **Most stars** finds the well-known one. **Recently updated** finds what someone deployed minutes ago - GitHub returns its live tail here, so it is the one to use when you cannot yet name what you are looking for. Its trade is depth rather than breadth: the newest repositories are usually brand new and unranked, so roughly a fifth of that page has an IO page, against about a third for the others.

Each repository displays its star count, and only those with an **IO page** appear at all. On request - press **Check which are still live** - each row is also marked with a **status**: a live page, or a dead link (struck out anyway, because a dead link is still a fact worth showing). A third one, **blocks bots**, means the site refused the automated check - it will very likely still open fine in a browser, so don't take it for a dead link. The check is opt-in because it costs a request against a budget everyone shares; the results are complete without it.

The page itself is hosted on **GitHub Pages**, but a browser can't hold a GitHub token, so the searching is done by a small **Cloudflare Worker** that keeps one for us.

### How do you search it?

You can type anything straight into the search box, or pick tags underneath it if you can't think of what to type. The tags are just words, so picking "portfolio" and typing "resume" searches for both at once, and you can stack as many as you like - each one sits in the search box with an **×** to take it off again. Whatever combination you end up with is what gets searched.

Only repositories that actually have an **IO page** are ever shown, which is why some searches come back with fewer results than you might expect.

It helps to read those numbers as a funnel, because a small result count is usually the shape of the data rather than something wrong with the search. GitHub reports how many repositories match a keyword - sometimes in the millions - but it refuses to serve past the **first 1,000 results**, so that is the most any single search can ever reach, which is why the results are split into **ten numbered pages** rather than twenty-five: ten calls of a hundred repositories is exactly that ceiling, so every page the pager offers is one GitHub will answer. Twenty-five pages would need 2,500 repositories, and page 11 onwards would fail outright instead of merely running out. Note that what is fetched and what is shown are deliberately different numbers: the site asks GitHub for **100 repositories** a page and shows the **first 40 sites** among them. Only about a **third** of matching repositories actually have an IO page - the rest merely mention the words - so fetching a hundred is what makes a genuinely full page of forty possible, and it is why a page may show fewer than forty when a query matches few live sites. A keyword with a seven-figure match count showing a few dozen sites is the honest answer rather than a truncated one. The true total is always displayed, along with the depth GitHub actually permits.

### Why is it never cached?

The reason of why we never cache GitHub IO Pages is due to its sheer count. Estimating around **7,000,000+ IO Pages** across GitHub, Caching every single repository is a bad idea due to a takeaway in storage.

We implemented a **Dynamic Live Indexer** that appears when you are done typing. This type of Index fetches repositories that are **best matched** to the query.

However, this doesn't solve the ~7M Page showcase on GitHub, so we limited the maximum number of repositories using that keyword for the **first 1,000 repositories**, while it actually shows its true count of how many repositories found using that keyword. This doesn't mean we limit a lot of repositories, as niche ones can be found just by **broadening the search keyword** further.

### What about the rate limit?

A browser can't hold a GitHub token, because anything in a static page is public. So the search goes through a small Cloudflare Worker that keeps one read-only token on the server side, which gets us 30 searches a minute instead of the anonymous 10. The catch is that the token belongs to the worker, so everyone shares that one budget rather than getting 30 each.

Typing is debounced and results are cached at the edge, so searching the same thing twice costs nothing. Three things keep the shared budget from being spent by accident:

- **Simultaneous identical searches cost one GitHub call.** A cold cache plus a burst of people searching the same word would otherwise send one request per visitor; they now wait on a single shared one. Different words never wait on each other, so a popular term can't queue up the rest of the site.
- **Link-checking is opt-in.** It runs only when someone presses the button, because a reader who never looks at the badges shouldn't pay for them.
- **The common searches are warmed on a schedule.** A cron trigger pre-fills the cache for the terms people actually arrive on, so the first visitor of the hour doesn't pay for everyone else's copy.

When the ceiling is genuinely reached, the page says so instead of showing an empty result list.

---

### Can I use this code?

Yes — the source is MIT licensed, so you can copy it, change it and ship it.
See [LICENSE](LICENSE).

Two assets are vendored rather than written here and keep their own terms: the
**Space Grotesk** wordmark (SIL Open Font License 1.1) and **particles.js**
(MIT), which draws the background star field. Both notices are in
[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).

If you spot something broken or want to improve it, a pull request is welcome.
There is no formal process — open an issue first if the change is large enough
that we'd rather talk it through than review a surprise.
