/**
 * ghindex read-side (M3).
 *
 * Search runs in a Web Worker (search-worker.js) so keystrokes never block.
 * Two views over the same result set:
 *   - row  : dense list, keyboard-friendly, the default
 *   - grid : live iframe previews, lazily mounted, capped and virtualized
 *
 * Grid previews are viable because only ~1.5% of live Pages sites send a
 * framing-blocking header (measured in M0/M1). Cross-origin iframes still fire
 * no reliable load event, so a card that cannot render shows a link fallback
 * rather than an empty frame.
 */

const $ = (id) => document.getElementById(id);
const DATA = "./data/";
const PAGE = 60; // rows rendered per page; sentinel appends more

/**
 * Report/submit links, built as pre-filled GitHub issue URLs. The site is
 * static with no backend, so this is the only submission mechanism that needs
 * no server and no third-party form service. Configured via REPORT_REPO at
 * build time and read from data/reports.json at runtime.
 */
let reportRepo = "velo4705/ghindex";

function issueUrl(title, body, labels) {
  const p = new URLSearchParams({ title, body });
  if (labels) p.set("labels", labels);
  return `https://github.com/${reportRepo}/issues/new?${p.toString()}`;
}

function reportBrokenUrl(siteUrl) {
  return issueUrl(
    `Dead or incorrect: ${siteUrl}`,
    [
      "## Report: problem with an indexed site",
      "",
      `- **Site:** ${siteUrl}`,
      "- **Observed:** (dead / 404 / wrong content / miscategorised)",
      "",
      "The nightly job re-probes reported sites on the next run. If the site is",
      "dead it moves through the backoff schedule and is eventually unpublished.",
    ].join("\n"),
    "report",
  );
}

function submitSiteUrl(siteUrl, owner) {
  return issueUrl(
    `Submit: ${siteUrl}`,
    [
      "## Submit a site",
      "",
      `- **Site:** ${siteUrl}`,
      `- **Owner:** @${owner}`,
      "",
      "### Details",
      "",
      "- What is it?",
      "- Which category does it belong in?",
      "- Is it your site, and do you want it listed?",
    ].join("\n"),
    "submission",
  );
}

const state = {
  manifest: null,
  rows: [],
  total: 0,
  tags: [],
  cats: [],
  catLabels: {},
  activeTags: new Set(),
  activeCats: new Set(),
  minStars: 0,
  // Row is the default. Previews are heavy (each card is a live iframe of a
  // third-party page) and cannot be verified as loaded, so they are opt-in.
  view: "row", // 'row' | 'grid'
  rendered: 0,
  reqId: 0,
};

// ---------------------------------------------------------------- worker

const worker = new Worker("./search-worker.js", { type: "module" });

/**
 * If the worker cannot start (blocked, 404, syntax error), degrade to a
 * readable error instead of a page stuck on "Searching…" forever. This exact
 * failure mode shipped once already.
 */
worker.onerror = (e) => {
  const msg = $("meta");
  msg.textContent =
    `Search failed to start (${e.message || "worker error"}). ` +
    `The index data is still browsable at ./data/manifest.json.`;
  msg.style.color = "#f85149";
  $("q").disabled = true;
};

worker.onmessage = (e) => {
  const m = e.data;
  if (m.type === "ready") {
    $("count").innerHTML = `<b>${m.total.toLocaleString()}</b> live sites indexed`;
    return;
  }
  if (m.type === "landing") {
    renderLanding(m.landing);
    return;
  }
  if (m.type === "error") {
    $("meta").textContent = `Search error: ${m.message}`;
    return;
  }
  if (m.type !== "results") return;
  // Ignore stale responses: a newer query has already been issued.
  if (m.id !== state.reqId) return;

  state.rows = m.rows;
  state.total = m.total;
  state.tags = m.tags;
  state.cats = m.cats;
  state.rendered = 0;
  $("meta").textContent =
    `${m.total.toLocaleString()} match${m.total === 1 ? "" : "es"}` +
    `${m.total > m.rows.length ? ` (showing ${m.rows.length})` : ""} · ${m.elapsedMs}ms`;
  renderFacets();
  renderPage();
};

