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

/**
 * Tags shown before the picker is expanded.
 *
 * Sized to sit on roughly one row at desktop width, so the collapsed picker is
 * a single quiet strip and the expanded one is available without the default
 * state having already spent a screen of the page.
 */
const TAGS_COLLAPSED = 11;

// ---------------------------------------------------------------- state

const state = {
  rows: [],
  total: 0,
  /** "best" (GitHub relevance) or "stars" (most stars first). */
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
 * Deliberately two options. GitHub offers "most forks", "most recently updated"
 * and "most issues" as well, and this site cannot honour those the same way — a
 * Pages site has no meaningful fork count or issue count — so offering them would
 * be offering buttons that sort by a field nothing on the page displays.
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
    option("best", "Best match") + option("stars", "Most stars");
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
  state.rows = [];
  state.total = 0;
  state.page = 1;
  state.pageCount = 0;
  state.pendingPage = 0;
  state.truncated = false;
  state.partial = null;
  state.error = null;
  state.hasQuery = false;
  renderSortbar();
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
   * it entirely rather than stamping a status on every row, which would be
   * noise: nothing was asked, so nothing can honestly be claimed.
   */
  if (!edgeEndpoint()) return;

  const token = ++state.verifyToken;

  const pending = state.rows
    .map((r) => r.url)
    .filter((u) => u && !state.live.has(u))
    .slice(0, LIVE_CHECK_LIMIT);
  if (!pending.length) return;

  // Marking first means a row renders as "checking…" immediately instead of
  // looking unchecked while the request is in flight.
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
    host.innerHTML = state.truncated && state.total > 1000
      ? `<p class="note">GitHub returns at most 1,000 results per query, so this is all of them. Narrow the search to see different results.</p>`
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
    const first = (state.page - 1) * 100 + 1;
    const last = (state.page - 1) * 100 + n;
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
    bits.push(
      `${state.total.toLocaleString()} repos match` +
        (state.truncated ? ", of which only the first 1,000 are reachable" : ""),
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
 * The page follows the system until someone says otherwise. The control is a
 * two-state switch rather than a three-state cycle, and the reason is arithmetic
 * rather than taste: "auto" always looks identical to whichever of light or dark
 * the system is already showing, so a cycle through all three can only ever have
 * one step that changes nothing. Whichever way round you order it, the reader
 * gets a click that does not appear to do anything. Two states, and every click
 * turns the page the other colour.
 *
 * Handing control back to the system is still possible, and is folded into the
 * same click: when the pinned theme already matches what the system would show,
 * the next click drops the pin. That step looks like a no-op in colour, but the
 * control changes to the monitor icon and says so in its label, so it is a
 * visible, named state rather than a dead click.
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
    btn.setAttribute(
      "aria-label",
      theme
        ? `Theme: ${theme}. Switch to ${dark ? "light" : "dark"}.`
        : `Following your system: ${dark ? "dark" : "light"}. Switch to ${dark ? "light" : "dark"}, or keep following.`,
    );
  }
  // The stars are painted in the theme's own text colour. This repaints them in
  // place; rebuilding the field here would restart the drift on every click.
  retintSky();
}

$("themetoggle")?.addEventListener("click", () => {
  const pinned = document.documentElement.getAttribute("data-theme");
  // Already showing what the reader is asking for, so hand the page back to the
  // system instead of toggling to a colour that is already on screen.
  const next = pinned && shownDark() === (pinned === "dark") ? null : shownDark() ? "light" : "dark";
  try {
    if (next) localStorage.setItem(THEME_KEY, next);
    else localStorage.removeItem(THEME_KEY);
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