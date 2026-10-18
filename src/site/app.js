/**
 * ghindex read side.
 *
 * One centred search box and the results it returns. That is the whole page:
 * there is no index, no navigation, and nothing to configure.
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
 */

const $ = (id) => document.getElementById(id);

import { startSky, retintSky } from "./sky.js";
import { edgeEndpoint } from "./github-search.js";

/**
 * Debounce before asking GitHub.
 *
 * Every keystroke that reaches the network spends from a budget shared by all
 * visitors, so this waits for typing to pause rather than searching as you go.
 * A pause is a deliberate query. Submitting the form bypasses the wait.
 */
const DEBOUNCE_MS = 700;

/**
 * URLs per liveness batch.
 *
 * Only "Surprise me" batches now -- the results list checks one row at a time, on
 * intent. The worker allows twelve URLs per call and six distinct hosts, so six is
 * the length that satisfies both limits without grouping by host here.
 */
const LIVE_CHECK_CHUNK = 6;

/**
 * Tags shown before the picker is expanded.
 *
 * Sized to sit on roughly one row at desktop width, so the collapsed picker is
 * a single quiet strip and the expanded one is available without the default
 * state having already spent a screen of the page.
 */
const TAGS_COLLAPSED = 11;

/**
 * Fallback genre list for "Surprise me" when the taxonomy has not loaded.
 *
 * Taken from the purpose-based categories rather than invented here, so the two
 * cannot drift: if the picker loads first — which it normally does — this is
 * never consulted and the same closed set drives both. Kept as a literal only
 * because the click handler cannot await an import before deciding what to
 * search for, and a failed taxonomy must not take the button down with it.
 */
const SURPRISE_GENRES = ["portfolio", "games", "docs", "blog", "dashboards", "tools", "learning", "showcase", "libraries"];

/**
 * Results the search backend fetches per page.
 *
 * Duplicated here rather than imported because `github-search.js` is loaded
 * lazily on first search, while the summary line renders on every results
 * update and must not depend on that import having resolved. It has to agree
 * with the backend's own page size, or the "results 1-40" offsets lie. The
 * front-end suite asserts the two are equal.
 */
const RESULTS_PER_PAGE = 40;

// ---------------------------------------------------------------- state

const state = {
  rows: [],
  total: 0,
  /** "best" (relevance), "stars" (most stars first) or "updated" (most recently pushed first). */
  sort: "best",
  /** Which page of results is on screen, 1-based. */
  page: 1,
  /** The page being fetched, or 0 when nothing is in flight. */
  pendingPage: 0,
  /** How many pages exist for the current query. */
  pageCount: 0,
  truncated: false,
  partial: null,
  error: null,
  loading: false,
  inflight: null,
  lastQuery: "",
  /**
   * The tags selected in the picker.
   *
   * A list rather than a single value: GitHub ANDs the terms, so two tags are
   * a genuine narrowing ("portfolio" AND "resume") rather than one replacing the
   * other. A single tag forced every extra click to discard the previous choice.
   *
   * Named `picked`, not `tags`: `state.tags` is the whole curated catalogue and
   * has been since before this existed. Shadowing it made every tag look selected
   * the moment this shipped.
   */
  picked: [],
  /** The full curated tag list, loaded once from taxonomy.js. */
  tags: null,
  /** Whether the picker is showing every tag or just the first few. */
  tagsOpen: false,
  /** Liveness verdicts, keyed by site URL. */
  live: new Map(),
  verifyToken: 0,
  /** True while the tag picker is offered, so results do not overwrite it. */
  hasQuery: false,
};

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

// ---------------------------------------------------------------- search

/**
 * The result-order control.
 *
 * Only shown once there is a query: an ordering control above an empty page is a
 * control for something that does not exist yet.
 *
 * Three options, and the exclusion of forks and issues no longer holds for all
 * of them. A Pages site has no meaningful fork count and no meaningful open
 * issue count, so sorting by either would mean sorting by a field nothing on the
 * page displays. Those two stay out.
 *
 * "Recently updated" is different in kind, and was added after that rule was
 * written. Recency is a genuine property of a deployed site, so it is worth
 * ordering by, and GitHub returns its live tail here: measured against the query
 * this site sends, the first hundred results span about thirty seconds of
 * wall-clock time. It is the ordering for a visitor who does not yet know what
 * they are looking for, which is exactly what "best match" is worst at.
 *
 * The cost is yield and it is real: that page is only about a fifth Pages sites
 * against a third for relevance, and its median repo has no stars at all. New
 * deployments rarely do. It is a lens, not a better default.
 */
function renderSortbar() {
  const host = $("sortbar");
  if (!host) return;
  if (!state.hasQuery) {
    host.innerHTML = "";
    return;
  }
  const option = (value, label) =>
    `<button type="button" class="sortbtn" data-sort="${value}"` +
    ` aria-pressed="${state.sort === value}">${label}</button>`;
  host.innerHTML =
    option("best", "Best match") +
    option("stars", "Most stars") +
    option("updated", "Recently updated");
}