// ---------------------------------------------------------------- helpers

const esc = (s) =>
  String(s ?? "").replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

/**
 * Defense in depth: never emit an href/src we did not construct. Record URLs
 * come from a harvested corpus, so treat every one of them as untrusted input
 * even though the harvester validates them today.
 */
function safeUrl(u) {
  try {
    const url = new URL(u);
    if (url.protocol !== "https:" && url.protocol !== "http:") return null;
    const host = url.hostname.toLowerCase();
    if (host !== "github.io" && !host.endsWith(".github.io")) return null;
    return url.toString();
  } catch {
    return null;
  }
}

/** Reads a user-supplied token from the tab, if any. Never persisted. */
const userToken = () => $("token")?.value.trim() || "";

/**
 * On-demand search against GitHub, for sites outside the local index.
 *
 * The local index has hard edges: it holds only what our topic shards happened
 * to find. Measured against topics we never harvested, 96% of the Pages-enabled
 * owners we turned up were absent from it. GitHub can find them, so this widens
 * the net on demand rather than waiting for a harvest that can never enumerate
 * everything, because the API caps at 1,000 results per query.
 */
/**
 * State for the on-demand GitHub search.
 *
 * `pages` is how many pages of 100 have been loaded so far. It grows by one per
 * "show more" click rather than jumping to 10 at once, because the budget is
 * 10 requests/minute keyed to the visitor's IP: spending it all on the first
 * query means the second query fails. One page (~35 Pages sites) is enough for
 * an instant first screen; the rest are opt-in.
 */
const wide = {
  inflight: null,
  lastQuery: "",
  results: [],
  total: 0,
  pages: 0,
  truncated: false,
  hasMore: false,
  partial: null,
  error: null,
  loading: false,
  /**
   * Liveness verdicts, keyed by site URL.
   *
   * The local index is verified by the offline probe, but these results come
   * straight from GitHub, where `has_pages` is a repository setting that can be
   * weeks out of date with reality. A repo can have Pages switched on and serve
   * nothing at the derived URL, which is exactly what happens when the project
   * moved to a custom domain.
   */
  live: new Map(),
  verifyToken: 0,
};

/** Pages loaded per click. One page = 100 repos = ~35 Pages sites. */
const WIDE_PAGE_STEP = 1;

/** Debounce before asking GitHub, so typing does not spend the rate limit. */
const WIDE_DEBOUNCE_MS = 700;

/**
 * How many on-demand results to liveness-check, and how many at a time.
 *
 * Each check is a Worker invocation that makes a real request to someone else's
 * site, so this is capped rather than exhaustive: it covers the top results on
 * screen, which are the ones anyone is likely to click. Sequential in small
 * batches so a page of 80 results does not open 80 simultaneous connections to
 * unrelated hosts.
 */
const LIVE_CHECK_LIMIT = 24;
const LIVE_CHECK_CONCURRENCY = 5;

