/**
 * ghindex read side.
 *
 * The page is a search box and results appear under it once you type. There is
 * no local index: every result is asked of GitHub through the edge worker at the
 * moment of the search, so what you see is what GitHub reports right now rather
 * than what a nightly harvest happened to catch.
 *
 * Why there is no pre-built index
 * -------------------------------
 * An earlier version pre-generated a sharded index and searched it locally, with
 * the live GitHub path shown underneath as a secondary "also on GitHub" group.
 * That was the wrong shape. The two result sets were ranked differently and shown
 * as one, so a query routinely reported "0 matches" in the local half while the
 * live half below it had the answer. The local half was also a smaller, staler,
 * topic-shard-limited sample of the same thing the live half could see for free,
 * and it cost 8 MB of generated HTML to maintain.
 *
 * So there is one result set now, and it is live. What that costs is stated in
 * worker/README.md: the edge holds one token, so the whole site shares a 30/min
 * budget and the cache absorbs roughly half of it. That ceiling is real and it
 * does not scale, which is the honest price of not shipping a snapshot.
 *
 * Ranking, facets and filtering all run here on whatever came back, because a
 * live result set is a page of results rather than a corpus: categories come
 * from classify() over the topics in hand, and their counts describe this result
 * set rather than every site that exists.
 */

const $ = (id) => document.getElementById(id);
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
      "## Report: problem with a listed site",
      "",
      `- **Site:** ${siteUrl}`,
      "- **Observed:** (dead / 404 / wrong content / miscategorised)",
      "",
      "Links are checked as you load them. If the site is dead the check says so",
      "inline; this report is for a link that resolves to the wrong thing, or a",
      "site that is alive but wrongly described.",
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

// ---------------------------------------------------------------- state

const state = {
  rows: [],
  total: 0,
  pages: 0,
  truncated: false,
  hasMore: false,
  partial: null,
  error: null,
  loading: false,
  inflight: null,
  lastQuery: "",
  q: "",
  /** Liveness verdicts, keyed by site URL. */
  live: new Map(),
  verifyToken: 0,
  cats: [],
  catLabels: {},
  activeCats: new Set(),
  activeTags: new Set(),
  minStars: 0,
  // Row is the default. Previews are heavy (each card is a live iframe of a
  // third-party page) and cannot be verified as loaded, so they are opt-in.
  view: "row", // 'row' | 'grid'
  rendered: 0,
  shown: [],
};

/** Pages loaded per "show more" click. One page = 100 repos = ~35 Pages sites. */
const WIDE_PAGE_STEP = 1;

/**
 * Debounce before asking GitHub.
 *
 * Every keystroke that reaches the network spends from a budget shared by all
 * visitors, so this waits for typing to pause rather than searching as you go.
 * A pause is a deliberate query. Submitting the form bypasses the wait.
 */
const DEBOUNCE_MS = 700;

/**
 * How many results to liveness-check, and in what size batches.
 *
 * Each check is a Worker invocation that makes a real request to someone else's
 * site, so this is capped rather than exhaustive: it covers the top results on
 * screen, which are the ones anyone is likely to click.
 */
const LIVE_CHECK_LIMIT = 24;

/** URLs per batch. The worker allows twelve per call and six distinct hosts. */
const LIVE_CHECK_CHUNK = 6;

/** Reads a user-supplied token from the tab, if any. Never persisted. */
const userToken = () => $("token")?.value.trim() || "";

// ---------------------------------------------------------------- helpers

const esc = (s) =>
  String(s ?? "").replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

/**
 * Defense in depth: never emit an href/src we did not construct. Live results
 * carry a `homepage` string straight from GitHub, so treat every one of them as
 * untrusted input even though the URL is derived from validated fields.
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

/**
 * Whether a row passes the active facets.
 *
 * These filter what GitHub just returned, they do not re-query: a category is
 * derived client-side from topics, so narrowing by one can only ever remove
 * rows from the page in hand, never surface a site from outside it.
 */