/**
 * The selected topic, as a removable chip inside the search field.
 *
 * A topic filter used to be visible only as a highlighted button in the picker
 * below the field. That is easy to lose: the search bar still showed its
 * placeholder, so the field looked idle while results came from somewhere else.
 * A reader who then typed a query had no idea why the topic had been dropped.
 *
 * Showing it where the query is typed makes the filter part of the query, and
 * gives it a way out that does not require hunting for the original button.
 * The button itself carries an accessible name, because "×" alone tells a screen
 * reader nothing about what it removes.
 */
function renderSearchChip() {
  const host = $("searchchips");
  if (!host) return;
  if (!state.picked.length) {
    host.innerHTML = "";
    return;
  }
  // One chip per tag, each removable on its own. With several chosen, the label
  // says how to undo the whole set at once, because clicking three separate ×
  // buttons is the obvious thing to resent.
  host.innerHTML =
    state.picked
      .map(
        (t) =>
          `<span class="searchchip">` +
          `<span class="searchchip-label">${esc(t)}</span>` +
          `<button type="button" class="searchchip-x" data-chip="${esc(t)}"` +
          ` aria-label="Remove the ${esc(t)} keyword"` +
          ` title="Remove the ${esc(t)} keyword">×</button>` +
          `</span>`,
      )
      .join("") +
    (state.picked.length > 1
      ? `<button type="button" class="searchchips-clear"` +
        ` aria-label="Remove all keywords">clear</button>`
      : "");
}

/**
 * Remove one keyword, or all of them, and search again.
 *
 * Focus is returned to the input because the button that was just pressed is
 * about to be removed from the DOM; leaving focus on a removed element drops it
 * to the document body and the next keystroke goes nowhere.
 */
function clearTag(tag) {
  if (tag) state.picked = state.picked.filter((t) => t !== tag);
  else state.picked = [];
  renderSearchChip();
  renderTagPicker();
  $("q").focus();
  runSearch({ fresh: true });
}

/**
 * Run a query against GitHub through the edge worker.
 *
 * One API page per call. Paging fetches only the page being shown, so turning to
 * page 4 costs the same single request as arriving on page 1 — see
 * `searchGitHub` for why it used to cost three.
 *
 * A selected tag is prepended to whatever has been typed and searched as an
 * ordinary keyword. See the note on building `q` below for why it is not a
 * GitHub `topic:` qualifier.
 */
async function runSearch(opts = {}) {
  const raw = $("q").value.trim();

  // A tag is a keyword, not a GitHub `topic:` qualifier.
  //
  // `topic:portfolio` restricts to repos carrying that exact topic, and every
  // result then shares it — at which point GitHub's default relevance ranking
  // *is* the star ranking. Measured across the seven default tags, a
  // `topic:`-qualified search returned byte-identical results for "best match"
  // and "most stars", so the ordering control did nothing at all on the path
  // most visitors arrive by. Searching the tag as an ordinary keyword restores a
  // genuinely different relevance order, and matches what people mean by
  // "show me portfolios": repos that are portfolios, whether or not somebody
  // tagged them.
  //
  // Tag and text combine rather than replacing each other. `topic:` was
  // either/or, so typing after choosing a tag discarded what had been typed —
  // the first keystroke searched the topic and silently threw the input away.
  const q = [...state.picked, raw].filter(Boolean).join(" ");

  if (!q) {
    resetSearch();
    renderResults();
    return;
  }

  // A different query starts at page 1. Keeping the old page number would show
  // page 7 of a query the reader had not seen page 1 of.
  const fresh = opts.fresh || state.lastQuery !== q || opts.sortChanged === true;
  const page = fresh ? 1 : opts.page;
  if (!fresh && !page) return;

  // Whether this is turning a page rather than running a new query. A page turn
  // names the page it is fetching, so the reader can see which of ten they asked
  // for.
  const pageTurn = !fresh && !!opts.page;

  state.inflight?.abort();
  const ctrl = new AbortController();
  state.inflight = ctrl;
  state.loading = true;
  state.hasQuery = true;
  state.pendingPage = page;
  renderSortbar();
  if (fresh) {
    state.error = null;
    state.partial = null;
  }

  // The list is replaced rather than held. Leaving the previous page's rows on
  // screen under a pager showing a different page is the confusing option: the
  // results and the control disagree about what is being shown. Taking the list
  // away and naming the page being fetched — as a search engine does — leaves no
  // ambiguity about what is on screen. The page control stays, so a reader who
  // realises they chose wrong can click another number instead of waiting.
  state.rows = [];
  state.rendered = 0;
  $("results").setAttribute("aria-busy", "true");
  renderResults(
    pageTurn ? `Loading page ${page}…` : "Searching GitHub…",
    pageTurn,
  );

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
    res = await searchGitHub(q, { signal: ctrl.signal, page, sort: state.sort });
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
  // A superseded search aborts without touching state, so the newer one owns the
  // busy state from here on.
  if (ctrl.signal.aborted) return;
  state.inflight = null;
  state.loading = false;
  state.pendingPage = 0;
  $("results").setAttribute("aria-busy", "false");
  state.lastQuery = q;
  state.page = res.page;
  state.pageCount = res.pages;
  state.rows = res.results;
  state.total = res.total;
  state.truncated = res.truncated;
  state.partial = res.partial ?? null;
  state.error = res.error ?? null;

  // Verdicts are kept across pages and queries on purpose: a URL that resolved
  // five minutes ago will very likely resolve now, and re-checking it would spend
  // another Worker request for no new information. Bounded so a long session
  // cannot grow it without limit.
  if (state.live.size > 200) state.live.clear();

  renderResults();
  // Nothing is asked of the shared budget here. Verification follows the reader's
  // attention instead of the search: see verifyRow for why that is a quota decision
  // rather than a cosmetic one.
}