async function runWideSearch(opts = {}) {
  const q = $("q").value.trim();
  if (!q) {
    resetWide();
    renderWide();
    return;
  }

  const fresh = opts.fresh || wide.lastQuery !== q;
  if (!fresh && wide.results.length && !opts.more) return;
  // "More" is an explicit click, so it always spends a request.
  const pages = fresh ? WIDE_PAGE_STEP : wide.pages + WIDE_PAGE_STEP;

  wide.inflight?.abort();
  const ctrl = new AbortController();
  wide.inflight = ctrl;
  wide.loading = true;
  if (fresh) {
    wide.error = null;
    wide.partial = null;
  }
  renderWide(fresh ? "Asking GitHub…" : null);

    const { searchGitHub } = await import("./github-search.js");

  /**
   * An aborted search is not a failure, it is a superseded one: typing another
   * character aborts the previous request, and searchGitHub rethrows AbortError
   * so its callers can tell the two apart. That rethrow used to escape
   * unhandled, because every call site here is a timer callback or an event
   * handler that ignores the returned promise. The result was a
   * `Uncaught (in promise) AbortError` in the console on every fast typist,
   * which the browser test caught as "no console errors" failing intermittently
   * depending on how the keystrokes interleaved.
   */
  let res;
  try {
    res = await searchGitHub(q, {
      token: userToken(),
      signal: ctrl.signal,
      pages,
    });
  } catch (err) {
    if (err && err.name === "AbortError") {
      wide.inflight = null;
      wide.loading = false;
      return;
    }
    wide.inflight = null;
    wide.loading = false;
    wide.error = `Could not reach GitHub (${String(err).slice(0, 60)}).`;
    renderWide();
    return;
  }
  if (ctrl.signal.aborted) return;

  wide.inflight = null;
  wide.loading = false;
  wide.lastQuery = q;
  wide.pages = res.pagesFetched;
  wide.results = res.results;
  wide.total = res.total;
  wide.truncated = res.truncated;
  wide.hasMore = res.hasMore;
  wide.partial = res.partial ?? null;
  wide.error = res.error ?? null;

  // Verdicts are kept across queries on purpose: a URL that resolved five
  // minutes ago will very likely resolve now, and re-checking it would spend
  // another Worker request for no new information. Bounded so a long session
  // cannot grow it without limit.
  if (wide.live.size > 200) wide.live.clear();

  renderWide();
  // Liveness is a follow-up, not part of the search: the list appears first and
  // gains badges as answers arrive, so a slow site never delays results.
  if (!wide.error) verifyWideResults();
}

/** Drop every on-demand result; used when the query box is cleared. */
function resetWide() {
  wide.inflight?.abort();
  wide.inflight = null;
  wide.loading = false;
  wide.lastQuery = "";
  wide.results = [];
  wide.total = 0;
  wide.pages = 0;
  wide.truncated = false;
  wide.hasMore = false;
  wide.partial = null;
  wide.error = null;
}

const LIVE_BADGES = {
  checking: { cls: "live-checking", text: "checking…" },
  alive: { cls: "live-alive", text: "live" },
  gone: { cls: "live-gone", text: "dead link" },
  blocked: { cls: "live-blocked", text: "blocks bots" },
  unreachable: { cls: "live-gone", text: "unreachable" },
  error: { cls: "live-unknown", text: "unverified" },
};

function livePillHtml(url) {
  const v = wide.live.get(url);
  const badge = LIVE_BADGES[v];
  if (!badge) return "";
  const why =
    v === "blocked"
      ? "This site refused an automated request. It may still work in a browser."
      : v === "gone"
        ? "The site did not answer. The repo says Pages is on, but nothing is served here."
        : v === "unreachable"
          ? "The host did not respond."
          : v === "alive"
            ? "Checked just now and responding."
            : "";
  return `<span class="pill ${badge.cls}"${why ? ` title="${esc(why)}"` : ""}>${esc(badge.text)}</span>`;
}

function wideRowHtml(r) {
  const href = r.url;
  if (!href) return "";
  const title = r.full_name || `${r.owner}/${r.repo}`;
  const tags = (r.topics ?? [])
    .slice(0, 4)
    .map((t) => `<span class="tag">${esc(t)}</span>`)
    .join("");
  const stars = Number(r.stars) || 0;
  const starBadge = stars
    ? `<span class="pill stars" title="${stars.toLocaleString()} GitHub stars">★ ${stars.toLocaleString()}</span>`
    : "";
  // data-live lets a finished check patch its own row instead of re-rendering
  // the list, which would otherwise move the page under the reader.
  return `<article class="row" data-live="${esc(href)}">
    <h3><a href="${esc(href)}" target="_blank" rel="noopener noreferrer">${esc(title)}</a>
      ${livePillHtml(href)}${starBadge}<span class="pill">not indexed</span></h3>
    <div class="url">${esc(href)}</div>
    ${r.description ? `<div class="desc">${esc(r.description)}</div>` : ""}
    <div class="tags">${tags}</div>
  </article>`;
}

