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
  /** The tag currently selected in the picker, or "". */
  tag: "",
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
 * Run a query against GitHub through the edge worker.
 *
 * One API page per call. Paging fetches only the page being shown, so turning to
 * page 4 costs the same single request as arriving on page 1 — see
 * `searchGitHub` for why it used to cost three.
 *
 * A selected tag becomes `topic:<tag>` rather than free text. GitHub's topic
 * qualifier is exact, so this searches for repos that carry that tag rather
 * than for repos that merely mention the word — which is what someone clicking
 * "portfolio" in a topic picker is asking for.
 */
async function runSearch(opts = {}) {
  const raw = $("q").value.trim();
  const q = state.tag ? `topic:${state.tag}` : raw;

  if (!q) {
    resetSearch();
    renderResults();
    return;
  }

  // Typing clears a selected tag: the visitor has moved on to a text query, and
  // silently keeping the tag would ignore what they just typed.
  if (raw && state.tag) {
    state.tag = "";
    renderTagPicker();
  }
  if (!raw && !state.tag) {
    resetSearch();
    renderResults();
    return;
  }

  // A different query starts at page 1. Keeping the old page number would show
  // page 7 of a query the reader had not seen page 1 of.
  const fresh = opts.fresh || state.lastQuery !== q;
  const page = fresh ? 1 : opts.page;
  if (!fresh && !page) return;

  // Whether the list on screen can stay while this loads. A new query has no
  // results to keep; a page change does, and replacing them with a loading
  // message throws away what the reader was reading.
  const keepResults = !fresh && state.rows.length > 0;

  state.inflight?.abort();
  const ctrl = new AbortController();
  state.inflight = ctrl;
  state.loading = true;
  state.hasQuery = true;
  state.pendingPage = page;
  if (fresh) {
    state.error = null;
    state.partial = null;
  }

  if (keepResults) {
    // Only the pager changes: same rows, same scroll position, with the control
    // showing the fetch in progress.
    renderPager();
    $("results").setAttribute("aria-busy", "true");
  } else {
    renderResults(fresh ? "Searching GitHub…" : null);
  }

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
    res = await searchGitHub(q, { signal: ctrl.signal, page });
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
      .map((t) => `<button type="button" class="tagbtn" data-tag="${esc(t)}" aria-pressed="${state.tag === t}">${esc(t)}</button>`)
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
  state.tag = state.tag === tag ? "" : tag;
  renderTagPicker();
  runSearch({ fresh: true });
});

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

function rowHtml(r) {
  const href = safeUrl(r.url);
  if (!href) return "";
  const title = r.full_name || `${r.owner}/${r.repo}`;
  const tags = (r.topics ?? [])
    .slice(0, 5)
    .map((g) => `<span class="tag">${esc(g)}</span>`)
    .join("");
  return `<article class="row" data-live="${esc(href)}">
    <h3>${livePillHtml(href)}<a href="${esc(href)}" target="_blank" rel="noopener noreferrer">${esc(title)}</a>${starBadge(r)}</h3>
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
 * that a pending page change can update just this. Rewriting the whole results
 * container to show a loading state would throw away the list the reader is
 * currently looking at and put them back at the top of an empty page.
 *
 * While a page is in flight the control stays put and shows what it is doing.
 * That is the buffer: the results already on screen remain readable, the buttons
 * grey out so they cannot be double-charged, and the label names the page being
 * fetched. Clicking several numbers in a row aborts the earlier fetches and
 * leaves the last one standing.
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

  // The buttons stay clickable while a page loads. Disabling them was the wrong
  // instinct: the common case is clicking through several numbers because you
  // landed on the wrong page, and a control that greys out after one click makes
  // that impossible. Each click aborts the previous request and issues a new one,
  // so only the last survives and only the last is paid for.
  const status = busy && state.pendingPage && state.pendingPage !== state.page
    ? `<span class="pagestatus">Loading page ${state.pendingPage}…</span>`
    : busy
      ? `<span class="pagestatus">Loading…</span>`
      : "";

  host.innerHTML =
    `<nav class="pager" aria-label="Result pages"${busy ? ' aria-busy="true"' : ""}>` +
    `${status}${buttons.join("")}</nav>`;
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
  if (state.tag) bits.push(`topic: ${state.tag}`);
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
 */
function renderResults(statusText) {
  const el = $("results");
  if (statusText) {
    el.innerHTML = `<div class="empty">${esc(statusText)}</div>`;
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

// ---------------------------------------------------------------- boot

renderTagPicker();