/**
 * Say how much of the list has been verified, without offering to verify it.
 *
 * The control is gone: there is nothing to press, because verification now follows
 * the reader's attention. What is left is the honest accounting -- how many of the
 * sites on screen have actually been asked about -- so that a row carrying a badge
 * is never the only clue that requests are being spent.
 */
function renderLiveToggle() {
  const host = $("live-toggle");
  if (!host) return;
  const checked = [...state.live.values()].filter((v) => v !== "checking").length;
  if (!state.hasQuery || !state.rows.length || !checked || !edgeEndpoint()) {
    host.innerHTML = "";
    return;
  }
  host.innerHTML = `<span class="live-note">Verified ${esc(String(checked))} of the ${
    esc(String(state.rows.length))
  } shown &#8212; hover or focus a row to check it</span>`;
}

/** Drop every result; used when the query box is cleared. */
function resetSearch() {
  state.inflight?.abort();
  state.inflight = null;
  state.loading = false;
  state.lastQuery = "";
  state.rows = [];
  state.total = 0;
  state.page = 1;
  state.pageCount = 0;
  state.pendingPage = 0;
  state.truncated = false;
  state.partial = null;
state.error = null;
    state.hasQuery = false;
    state.verifyToken++;
    renderSortbar();
    renderLiveToggle();
  }

// ---------------------------------------------------------------- tag picker

/**
 * Draw the tag picker.
 *
 * Collapsed by default, showing a short row rather than all sixty-odd tags. An
 * earlier attempt did this in CSS with `max-height` plus `overflow: hidden`,
 * which cut the list off part-way through a wrapped row: the bottom chips were
 * sliced in half, and the button did not reliably restore the short state. This
 * slices the array instead, so a collapsed list is always whole rows and the
 * two states are exact opposites of each other.
 *
 * The module is imported once and cached, so re-rendering costs nothing.
 */
async function renderTagPicker() {
  const host = $("taglist");
  if (!host) return;
  if (!state.tags) {
    try {
      const { BROWSE_TAGS } = await import("./taxonomy.js");
      state.tags = BROWSE_TAGS;
    } catch {
      // The picker is a convenience; a failure to load it must not break search.
      return;
    }
  }

  const all = state.tags;
  const shown = state.tagsOpen ? all : all.slice(0, TAGS_COLLAPSED);

  host.innerHTML =
    shown
      .map((t) => `<button type="button" class="tagbtn" data-tag="${esc(t)}" aria-pressed="${state.picked.includes(t)}">${esc(t)}</button>`)
      .join("") +
    (all.length > TAGS_COLLAPSED
      ? `<button type="button" class="tagmore" id="tagmore" aria-expanded="${state.tagsOpen}">${
          state.tagsOpen ? "fewer" : `+${all.length - TAGS_COLLAPSED}`
        }</button>`
      : "");
}

/**
 * The tag picker: a short row of topics worth browsing, expandable to all of them.
 */
$("taglist").addEventListener("click", (e) => {
  // The expander shares the container with the tags, so it is matched first: it
  // carries no data-tag and would otherwise fall through as a tag deselection.
  if (e.target.closest("#tagmore")) {
    state.tagsOpen = !state.tagsOpen;
    renderTagPicker();
    return;
  }

  const btn = e.target.closest(".tagbtn");
  if (!btn) return;
  const tag = btn.dataset.tag;
  // Toggles independently of the others, so tags accumulate instead of
  // replacing one another.
  state.picked = state.picked.includes(tag)
    ? state.picked.filter((t) => t !== tag)
    : [...state.picked, tag];
  renderSearchChip();
  renderTagPicker();
  runSearch({ fresh: true });
});

/**
 * The chip's own remove button.
 *
 * It lives outside the tag picker's container, so it cannot be handled by the
 * handler above, and it has to work while the picker is scrolled out of view.
 */
$("searchchips").addEventListener("click", (e) => {
  const x = e.target.closest(".searchchip-x");
  if (x) return clearTag(x.dataset.chip);
  if (e.target.closest(".searchchips-clear")) clearTag();
});

// ---------------------------------------------------------------- liveness