/**
 * Liveness-check the on-demand results, then patch each row as its answer lands.
 *
 * Deliberately not awaited by the search: results appear immediately and are
 * annotated afterwards, so a slow or unreachable site never delays the list.
 * Rows that are confirmed gone are dimmed rather than removed, because a
 * transient failure should not hide a result, and a dead link is still a fact
 * the reader may want to see.
 */
async function verifyWideResults() {
  const { verifyLiveness, edgeEndpoint } = await import("./github-search.js");

  /**
   * With no edge configured there is nothing to ask: a browser cannot make this
   * check at all, because a cross-origin HEAD returns an opaque response. Skip
   * it entirely rather than stamping "unverified" on every row, which would be
   * both noise and a worse reading experience than the plain note.
   */
  if (!edgeEndpoint()) return;

  const token = ++wide.verifyToken;

  const pending = wide.results
    .map((r) => r.url)
    .filter((u) => u && !wide.live.has(u))
    .slice(0, LIVE_CHECK_LIMIT);
  if (!pending.length) return;

  // Marking first means a row renders as "checking…" immediately instead of
  // looking unverified while the request is in flight.
  for (const u of pending) wide.live.set(u, "checking");
  paintLiveRows();

  const queue = pending.slice();
  const worker = async () => {
    while (queue.length) {
      const url = queue.shift();
      // A newer search has taken over; stop annotating rows that are gone.
      if (token !== wide.verifyToken) return;
      let res;
      try {
        res = await verifyLiveness(url);
      } catch {
        res = null;
      }
      if (token !== wide.verifyToken) return;
      wide.live.set(url, res?.verdict ?? "error");
      paintLiveRows();
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(LIVE_CHECK_CONCURRENCY, queue.length) }, worker),
  );
}

/**
 * Update just the rows whose verdict changed, instead of re-rendering the whole
 * section. Re-rendering would discard focus and scroll position mid-read, and
 * the list can be long.
 */
function paintLiveRows() {
  for (const row of document.querySelectorAll("#wide-results [data-live]")) {
    const url = row.getAttribute("data-live");
    const v = wide.live.get(url);
    if (!v) continue;
    const badge = LIVE_BADGES[v];
    row.classList.toggle("is-gone", v === "gone" || v === "unreachable");
    let pill = row.querySelector(".pill.live-alive, .pill.live-gone, .pill.live-blocked, .pill.live-unknown, .pill.live-checking");
    if (!pill) {
      const host = row.querySelector("h3");
      if (!host) continue;
      pill = document.createElement("span");
      const idx = host.querySelector(".pill");
      host.insertBefore(pill, idx ?? null);
    }
      pill.className = `pill ${badge.cls}`;
    pill.textContent = badge.text;
    const why =
      v === "blocked"
        ? "This site refused an automated request. It may still work in a browser."
        : v === "gone"
          ? "The site did not answer. The repo says Pages is on, but nothing is served here."
          : v === "unreachable"
            ? "The host did not respond."
            : v === "alive"
              ? "Checked just now and responding."
              : "";
    if (why) pill.setAttribute("title", why);
    else pill.removeAttribute("title");
  }
}

/**
 * Render the on-demand results section.
 *
 * The id is `wide-results`, NOT `wide`: the trigger button is already
 * id="wide", and $("wide") here was resolving to that button, so the section
 * was never created and its HTML was written into the button instead.
 */