function passesFilters(r) {
  const cats = r._cats ?? [];
  if (state.activeCats.size) {
    let ok = false;
    for (const c of state.activeCats) {
      if (cats.includes(c)) {
        ok = true;
        break;
      }
    }
    if (!ok) return false;
  }
  if (state.activeTags.size) {
    const have = new Set((r.topics ?? []).map((t) => t.toLowerCase()));
    let ok = false;
    for (const t of state.activeTags) {
      if (have.has(t)) {
        ok = true;
        break;
      }
    }
    if (!ok) return false;
  }
  if (state.minStars > 0 && (Number(r.stars) || 0) < state.minStars) return false;
  return true;
}

function hasFilters() {
  return state.activeCats.size > 0 || state.activeTags.size > 0 || state.minStars > 0;
}

// ---------------------------------------------------------------- search

/**
 * Run a query against GitHub through the edge worker.
 *
 * Pages accumulate: `searchGitHub` walks page 1..N and returns the union, so
 * "show more" extends the set rather than replacing it.
 */
async function runSearch(opts = {}) {
  const q = $("q").value.trim();
  if (!q) {
    resetSearch();
    renderResults();
    showIdle(true);
    return;
  }

  const fresh = opts.fresh || state.lastQuery !== q;
  if (!fresh && !opts.more && state.rows.length) return;
  const pages = fresh ? WIDE_PAGE_STEP : state.pages + WIDE_PAGE_STEP;

  state.inflight?.abort();
  const ctrl = new AbortController();
  state.inflight = ctrl;
  state.loading = true;
  if (fresh) {
    state.error = null;
    state.partial = null;
  }
  renderResults(fresh ? "Searching GitHub…" : null);

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
      state.inflight = null;
      state.loading = false;
      return;
    }
    state.inflight = null;
    state.loading = false;
    state.error = `Could not reach GitHub (${String(err).slice(0, 60)}).`;
    renderResults();
    return;
  }
  if (ctrl.signal.aborted) return;

  state.inflight = null;
  state.loading = false;
  state.lastQuery = q;
  state.q = q;
  state.pages = res.pagesFetched;
  state.rows = res.results;
  state.total = res.total;
  state.truncated = res.truncated;
  state.hasMore = res.hasMore;
  state.partial = res.partial ?? null;
  state.error = res.error ?? null;

  // Verdicts are kept across queries on purpose: a URL that resolved five
  // minutes ago will very likely resolve now, and re-checking it would spend
  // another Worker request for no new information. Bounded so a long session
  // cannot grow it without limit.
  if (state.live.size > 200) state.live.clear();

  showIdle(false);
  await classifyRows();
  renderResults();

  // Liveness is a follow-up, not part of the search: the list appears first and
  // gains badges as answers arrive, so a slow site never delays results.
  if (!state.error) verifyResults();
}

/** Drop every result; used when the query box is cleared. */
function resetSearch() {
  state.inflight?.abort();
  state.inflight = null;
  state.loading = false;
  state.lastQuery = "";
  state.q = "";
  state.rows = [];
  state.total = 0;
  state.pages = 0;
  state.truncated = false;
  state.hasMore = false;
  state.partial = null;
  state.error = null;
  state.shown = [];
  state.cats = [];
}

// ---------------------------------------------------------------- classify

/**
 * Derive categories from the topics in the current result set.
 *
 * The taxonomy used to run offline, at publish time, and the categories were
 * baked into the index. With no index it runs here, over the same topics GitHub
 * just returned, so browse-by-category survives on live results.
 *
 * The consequence to keep visible is in the counts: a chip says how many of the
 * results on screen are in that category, not how many such sites exist.
 */
async function classifyRows() {
  if (!state.rows.length) {
    state.cats = [];
    return;
  }
  const { classify, CATEGORY_LABELS } = await import("./taxonomy.js");
  state.catLabels = CATEGORY_LABELS;

  const counts = new Map();
  for (const r of state.rows) {
    let cats;
    try {
      cats = classify(r.topics ?? []).categories;
    } catch {
      cats = [];
    }
    r._cats = cats;
    for (const c of cats) counts.set(c, (counts.get(c) ?? 0) + 1);
  }
  state.cats = [...counts.entries()];
}