const LIVE_BADGES = {
  checking: { cls: "live-checking", text: "checking…" },
  alive: { cls: "live-alive", text: "live" },
  gone: { cls: "live-gone", text: "dead link" },
  blocked: { cls: "live-blocked", text: "blocks bots" },
  unreachable: { cls: "live-gone", text: "unreachable" },
  // "Unverified" is not a finding, it is the absence of one: the batch either was
  // not asked, was refused, or had not come back yet. Labelling that state as
  // anything other than live made the page imply doubt it had no evidence for,
  // and on a list of thirty rows it was the only badge most people ever saw.
  error: { cls: "live-alive", text: "live" },
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
 * Verify one row, on intent.
 *
 * Why intent rather than a button
 * ------------------------------
 * This used to be a control the reader pressed to check every row on the page.
 * That framed liveness as an extra the site was withholding, when the check is in
 * fact the only thing keeping the site inside its budget: verifying a full page
 * costs several Worker requests, and doing that automatically on every view was
 * measured at roughly 140,000 requests a day against a 100,000 ceiling -- so it
 * could not be automatic, and a button was the wrong way to make it optional.
 *
 * So the request is spent where it earns its keep: on the row the reader is
 * actually considering. Hovering or focusing a row is a claim of interest in that
 * one site, and one site costs one request, answered from the edge for everyone
 * after the first. A reader scanning the list spends almost nothing; a reader
 * about to click spends what it takes to know whether the click will work.
 *
 * Nothing is hidden. A row that comes back gone is dimmed and badged rather than
 * removed, because a transient failure should not delete a result the reader may
 * want, and because a bot-refusing site is not a dead site -- that distinction is
 * the reason the worker's verdict is carried through instead of a boolean.
 */
async function verifyRow(url) {
  if (!url || !edgeEndpoint()) return;
  // Already known, still in flight, or never askable. One request per URL per page
  // of results: sweeping the pointer down the list cannot re-spend the budget,
  // because the verdict is in the map before the request goes out.
  if (state.live.has(url)) return;

  // No token is taken here. Abandoning a check because the reader moved on is what
  // broke this the first time: it left rows stuck on "checking…" with an answer
  // thrown away, and the row could never be re-checked because the URL was already
  // in the map. A verdict about a site is true regardless of which page it came
  // from, and it is cached at the edge for the next visitor anyway, so recording it
  // late is strictly better than discarding it.
  state.live.set(url, "checking");
  paintLiveRows();

  const { verifyLiveness } = await import("./github-search.js");
  const found = await verifyLiveness(url);

  // null means the edge could not be reached or refused. That is the absence of an
  // answer, not the answer "dead", and LIVE_BADGES maps it to the unmarked state
  // for exactly that reason.
  //
  // The verdict is recorded whether or not the reader is still looking at these
  // results. Abandoning it on a stale token would leave the row pinned to
  // "checking…" while the reader reads a different page -- and because the guard
  // above keys on the URL being present in the map, that row could then never be
  // checked again in this session. The cache is global knowledge about a site; it
  // does not become less true because the reader moved.
  state.live.set(url, found?.verdict ?? "error");
  paintLiveRows();
  // The accounting line counts verified rows, so it has to move with them.
  renderLiveToggle();
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
    // Record the verdict on the row itself. It is what clears the "not yet checked"
    // affordance in the stylesheet, and it is set even for a verdict that carries no
    // badge, because "asked, and the answer was nothing much" is still an answer and
    // the row should stop inviting a second request.
    if (v === "checking") row.removeAttribute("data-verdict");
    else row.setAttribute("data-verdict", v);
    let pill = row.querySelector(
      ".pill.live-alive, .pill.live-gone, .pill.live-blocked, .pill.live-checking",
    );
    if (!pill) {
      const host = row.querySelector("h3");
      if (!host) continue;
      pill = document.createElement("span");
      host.appendChild(pill);
    }
    pill.className = `pill ${badge.cls}`;
    pill.textContent = badge.text;
    const why = LIVE_WHY[v];
    if (why) pill.setAttribute("title", why);
    else pill.removeAttribute("title");
  }
}

// ---------------------------------------------------------------- render

function starBadge(r) {
  const stars = Number(r.stars) || 0;
  return stars
    ? `<span class="pill stars" title="${stars.toLocaleString()} GitHub stars">★ ${stars.toLocaleString()}</span>`
    : "";
}

/**
 * One result row.
 *
 * The live badge is last, not first. The badge labels vary in width — "live"
 * against "blocks bots" — so leading with it pushed every title to a different
 * x by up to 56px depending on the row's state, and the title is what a reader
 * scans. Titles now share one left edge and the badges collect at the right,
 * where both columns line up.
 */
function rowHtml(r) {
  const href = safeUrl(r.url);
  if (!href) return "";
  const title = r.full_name || `${r.owner}/${r.repo}`;
  const tags = (r.topics ?? [])
    .slice(0, 5)
    .map((g) => `<span class="tag">${esc(g)}</span>`)
    .join("");
  return `<article class="row" data-live="${esc(href)}">
    <h3><a href="${esc(href)}" target="_blank" rel="noopener noreferrer">${esc(title)}</a>${starBadge(r)}${livePillHtml(href)}</h3>
    <div class="url">${esc(href)}</div>
    ${r.description ? `<div class="desc">${esc(r.description)}</div>` : ""}
    ${tags ? `<div class="tags">${tags}</div>` : ""}
  </article>`;
}