function renderWide(statusText) {
  let el = $("wide-results");
  if (!el) {
    el = document.createElement("section");
    el.id = "wide-results";
    el.className = "wide";
    el.setAttribute("aria-live", "polite");
    // Inside <main>, but BEFORE the scroll sentinel: the sentinel drives
    // infinite scroll and must stay the last element, or appended results
    // would land after the "load more" trigger.
    $("sentinel").before(el);
  }

  if (statusText) {
    el.innerHTML = `<h2>Searching all of GitHub</h2><p class="note">${esc(statusText)}</p>`;
    return;
  }
  if (wide.error) {
    el.innerHTML = `<h2>Search all of GitHub</h2><p class="note">${esc(wide.error)}</p>`;
    return;
  }
  if (!wide.results.length) {
    el.innerHTML = "";
    return;
  }

  const n = wide.results.length;
  const bits = [`${n.toLocaleString()} Pages site${n === 1 ? "" : "s"} from GitHub, most popular first`];
  if (wide.total > n) {
    bits.push(
      `GitHub reports ${wide.total.toLocaleString()} matching repos` +
        (wide.truncated ? ", and never returns more than 1,000 per query" : ""),
    );
  }
  if (wide.pages) bits.push(`${wide.pages} of up to 10 pages loaded`);
  if (wide.partial) bits.push(wide.partial);
  // The index below is verified offline. These come from GitHub, where
  // `has_pages` is a repository setting that can be weeks stale, so each one is
  // link-checked separately and badged with what was actually found.
  const checked = [...wide.live.values()].filter((v) => v !== "checking").length;
  bits.push(
    checked
      ? `Each result is link-checked as you see it. ${checked} checked; ` +
          `"blocks bots" means it refused an automated request, not that it is down.`
      : "Outside this index, so each result is link-checked separately.",
  );

  const more =
    wide.hasMore || wide.loading
      ? `<button type="button" id="wide-more" class="btn" ${wide.loading ? "disabled" : ""}>` +
        (wide.loading ? "Loading…" : `Show more (${n.toLocaleString()} so far)`) +
        `</button>`
      : wide.total > n
        ? `<p class="note">Reached GitHub's per-query limit. Narrow the search to see different results.</p>`
        : "";

  el.innerHTML =
    `<h2>Also on GitHub</h2><p class="note">${esc(bits.join(" "))}</p>` +
    wide.results.map(wideRowHtml).join("") +
    more;
}

function tagsHtml(row) {
  const cats = (row.c ?? [])
    .map((c) => `<span class="cat-chip" title="${esc(state.catLabels[c] ?? c)}">${esc(state.catLabels[c] ?? c)}</span>`)
    .join("");
  const tags = (row.g ?? [])
    .slice(0, 3)
    .map((g) => `<span class="tag">${esc(g)}</span>`)
    .join("");
  return `<span class="chips">${cats}${tags}</span>`;
}

function runSearch() {
  state.reqId++;
  $("meta").textContent = "Searching…";
  worker.postMessage({
    type: "query",
    id: state.reqId,
    q: $("q").value,
    filters: {
      tags: [...state.activeTags],
      cats: [...state.activeCats],
      minStars: state.minStars,
    },
  });
}

// ---------------------------------------------------------------- landing

/**
 * The front page's browse surface: shelves by kind, plus a band of obscure sites.
 *
 * The reasoning for it is in search-worker.js where it is built. The short
 * version: the unfiltered list is ordered by stars, and the top of that list is
 * framework documentation and "awesome" lists, which is a poor answer to "what
 * is out there?". So the landing leads with browsable shelves and something
 * genuinely obscure, and the star-ordered list stays below where it belongs.
 */
const landing = { shelves: [], live: new Map() };

/**
 * Hide the landing once the reader has asked for something specific.
 *
 * It is a first impression, not a permanent fixture. Keeping it above results
 * that already match a query would just push the answer they asked for down the
 * page.
 */
function hideLanding() {
  const el = $("landing");
  if (el && !el.hidden) {
    el.hidden = true;
    $("shelves").innerHTML = "";
  }
}

function landingCardHtml(row) {
  const stars = Number(row.s) || 0;
  const label = `${row.o}/${row.r}`;
  return `<div class="card-mini" data-live="${esc(row.u)}">
    <a href="${esc(safeUrl(row.u))}" target="_blank" rel="noopener noreferrer">${esc(row.t || label)}</a>
    ${row.d ? `<p class="desc">${esc(row.d)}</p>` : ""}
    <div class="foot">
      <span>${stars.toLocaleString()} ★</span>
      <span class="live-slot"></span>
    </div>
  </div>`;
}

