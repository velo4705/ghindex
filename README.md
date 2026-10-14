<div align="center">

# ghindex

**A Live GitHub IO Indexer — A Search Engine Made For GitHub IO Pages**

**[🔎 Explore the Search Engine](https://velo4705.github.io/ghindex/)**

</div>

## How it works

Like a regular search engine, **Search anything you wanted**, just to look for some unique IO pages made by many open-source contributors. Tags are helpful if you can't think of searching something.

This uses a **Live Index** of GitHub IO Pages loaded from keywords or tags. Perhaps, you might be able to explore some niche IO pages that you are unfamiliar with.

The Search Engine has **two filters** - "Best Match" (default) and "Most stars", which appears after searching from a query.

Each index has a **status** whether the repository has a live IO page, or is a dead link. Each repository displays its star count, and those repositories only appear if they have a **IO page**, regardless of whether it is **live**, or at **404** (is struck-out anyway due to dead links). A third one, **blocks bots**, means the site refused the automated check - it will very likely still open fine in a browser, so don't take it for a dead link.

The page itself is hosted on **GitHub Pages**, but a browser can't hold a GitHub token, so the searching is done by a small **Cloudflare Worker** that keeps one for us.

### How do you search it?

You can type anything straight into the search box, or pick tags underneath it if you can't think of what to type. The tags are just words, so picking "portfolio" and typing "resume" searches for both at once, and you can stack as many as you like - each one sits in the search box with an **×** to take it off again. Whatever combination you end up with is what gets searched.

Only repositories that actually have a **IO page** are ever shown, which is why some searches come back with fewer results than you might expect. And since GitHub refuses to go past **1,000 results** for any keyword, the page is split into **10 numbered pages** - it will always tell you the real total, even the part it can't reach.

### Why is it never cached?

The reason of why we never cache GitHub IO Pages is due to its sheer count. Estimating around **7,000,000+ IO Pages** across GitHub, Caching every single repository is a bad idea due to a takeaway in storage.

We implemented a **Dynamic Live Indexer** that appears when you are done typing. This type of Index fetches repositories that are **best matched** to the query.

However, this doesn't solve the ~7M Page showcase on GitHub, so we limited the maximum number of repositories using that keyword for the **first 1,000 repositories**, while it actually shows its true count of how many repositories found using that keyword. This doesn't mean we limit a lot of repositories, as niche ones can be found just by **broadening the search keyword** further.

### What about the rate limit?

A browser can't hold a GitHub token, because anything in a static page is public. So the search goes through a small Cloudflare Worker that keeps one read-only token on the server side, which gets us 30 searches a minute instead of the anonymous 10. The catch is that the token belongs to the worker, so everyone shares that one budget rather than getting 30 each.

Typing is debounced and results are cached at the edge, so searching the same thing twice costs nothing, but a burst of new terms from a lot of people at once can still hit the ceiling. When it does, the page says so instead of showing an empty result list.

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