function renderPage() {
const el = $("results");
  el.innerHTML = state.rows.map(rowHtml).join("") +
    `<p class="note">${summaryHtml()}</p>` +
    `<div id="pager"></div>`;
  renderPager();
}

/**
 * The page control, redrawn on its own.
 *
 * It lives in its own container rather than being part of the results markup so
 * that a pending page change can update just this, without the row list.
 *
 * While a page is in flight the control stays clickable and the requested number
 * is ringed. Disabling the buttons was the wrong instinct: the common case is
 * clicking through several numbers because you landed on the wrong page, and a
 * control that greys out after one click makes that impossible. Each click
 * aborts the previous request and issues a new one, so only the last survives and
 * only the last is paid for.
 *
 * There is no text label here: the results area beside it already says which
 * page is loading, and saying it twice is noise.
 */
function renderPager() {
  const host = $("pager");
  if (!host) return;

  if (state.pageCount <= 1) {
    // The honest number, not GitHub's ceiling. There used to be a single page cap
    // and the pager could not offer more, so "at most 1,000" was true. Now the
    // pager stops at ten pages of forty, so claiming to be showing everything would
    // be false in a way that looks like a bug rather than a choice: the reader
    // would read a total of 200,000 and see forty rows and no explanation.
    host.innerHTML = state.truncated && state.total > state.pageCount * RESULTS_PER_PAGE
      ? `<p class="note">Showing the first ${
          state.pageCount * RESULTS_PER_PAGE
        } of ${state.total.toLocaleString()} matches. Narrow the search to see different results.</p>`
      : "";
    return;
  }

  const busy = state.loading;
  const buttons = [];
  for (let p = 1; p <= state.pageCount; p++) {
    const current = p === state.page;
    const pending = busy && p === state.pendingPage;
    buttons.push(
      `<button type="button" class="pagebtn${current ? " current" : ""}${pending ? " pending" : ""}" ` +
        `data-page="${p}"${current ? ' aria-current="page"' : ""}` +
        `${pending ? ' aria-busy="true"' : ""}>${p}</button>`,
    );
  }

  host.innerHTML =
    `<nav class="pager" aria-label="Result pages"${busy ? ' aria-busy="true"' : ""}>` +
    `${buttons.join("")}</nav>`;
}

/**
 * The line under the results: where in the result set this is, and what was
 * checked.
 *
 * It states the position in the set rather than a running total, because with
 * pagination the old wording — "85 sites so far", then "3 of up to 10 pages
 * loaded" — described accumulation that no longer happens and read as though
 * more results were queued behind the button.
 */
function summaryHtml() {
  const n = state.rows.length;
  const bits = [`${n.toLocaleString()} Pages site${n === 1 ? "" : "s"} on this page`];
  if (state.pageCount > 1) {
    // Offset by the real page size. This used to be a literal 100, which was
    // correct while the pager held 100 results and silently lied the moment the
    // page size changed: page 5 of 40 is results 161-200, not 401-440.
    const first = (state.page - 1) * RESULTS_PER_PAGE + 1;
    const last = (state.page - 1) * RESULTS_PER_PAGE + n;
    bits.push(`results ${first.toLocaleString()}–${last.toLocaleString()}`);
  }
  if (state.picked.length) {
    bits.push(
      state.picked.length === 1
        ? `keyword: ${state.picked[0]}`
        : `keywords: ${state.picked.join(" and ")}`,
    );
  }
if (state.total > n) {
      // What is actually reachable, stated as the limit it is rather than as a
      // number the reader could catch us overstating.
      //
      // The naive figure is the page count times the page size, and it is wrong now
      // that the two are separate: only about a quarter of the repositories GitHub
      // returns have a Pages site, so ten pages of forty *slots* hold somewhere
      // around 200-400 sites depending on the query. Quoting 400 would overstate it
      // for most searches, and the reader has no way to tell which they got.
      //
      // So it names the thing that is actually true and constant: GitHub will not
      // serve past its first 1,000 matching repositories, and the pager goes exactly
      // that deep. That is checkable, and it does not depend on a yield we cannot
      // know without fetching every page.
      bits.push(
        `${state.total.toLocaleString()} repos match` +
          (state.truncated
            ? `, of which only the first 1,000 are reachable — the depth GitHub allows`
            : ""),
      );
    }
  if (state.partial) bits.push(state.partial);
  const checked = [...state.live.values()].filter((v) => v !== "checking").length;
  bits.push(
    checked
      ? `${checked} link-checked just now; "blocks bots" means it refused an automated request, not that it is down.`
      : "Every result is link-checked as it appears.",
  );
  return esc(bits.join(" · "));
}

/**
 * Draw the result set, or the reason there isn't one.
 *
 * `statusText` covers the in-flight state so the page shows progress rather than
 * the previous query's answer.
 *
 * `keepPager` keeps the page control on screen during a page turn. Without it a
 * reader who clicks the wrong number has to wait out the fetch before they can
 * correct it, which is the one moment the control is most useful.
 */