function renderLanding(data) {
  landing.shelves = data?.shelves ?? [];

  $("shelves").innerHTML = landing.shelves
    .map(
      (s) => `<div class="shelf">
        <div class="shelf-head">
          <h2>${esc(s.label)}</h2>
          <p class="blurb">${esc(s.blurb)} · ${s.count.toLocaleString()} in this index</p>
          <button type="button" class="shelf-more" data-cats="${esc(s.cats.join(","))}">
            Show all ${s.count.toLocaleString()}
          </button>
        </div>
        <div class="shelf-strip">${s.rows.map(landingCardHtml).join("")}</div>
      </div>`,
    )
    .join("");

  $("landing").hidden = false;
  verifyLanding();
}

/**
 * Link-check the landing cards.
 *
 * These rows are probe-verified offline, but that pass can be days old, so the
 * date alone is not enough to claim a card works.
 *
 * The worker caps a batch at six distinct hosts and twelve URLs, so the chunks
 * are six URLs long: six URLs can span at most six hosts, which is inside both
 * limits without having to reason about host grouping here. One request per six
 * cards rather than one per card.
 */
const LANDING_CHUNK = 6;

async function verifyLanding() {
  const { verifyLivenessBatch } = await import("./github-search.js");
  const urls = Array.from(
    new Set(landing.shelves.flatMap((s) => s.rows.map((r) => r.u)).filter(Boolean)),
  );

  for (let i = 0; i < urls.length; i += LANDING_CHUNK) {
    const found = await verifyLivenessBatch(urls.slice(i, i + LANDING_CHUNK));
    for (const [url, v] of found) landing.live.set(url, v);
    paintLanding();
  }
}

function paintLanding() {
  for (const card of document.querySelectorAll("#landing [data-live]")) {
    const url = card.getAttribute("data-live");
    const v = landing.live.get(url);
    if (!v) continue;
    const verdict = v.verdict;
    card.classList.toggle("is-gone", verdict === "gone" || verdict === "unreachable");
    const slot = card.querySelector(".live-slot");
    if (!slot) continue;
    const badge = LIVE_BADGES[verdict];
    if (!badge) continue;
    const existing = slot.querySelector(".pill");
    if (existing) existing.remove();
    slot.innerHTML = `<span class="pill ${badge.cls}" title="${esc(landingWhy(verdict))}">${esc(badge.text)}</span>`;
  }
}

function landingWhy(verdict) {
  if (verdict === "blocked") return "This site refused an automated request. It may still work in a browser.";
  if (verdict === "gone") return "Checked just now and nothing is being served.";
  if (verdict === "unreachable") return "Checked just now and the host did not respond.";
  if (verdict === "alive") return "Checked just now and responding.";
  return "";
}

/** "Show all N" on a shelf applies the same category filter the facet uses. */
document.addEventListener("click", (e) => {
  if (!(e.target instanceof HTMLElement)) return;
  const btn = e.target.closest(".shelf-more");
  if (!btn) return;
  state.activeCats = new Set(btn.dataset.cats.split(",").filter(Boolean));
  $("q").value = "";
  // The wide results belong to the query being replaced, so they go too.
  resetWide();
  hideLanding();
  runSearch();
});

// ---------------------------------------------------------------- facets

/**
 * Categories are the primary browse control (they answer "what kind of thing
 * is this?"). Raw topics are secondary detail. Both are kept: topics drive
 * free-text search, categories drive browsing.
 */
function renderFacets() {
  const cats = state.cats
    .map(([id, n]) => ({ id, n, label: state.catLabels[id] ?? id }))
    .sort((a, b) => b.n - a.n);

  $("cats").innerHTML = cats
    .map(
      (c) =>
        `<button type="button" class="cat" data-cat="${esc(c.id)}" aria-pressed="${state.activeCats.has(c.id)}">` +
        `${esc(c.label)}<span class="n">${c.n.toLocaleString()}</span></button>`,
    )
    .join("");

  const shown = state.tags.slice(0, 18);
  $("facets").innerHTML = shown
    .map(
      ([t, n]) =>
        `<button type="button" class="facet" data-tag="${esc(t)}" aria-pressed="${state.activeTags.has(t)}">` +
        `${esc(t)}<span class="n">${n}</span></button>`,
    )
    .join("");
}