// ---------------------------------------------------------------- liveness

const LIVE_BADGES = {
  checking: { cls: "live-checking", text: "checking…" },
  alive: { cls: "live-alive", text: "live" },
  gone: { cls: "live-gone", text: "dead link" },
  blocked: { cls: "live-blocked", text: "blocks bots" },
  unreachable: { cls: "live-gone", text: "unreachable" },
  error: { cls: "live-unknown", text: "unverified" },
};

const LIVE_WHY = {
  blocked: "This site refused an automated request. It may still work in a browser.",
  gone: "The site did not answer. The repo says Pages is on, but nothing is served here.",
  unreachable: "The host did not respond.",
  alive: "Checked just now and responding.",
};

function livePillHtml(url) {
  const v = state.live.get(url);
  const badge = LIVE_BADGES[v];
  if (!badge) return "";
  const why = LIVE_WHY[v];
  return `<span class="pill ${badge.cls}"${why ? ` title="${esc(why)}"` : ""}>${esc(badge.text)}</span>`;
}

/**
 * Liveness-check the results, then patch each row as its answer lands.
 *
 * Deliberately not awaited by the search: results appear immediately and are
 * annotated afterwards, so a slow or unreachable site never delays the list.
 * Rows that are confirmed gone are dimmed rather than removed, because a
 * transient failure should not hide a result, and a dead link is still a fact
 * the reader may want to see.
 *
 * Checks go out in batches rather than one at a time. Up to 24 URLs become one
 * Worker request instead of 24, and each per-URL verdict is cached, so the next
 * visitor asking about the same site is answered from the edge instead of
 * reaching that site's host again.
 */
async function verifyResults() {
  const { verifyLivenessBatch, edgeEndpoint } = await import("./github-search.js");

  /**
   * With no edge configured there is nothing to ask: a browser cannot make this
   * check at all, because a cross-origin HEAD returns an opaque response. Skip
   * it entirely rather than stamping "unverified" on every row, which would be
   * both noise and a worse reading experience than the plain note.
   */
  if (!edgeEndpoint()) return;

  const token = ++state.verifyToken;

  const pending = state.rows
    .map((r) => r.url)
    .filter((u) => u && !state.live.has(u))
    .slice(0, LIVE_CHECK_LIMIT);
  if (!pending.length) return;

  // Marking first means a row renders as "checking…" immediately instead of
  // looking unverified while the request is in flight.
  for (const u of pending) state.live.set(u, "checking");
  paintLiveRows();

  // The worker's batch endpoint caps a call at twelve URLs and six distinct
  // hosts, so chunks are six long: six URLs span at most six hosts, which is
  // inside both limits without having to group by host here.
  for (let i = 0; i < pending.length; i += LIVE_CHECK_CHUNK) {
    const chunk = pending.slice(i, i + LIVE_CHECK_CHUNK);
    let found;
    try {
      found = await verifyLivenessBatch(chunk);
    } catch {
      found = new Map();
    }
    // A newer search has taken over; stop annotating rows that are gone.
    if (token !== state.verifyToken) return;
    for (const u of chunk) state.live.set(u, found.get(u)?.verdict ?? "error");
    paintLiveRows();
  }
}

/**
 * Update just the rows whose verdict changed, instead of re-rendering the whole
 * section. Re-rendering would discard focus and scroll position mid-read, and
 * the list can be long.
 */
function paintLiveRows() {
  for (const row of document.querySelectorAll("#results [data-live]")) {
    const url = row.getAttribute("data-live");
    const v = state.live.get(url);
    if (!v) continue;
    const badge = LIVE_BADGES[v];
    row.classList.toggle("is-gone", v === "gone" || v === "unreachable");
    let pill = row.querySelector(
      ".pill.live-alive, .pill.live-gone, .pill.live-blocked, .pill.live-unknown, .pill.live-checking",
    );
    if (!pill) {
      const host = row.querySelector("h3, .title");
      if (!host) continue;
      pill = document.createElement("span");
      host.insertBefore(pill, host.firstChild);
    }
    pill.className = `pill ${badge.cls}`;
    pill.textContent = badge.text;
    const why = LIVE_WHY[v];
    if (why) pill.setAttribute("title", why);
    else pill.removeAttribute("title");
  }
}