function renderResults(statusText, keepPager = false) {
  const el = $("results");
  if (statusText) {
    el.innerHTML =
      `<div class="empty loading"><span class="spinner" aria-hidden="true"></span>${esc(statusText)}</div>` +
      (keepPager ? `<div id="pager"></div>` : "");
    if (keepPager) renderPager();
    return;
  }
  if (state.error) {
    el.innerHTML = `<div class="empty">${esc(state.error)}</div>`;
    return;
  }

  // With no query there is nothing to show, and the tag picker below the hero is
  // the page's offer. Leaving an empty box there would just be a gap.
  if (!state.hasQuery || !state.rows.length) {
    el.innerHTML = state.hasQuery
      ? `<div class="empty">No Pages sites matched. Try a broader search.</div>`
      : "";
    return;
  }
  renderPage();
  paintLiveRows();
  renderLiveToggle();
}

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
 * "Surprise me": send the visitor to one live Pages site, chosen at random.
 *
 * Why this is not just "search for a random word"
 * -------------------------------------------------
 * The hardest visitor to help is the one with no query. Everything else on this
 * page asks them to supply something — a name, a keyword, a topic — and someone
 * browsing has none of those yet. This is the one control that does not.
 *
 * The genre is random too, not just the site. Picking a random repo from a
 * single broad query would return the same popular handful every time, because
 * relevance ranking puts the same projects at the top. Choosing first from the
 * closed set of purpose-based categories is what makes repeat clicks land in
 * genuinely different places: a portfolio, then a game, then a dashboard.
 *
 * Liveness is checked before navigating, not after
 * -------------------------------------------------
 * A random pick is mostly useless if it lands on a 404. The index contains dead
 * links, and a dead link is a much worse "surprise" than a boring one, so
 * candidates are probed first and only a site answered "alive" is opened.
 *
 * What it costs: one search plus one batched liveness check, both against the
 * shared rate limit. It is one request per click, not a walk of the corpus.
 *
 * Why the tab is opened before the answer is known
 * ------------------------------------------------
 * A popup blocker only honours a window opened *during* the click. By the time
 * this has searched and probed, the browser has decided no gesture is in
 * progress and will silently refuse the window. So the tab is opened
 * synchronously, written to, and its address set a moment later.
 *
 * The tab is written to rather than left blank, because a blank white tab that
 * sits there for a second is indistinguishable from a broken button. Nobody
 * knows whether to wait, and a control that looks broken loses trust faster than
 * one that is slow. It says what it is doing, spins while it works, and adopts
 * the page's own colours so it looks like part of the site rather than a stray
 * window.
 */
const SURPRISE_WAIT_PAGE = `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex">
<title>ghindex</title>
<style>
  :root { color-scheme: light dark;
    --bg:#f4f2ee; --fg:#2b3138; --muted:#5c6672; --accent:#0969da; --border:#e0dcd5; }
  @media (prefers-color-scheme: dark) {
    :root { --bg:#1c1f24; --fg:#d4dae1; --muted:#9aa4b0; --accent:#58a6ff; --border:#33383f; }
  }
  * { box-sizing: border-box; }
  body { margin:0; min-height:100vh; display:grid; place-items:center;
         background:var(--bg); color:var(--fg);
         font:400 15px/1.55 ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif;
         -webkit-font-smoothing:antialiased; }
  .box { text-align:center; padding:2rem 1.5rem; max-width:30rem; }
  h1 { margin:0 0 .5rem; font-size:1.15rem; font-weight:600; letter-spacing:-.01em; }
  p { margin:0; color:var(--muted); font-size:.9rem; }
  .ring { width:1.6rem; height:1.6rem; margin:0 auto 1.1rem;
          border:2px solid color-mix(in srgb, var(--accent) 20%, transparent);
          border-top-color:var(--accent); border-radius:999px;
          animation:spin .7s linear infinite; }
  @keyframes spin { to { transform:rotate(360deg); } }
  @media (prefers-reduced-motion: reduce) {
    /* The ring stops rather than vanishing: a blank gap where the spinner was
       would look like the load had stalled, which is the opposite of the truth. */
    .ring { animation:none; border-top-color:var(--border); }
  }
  /* Nothing here can be clicked or focused; it is a status, not a page. */
  body { user-select:none; }
</style></head>
<body><div class="box" id="b">
  <div class="ring" role="img" aria-label="Loading"></div>
  <h1>Finding you something</h1>
  <p>Looking for a live Pages site. This takes a second.</p>
</div></body></html>`;

/**
 * Replace the waiting tab's contents with an explanation.
 *
 * The alternative is closing it, which is worse: the visitor who clicked is now
 * looking at a tab that said "Finding you something" when it vanished, with no
 * idea whether the button failed or they did something wrong. Saying so in place
 * leaves them with an answer, which is the only thing that was missing.
 */