$("cats").addEventListener("click", (e) => {
  const btn = e.target.closest(".cat");
  if (!btn) return;
  const id = btn.dataset.cat;
  if (state.activeCats.has(id)) state.activeCats.delete(id);
  else state.activeCats.add(id);
  hideLanding();
  runSearch();
});

$("facets").addEventListener("click", (e) => {
  const btn = e.target.closest(".facet");
  if (!btn) return;
  const tag = btn.dataset.tag;
  if (state.activeTags.has(tag)) state.activeTags.delete(tag);
  else state.activeTags.add(tag);
  runSearch();
});

// ---------------------------------------------------------------- render

function rowHtml(r) {
  const href = safeUrl(r.u);
  if (!href) return "";
  return `<article class="row">
    <h3><a href="${esc(href)}" target="_blank" rel="noopener noreferrer">${esc(r.t ?? r.r)}</a></h3>
    <div class="url">${esc(href)}</div>
    ${r.d ? `<div class="desc">${esc(r.d)}</div>` : ""}
    <div class="tags">${tagsHtml(r)}</div>
    <div class="row-actions">
      <a href="${esc(reportBrokenUrl(href))}" target="_blank" rel="noopener noreferrer">Report problem</a>
      <a href="${esc(submitSiteUrl(href, r.o))}" target="_blank" rel="noopener noreferrer">Claim / submit</a>
    </div>
  </article>`;
}

function cardHtml(r) {
  const href = safeUrl(r.u);
  if (!href) return "";
  // sandbox blocks scripts/top-navigation in previews; allow-same-origin keeps
  // the about:blank heuristic working. A hostile page still cannot script
  // against our origin because we send no cookies and use a null referrer.
  return `<article class="card">
    <div class="frame">
      <iframe src="${esc(href)}" loading="lazy" sandbox="allow-same-origin"
              referrerpolicy="no-referrer" title="Preview of ${esc(r.t ?? r.r)}"></iframe>
      <div class="fallback">Preview unavailable —<br /><a href="${esc(href)}"
        target="_blank" rel="noopener noreferrer">open site</a></div>
    </div>
    <div class="info">
      <a class="title" href="${esc(href)}" target="_blank" rel="noopener noreferrer">${esc(r.t ?? r.r)}</a>
      <div class="u">${esc(href)}</div>
      <div class="tags">${tagsHtml(r)}</div>
    </div>
  </article>`;
}

function renderPage() {
  const el = $("results");
  el.className = state.view === "grid" ? "grid" : "list";
  const slice = state.rows.slice(state.rendered, state.rendered + PAGE);
  const html = state.view === "grid" ? slice.map(cardHtml).join("") : slice.map(rowHtml).join("");
  if (state.rendered === 0) el.innerHTML = html;
  else el.insertAdjacentHTML("beforeend", html);
  state.rendered += slice.length;

  if (state.view === "grid") attachFrameFallbacks();

  $("sentinel").hidden = state.rendered >= state.rows.length;
  if (state.rendered === 0) {
    el.innerHTML = `<div class="empty">No matches. Try a shorter query or clear a filter.</div>`;
  }
}

/**
 * Previews are left alone entirely.
 *
 * An earlier version tried to detect a blocked frame by reading the iframe's
 * own location after 3.5s: a cross-origin frame throws a SecurityError, and
 * that throw was treated as "loaded fine", while a frame sitting on
 * about:blank was treated as "blocked". Measured against the real corpus that
 * got it backwards for 46 of 60 cards: frames that had genuinely rendered were
 * hidden behind a "Preview unavailable" fallback, and the ones it hid were the
 * ones working. A cross-origin iframe simply cannot be introspected from here,
 * so the only honest options are to show it or not.
 *
 * A site that refuses framing renders as a blank box; the title and link below
 * the frame always remain, so the card is still usable.
 */