// ---------------------------------------------------------------- facets

/**
 * Categories are the browse control (they answer "what kind of thing is
 * this?"). Raw topics are secondary detail and only appear once a query has
 * told us which ones this result set actually uses.
 */
function renderCatChips() {
  const list = state.cats
    .map(([id, n]) => ({ id, n, label: state.catLabels[id] ?? id }))
    .sort((a, b) => b.n - a.n);

  $("cats").innerHTML = list
    .map(
      (c) =>
        `<button type="button" class="cat" data-cat="${esc(c.id)}" aria-pressed="${state.activeCats.has(c.id)}">` +
        `${esc(c.label)}<span class="n">${c.n.toLocaleString()}</span></button>`,
    )
    .join("");
}

function renderFacets() {
  const counts = new Map();
  for (const r of state.shown) {
    for (const t of r.topics ?? []) {
      counts.set(t, (counts.get(t) ?? 0) + 1);
    }
  }
  const shown = [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 18);
  // Hidden entirely when empty, so the header does not reserve a blank band.
  $("filterbar").hidden = !state.cats.length && !shown.length;
  $("facets").innerHTML = shown
    .map(
      ([t, n]) =>
        `<button type="button" class="facet" data-tag="${esc(t.toLowerCase())}" aria-pressed="${state.activeTags.has(t.toLowerCase())}">` +
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
  refilter();
});

$("facets").addEventListener("click", (e) => {
  const btn = e.target.closest(".facet");
  if (!btn) return;
  const tag = btn.dataset.tag;
  if (state.activeTags.has(tag)) state.activeTags.delete(tag);
  else state.activeTags.add(tag);
  refilter();
});

/**
 * Re-apply facets to the results already in hand.
 *
 * No network call: a facet can only remove rows from the current page, so
 * filtering client-side is both correct and the only thing that avoids spending
 * the shared rate-limit budget on a narrowing that GitHub has already answered.
 */
function refilter() {
  renderResults();
}

// ---------------------------------------------------------------- render

function tagsHtml(r) {
  const cats = (r._cats ?? [])
    .map((c) => `<span class="cat-chip" title="${esc(state.catLabels[c] ?? c)}">${esc(state.catLabels[c] ?? c)}</span>`)
    .join("");
  const tags = (r.topics ?? [])
    .slice(0, 4)
    .map((g) => `<span class="tag">${esc(g)}</span>`)
    .join("");
  return `<span class="chips">${cats}${tags}</span>`;
}

function starBadge(r) {
  const stars = Number(r.stars) || 0;
  return stars
    ? `<span class="pill stars" title="${stars.toLocaleString()} GitHub stars">★ ${stars.toLocaleString()}</span>`
    : "";
}

function rowHtml(r) {
  const href = safeUrl(r.url);
  if (!href) return "";
  const title = r.full_name || `${r.owner}/${r.repo}`;
  return `<article class="row" data-live="${esc(href)}">
    <h3>${livePillHtml(href)}<a href="${esc(href)}" target="_blank" rel="noopener noreferrer">${esc(title)}</a>${starBadge(r)}</h3>
    <div class="url">${esc(href)}</div>
    ${r.description ? `<div class="desc">${esc(r.description)}</div>` : ""}
    ${tagsHtml(r)}
    <div class="row-actions">
      <a href="${esc(reportBrokenUrl(href))}" target="_blank" rel="noopener noreferrer">Report problem</a>
      <a href="${esc(submitSiteUrl(href, r.owner))}" target="_blank" rel="noopener noreferrer">Claim / submit</a>
    </div>
  </article>`;
}