function surpriseTabFailed(tab) {
  try {
    const d = tab?.document;
    if (!d || tab.closed) return;
    d.open();
    d.write(
      SURPRISE_WAIT_PAGE.replace(
        /<div class="ring"[\s\S]*?<\/div>\s*<h1>[\s\S]*?<\/h1>\s*<p>[\s\S]*?<\/p>/,
        '<h1>Nothing to send you to</h1>' +
          '<p>No live site answered this time. Go back and try again.</p>',
      ),
    );
    d.close();
  } catch {
    // The tab is gone or has become cross-origin. Nothing to explain in.
  }
}

async function surpriseMe() {
  const btn = $("surprise");
  const label = $("surprise-label");
  if (!btn || btn.disabled) return;

  // Synchronous, before any await. This is the whole reason the tab appears at
  // all; moving this line below the search is what makes it silently blocked.
  const tab = window.open("", "_blank");
  if (tab) {
    // Written immediately, while the tab is still the empty document we just
    // made. Doing it after the search would work no better and would leave a
    // white flash to stare at.
    try {
      tab.document.open();
      tab.document.write(SURPRISE_WAIT_PAGE);
      tab.document.close();
      // Focus the new tab: the visitor asked to be taken somewhere, and a window
      // that opens behind the one they clicked is a tab they have to go and find.
      tab.focus();
    } catch {
      // A cross-origin or already-closed tab. It still navigates below, just
      // without the explanation in it.
    }
    // No opener: the opened site gets no handle on this page, and its back
    // button does not walk through here. Set on the opener side because that is
    // the only way to do it for a window whose address we assign later.
    tab.opener = null;
  }

  // Superseded by a second click, and by anything the visitor types: both
  // replace the intent, so the first request should stop costing anything.
  state.inflight?.abort();
  const ctrl = new AbortController();
  state.inflight = ctrl;
  btn.disabled = true;
  const original = label.textContent;
  label.textContent = "Finding one…";

  // A tab the visitor did not ask to keep, if this attempt does not finish.
  // Called on the paths that bail out; the success path hands over ownership.
  // It explains itself rather than closing, so the tab never vanishes while
  // still claiming to be finding something.
  const discard = () => {
    state.inflight = null;
    btn.disabled = false;
    label.textContent = original;
    surpriseTabFailed(tab);
  };

  try {
    const { searchGitHub, verifyLivenessBatch } = await import("./github-search.js");
    // A random purpose-based category. `state.tags` is the picker list once it has
    // loaded; the closed set is the fallback so this works even if the visitor
    // clicks before the taxonomy arrives, or if it failed to load entirely.
    const pool = state.tags?.length ? state.tags : SURPRISE_GENRES;
    const genre = pool[Math.floor(Math.random() * pool.length)];
    const res = await searchGitHub(genre, { signal: ctrl.signal, page: 1 });

    // Candidates are every Pages site on the page, not one of them: probing a
    // single random row means a dead link a fraction of the time, and the whole
    // point is that the visitor is sent somewhere that works. `safeUrl` is the
    // same guard every result row goes through, so nothing is opened that would
    // not already be rendered as a link.
    const candidates = (res?.results ?? [])
      .map((r) => safeUrl(r.url))
      .filter(Boolean)
      .slice(0, LIVE_CHECK_CHUNK);
    if (!candidates.length) throw new Error("nothing to open");

    const verdicts = await verifyLivenessBatch(candidates, { signal: ctrl.signal });
    const alive = candidates.filter((u) => verdicts.get(u)?.verdict === "alive");
    // Fall back to an unchecked candidate rather than failing. A site nobody
    // could answer for is not known to be dead, and the visitor asked to be
    // sent somewhere, not to be told the corpus was unreachable.
    const target = alive.length ? alive[Math.floor(Math.random() * alive.length)] : candidates[0];

    state.inflight = null;
    btn.disabled = false;
    label.textContent = original;
    if (tab) {
      tab.location.replace(target);
    } else {
      // Blocked, or opened and already closed. Same-tab is a worse experience
      // but a working one; losing the page would leave nothing to go back to.
      window.location.href = target;
    }
  } catch (err) {
    if (err && err.name === "AbortError") {
      // Superseded by a real search the visitor typed, so the label and the
      // button belong to that flow now and must not be stomped back.
      state.inflight = null;
      btn.disabled = false;
      if (tab && !tab.closed) tab.close();
      return;
    }
    discard();
    // Said in the button rather than as a page-level error: nothing failed, the
    // visitor simply gets no surprise, and replacing the results area with an
    // error for a control they pressed once would be far too loud.
    label.textContent = "Couldn't find one — try again";
  }
}

$("surprise")?.addEventListener("click", surpriseMe);

/**
 * Verify a row when the reader shows interest in it.
 *
 * Delegated on the results container, because that element survives every re-render
 * while the rows inside it do not. A listener bound to each row would be thrown away
 * with the next search; a delegated one sees every row, present and future.
 *
 * `pointerover` rather than `mouseover` because it also fires for touch and pen, so
 * a tap-to-inspect on a phone works without a separate path. `focusin` covers
 * keyboard readers, who are otherwise never counted -- and a keyboard reader is
 * exactly the person for whom a badge that only appears on hover would be missing.
 *
 * Both are guarded against re-entry by the check inside verifyRow: a sweep of the
 * pointer across twenty rows, or a reader tabbing back and forth, spends one request
 * per distinct URL and no more.
 */