function attachFrameFallbacks() {
  // Intentionally a no-op. Kept as a seam in case a future service can supply
  // real screenshot thumbnails, which would be the only reliable fix.
}

// Infinite page-in, only while more results remain.
new IntersectionObserver(
  (entries) => {
    if (entries.some((e) => e.isIntersecting) && state.rendered < state.rows.length) {
      renderPage();
    }
  },
  { rootMargin: "600px" },
).observe($("sentinel"));

// ---------------------------------------------------------------- controls

$("f").addEventListener("submit", (e) => {
  e.preventDefault();
  runSearch();
});

let debounce;
let wideDebounce;
$("q").addEventListener("input", () => {
  // Typing is asking a specific question, so the browse surface gets out of the
  // way rather than sitting between the reader and the answer.
  hideLanding();
  clearTimeout(debounce);
  debounce = setTimeout(runSearch, 200);
  // Ask GitHub too, but only once typing pauses. The unauthenticated search
  // budget is 10 requests/minute keyed to the visitor's IP, so searching on
  // every keystroke would exhaust it within one sentence. A pause means a
  // deliberate query.
  clearTimeout(wideDebounce);
  wideDebounce = setTimeout(() => runWideSearch(), WIDE_DEBOUNCE_MS);
});

/** "Show more" is delegated, because the button is re-rendered on every update. */
document.addEventListener("click", (e) => {
  if (e.target instanceof HTMLElement && e.target.id === "wide-more") {
    runWideSearch({ more: true });
  }
});

$("view").addEventListener("click", () => {
  state.view = state.view === "row" ? "grid" : "row";
  const btn = $("view");
  btn.setAttribute("aria-pressed", String(state.view === "grid"));
  // The label lives in a <span> so the icon survives the swap.
  const label = btn.querySelector("span");
  if (label) label.textContent = state.view === "grid" ? "List view" : "Previews";
  btn.title = state.view === "grid" ? "Back to list view" : "Show a live preview of each site";
  state.rendered = 0;
  renderPage();
});

$("stars").addEventListener("change", (e) => {
  state.minStars = Number(e.target.value);
  runSearch();
});

/**
 * The button now only reveals the token field.
 *
 * Searching GitHub used to require this click. It does not any more: typing
 * triggers a debounced search automatically. Keeping an explicit trigger would
 * suggest the on-demand results are optional, when they are now the wider half
 * of every search, so the button is reduced to the one thing that genuinely
 * still needs a click -- supplying a token.
 */
$("wide").addEventListener("click", () => {
  const showing = $("tokenrow").hidden;
  $("tokenrow").hidden = !showing;
  if (showing) $("token").focus();
  // Re-run only if there is already something to extend.
  if (!showing && wide.lastQuery) runWideSearch({ fresh: true });
});

// A token is supplied per tab; it is never written to storage.
$("token").addEventListener("change", () => {
  if (wide.lastQuery) {
    // Re-run so the new limit takes effect for the current query.
    wide.lastQuery = "";
    runWideSearch({ fresh: true });
  }
});

// ---------------------------------------------------------------- boot

try {
  const res = await fetch(`${DATA}manifest.json`);
  if (!res.ok) throw new Error(`manifest ${res.status}`);
  state.manifest = await res.json();
  for (const c of state.manifest.categories ?? []) state.catLabels[c.id] = c.label;

  // Report links are optional: a missing config must not break search.
  fetch(`${DATA}reports.json`)
    .then((r) => (r.ok ? r.json() : null))
    .then((cfg) => { if (cfg?.repo) reportRepo = cfg.repo; })
    .catch(() => {});

  worker.postMessage({ type: "init", manifest: state.manifest });
  runSearch();
} catch (err) {
  $("meta").textContent = `Could not load index: ${err.message}. Run 'bun run build'.`;
}