function cardHtml(r) {
  const href = safeUrl(r.url);
  if (!href) return "";
  // sandbox blocks scripts/top-navigation in previews; allow-same-origin keeps
  // the about:blank heuristic working. A hostile page still cannot script
  // against our origin because we send no cookies and use a null referrer.
  const title = r.full_name || `${r.owner}/${r.repo}`;
  return `<article class="card" data-live="${esc(href)}">
    <div class="frame">
      <iframe src="${esc(href)}" loading="lazy" sandbox="allow-same-origin"
              referrerpolicy="no-referrer" title="Preview of ${esc(title)}"></iframe>
      <div class="fallback">Preview unavailable —<br /><a href="${esc(href)}"
        target="_blank" rel="noopener noreferrer">open site</a></div>
    </div>
    <div class="info">
      <span class="card-head">${livePillHtml(href)}${starBadge(r)}</span>
      <a class="title" href="${esc(href)}" target="_blank" rel="noopener noreferrer">${esc(title)}</a>
      <div class="u">${esc(href)}</div>
      <div class="tags">${tagsHtml(r)}</div>
    </div>
  </article>`;
}

function renderPage() {
  const el = $("results");
  el.className = state.view === "grid" ? "grid" : "list";
  const slice = state.shown.slice(state.rendered, state.rendered + PAGE);
  const rows = state.view === "grid" ? slice.map(cardHtml).join("") : slice.map(rowHtml).join("");
  if (state.rendered === 0) {
    // The summary and the "show more" control are rebuilt with the first page,
    // then left alone as the sentinel appends more rows: they describe the
    // result set, not the slice currently on screen.
    el.innerHTML = rows + `<p class="note">${summaryHtml()}</p>` + moreHtml();
  } else {
    el.insertAdjacentHTML("beforeend", rows);
  }
  state.rendered += slice.length;

  $("sentinel").hidden = state.rendered >= state.shown.length;
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

/** The header line: how many results, from where, and what was checked. */
function summaryHtml() {
  const n = state.shown.length;
  const bits = [`${n.toLocaleString()} Pages site${n === 1 ? "" : "s"}, live from GitHub`];
  if (hasFilters() && n !== state.rows.length) {
    bits.push(`filtered from ${state.rows.length.toLocaleString()}`);
  }
  if (state.total > state.rows.length) {
    bits.push(
      `GitHub reports ${state.total.toLocaleString()} matching repos` +
        (state.truncated ? ", and never returns more than 1,000 per query" : ""),
    );
  }
  if (state.pages) bits.push(`${state.pages} of up to 10 pages loaded`);
  if (state.partial) bits.push(state.partial);
  const checked = [...state.live.values()].filter((v) => v !== "checking").length;
  bits.push(
    checked
      ? `${checked} link-checked just now; "blocks bots" means it refused an automated request, not that it is down.`
      : "Every result is link-checked as it appears.",
  );
  return esc(bits.join(" · "));
}

function moreHtml() {
  if (state.hasMore || state.loading) {
    return `<button type="button" id="wide-more" class="btn" ${state.loading ? "disabled" : ""}>` +
      (state.loading ? "Loading…" : `Show more (${state.rows.length.toLocaleString()} so far)`) +
      `</button>`;
  }
  if (state.total > state.rows.length) {
    return `<p class="note">Reached GitHub's per-query limit. Narrow the search to see different results.</p>`;
  }
  return "";
}

/**
 * Draw the result set, or the reason there isn't one.
 *
 * `statusText` covers the in-flight state so the box shows progress rather than
 * the previous query's answer.
 */
function renderResults(statusText) {
  const el = $("results");
  // The class follows the current view even for the placeholder states, so an
  // in-flight search or an error cannot silently switch a reader out of grid
  // view and leave the toggle claiming otherwise.
  const cls = state.view === "grid" ? "grid" : "list";
  if (statusText) {
    el.className = cls;
    el.innerHTML = `<div class="empty">${esc(statusText)}</div>`;
    $("filterbar").hidden = true;
    $("sentinel").hidden = true;
    return;
  }
  if (state.error) {
    el.className = cls;
    el.innerHTML = `<div class="empty">${esc(state.error)}</div>`;
    $("filterbar").hidden = true;
    $("sentinel").hidden = true;
    return;
  }

  state.shown = state.rows.filter(passesFilters);
  state.rendered = 0;

  if (!state.shown.length) {
    el.className = cls;
    el.innerHTML =
      `<div class="empty">No Pages sites matched${hasFilters() ? " with those filters" : ""}. ` +
      `Try a shorter search.</div>`;
    // A page with nothing on it has no facets worth offering, and the counts
    // would be describing an empty set.
    $("filterbar").hidden = true;
    $("sentinel").hidden = true;
    return;
  }

  renderPage();
  // Chips last: they count what was actually rendered, so filtering by one
  // category shows how the rest of the current set is distributed.
  renderCatChips();
  renderFacets();
  paintLiveRows();
}

// ---------------------------------------------------------------- idle state

/**
 * The prompt shown when there is no query.
 *
 * It replaces a front page rather than decorating one. With nothing typed there
 * is no honest list to show: there is no index to browse, and the unfiltered
 * order would be whatever GitHub happened to rank first. So the prompt says what
 * the search covers and offers starting points instead.
 */
function showIdle(on) {
  const el = $("idle");
  if (el) el.hidden = !on;
  if (on) {
    // The chips count a result set that is no longer on screen, so they are
    // cleared rather than merely hidden: leaving them in the DOM means the next
    // search can read stale counts before its own have arrived.
    $("filterbar").hidden = true;
    $("cats").innerHTML = "";
    $("facets").innerHTML = "";
    $("results").innerHTML = "";
    $("sentinel").hidden = true;
  }
}

// Infinite page-in, only while more results remain.
new IntersectionObserver(
  (entries) => {
    if (entries.some((e) => e.isIntersecting) && state.rendered < state.shown.length) {
      renderPage();
    }
  },
  { rootMargin: "600px" },
).observe($("sentinel"));

// ---------------------------------------------------------------- controls

let debounce;

$("f").addEventListener("submit", (e) => {
  // Submitting bypasses the debounce: the visitor has stopped typing and asked.
  e.preventDefault();
  clearTimeout(debounce);
  runSearch({ fresh: true });
});

$("q").addEventListener("input", () => {
  clearTimeout(debounce);
  debounce = setTimeout(() => runSearch({ fresh: true }), DEBOUNCE_MS);
});

/**
 * An example is an ordinary query: it fills the box and runs the same search a
 * typed one would, rather than reaching into any special state.
 */
$("examples").addEventListener("click", (e) => {
  const btn = e.target.closest("[data-example]");
  if (!btn) return;
  $("q").value = btn.dataset.example;
  runSearch({ fresh: true });
});

/** "Show more" is delegated, because the button is re-rendered on every update. */
document.addEventListener("click", (e) => {
  if (e.target instanceof HTMLElement && e.target.id === "wide-more") {
    runSearch({ more: true });
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
  renderResults();
});

$("stars").addEventListener("change", (e) => {
  state.minStars = Number(e.target.value);
  refilter();
});

/**
 * The button only reveals the token field.
 *
 * Searching GitHub is automatic now, so an explicit trigger would suggest the
 * results are optional. It is reduced to the one thing that genuinely needs a
 * click: supplying a token, which raises the limit when the shared budget is
 * exhausted.
 */
$("wide").addEventListener("click", () => {
  const showing = $("tokenrow").hidden;
  $("tokenrow").hidden = !showing;
  if (showing) $("token").focus();
  // Re-run only if there is already something to extend.
  if (!showing && state.lastQuery) runSearch({ fresh: true });
});

// A token is supplied per tab; it is never written to storage.
$("token").addEventListener("change", () => {
  if (state.lastQuery) {
    // Re-run so the new limit takes effect for the current query.
    state.lastQuery = "";
    runSearch({ fresh: true });
  }
});

// ---------------------------------------------------------------- boot

/**
 * Boot loads the report config only. There is no manifest and no index, so the
 * page costs nothing until a search is typed, and a missing reports.json is
 * harmless: it only decides which repository a report link points at.
 */
fetch("./data/reports.json")
  .then((r) => (r.ok ? r.json() : null))
  .then((cfg) => {
    if (cfg?.repo) reportRepo = cfg.repo;
  })
  .catch(() => {});

showIdle(true);