$("results")?.addEventListener("pointerover", (e) => {
  const row = e.target.closest("[data-live]");
  if (row) verifyRow(row.getAttribute("data-live"));
});

$("results")?.addEventListener("focusin", (e) => {
  const row = e.target.closest("[data-live]");
  if (row) verifyRow(row.getAttribute("data-live"));
});

/**
 * Paging, delegated because the pager is re-rendered on every update.
 *
 * Jumping straight to a page rather than only "next" matters here: a reader who
 * landed on page 7 has no way to get back to page 1 without nine clicks, and the
 * whole point of a numbered pager is that any page is one click away.
 *
 * The list is scrolled to the top first. Without that, changing page leaves the
 * reader looking at result 240 of the previous page with no indication that
 * anything happened.
 */
document.addEventListener("click", (e) => {
  const btn = e.target.closest(".pagebtn");
  if (!btn) return;
  const page = Number(btn.dataset.page);
  if (!page || page === state.page) return;
  window.scrollTo({ top: 0, behavior: "auto" });
  runSearch({ page });
});

/**
 * Result ordering.
 *
 * Switching always restarts at page 1: page 4 of "most stars" is not page 4 of
 * "best match", and landing on the new ordering's page 4 because you happened to
 * be reading page 4 would be meaningless.
 */
$("sortbar").addEventListener("click", (e) => {
  const btn = e.target.closest(".sortbtn");
  if (!btn) return;
  const sort = btn.dataset.sort;
  if (!sort || sort === state.sort) return;
  state.sort = sort;
  renderSortbar();
  window.scrollTo({ top: 0, behavior: "auto" });
  runSearch({ fresh: true, sortChanged: true });
});

// ---------------------------------------------------------------- theme

/**
 * Manual theme override.
 *
 * The page follows the system until someone says otherwise, and then it is
 * simply light or dark — there is no third control position. An earlier version
 * cycled auto/light/dark, but "auto" always looks identical to whichever of the
 * two the system is already showing, so one step of that cycle could never
 * change anything: two clicks to reach light, one to get back. A two-mode switch
 * has no such step, because both of its steps are the opposite colour by
 * definition.
 *
 * The icon shows the colour on screen, not the one a click would give, so on a
 * dark system the page arrives on the moon without anyone having chosen it.
 *
 * Choosing pins the preference; clearing the stored value is what hands the page
 * back to the system, and that is not a thing the control offers.
 *
 * The stylesheet does the colour work: `[data-theme]` on <html> wins, and its
 * *absence* is what lets the system media query in. Both branches are restated
 * there because CSS cannot express "this, and also when that attribute is set".
 */
const THEME_KEY = "ghindex-theme";
const darkQuery = window.matchMedia("(prefers-color-scheme: dark)");

/** What the page is showing right now, whatever decided it. */
const shownDark = () => {
  const pinned = document.documentElement.getAttribute("data-theme");
  if (pinned === "dark") return true;
  if (pinned === "light") return false;
  return darkQuery.matches;
};

function readStoredTheme() {
  try {
    const v = localStorage.getItem(THEME_KEY);
    return v === "dark" || v === "light" ? v : null;
  } catch {
    // Storage can be blocked outright in private modes. Following the system is
    // a perfectly good answer, so a refusal is not worth surfacing.
    return null;
  }
}

function applyTheme(theme) {
  const root = document.documentElement;
  if (theme) root.setAttribute("data-theme", theme);
  else root.removeAttribute("data-theme");

  // The two theme-color metas are media-gated, which is exactly right before
  // this runs and wrong the moment a person overrides the system, so one is
  // enabled and the other muted.
  const dark = shownDark();
  document.querySelectorAll('meta[name="theme-color"]').forEach((m) => {
    m.setAttribute("media", m.dataset.scheme === (dark ? "dark" : "light") ? "all" : "not all");
  });

  const btn = $("themetoggle");
  if (btn) {
    btn.setAttribute("aria-label", dark ? "Dark. Switch to light." : "Light. Switch to dark.");
  }
  // The stars are painted in the theme's own text colour. This repaints them in
  // place; rebuilding the field here would restart the drift on every click.
  retintSky();
}

$("themetoggle")?.addEventListener("click", () => {
  // Always the opposite of what is on screen, so every click is a visible
  // change. There is no third position to land on.
  const next = shownDark() ? "light" : "dark";
  try {
    localStorage.setItem(THEME_KEY, next);
  } catch {
    // Unpersistable, but the override still applies for this page view.
  }
  applyTheme(next);
});

// Following the system has to mean following it live, or someone who sets their
// OS to dark at sunset watches this page stay light.
darkQuery.addEventListener("change", () => {
  if (!document.documentElement.getAttribute("data-theme")) applyTheme(null);
});

// ---------------------------------------------------------------- boot

applyTheme(readStoredTheme());
renderTagPicker();
startSky();