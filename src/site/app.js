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

/** Rows rendered per page; the sentinel appends more as the reader scrolls. */
const PAGE = 40;

/** Pages of 100 repos fetched per request. One is ~35 Pages sites. */
const PAGE_STEP = 1;

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
  /** The tag currently selected in the picker, or "". */
  tag: "",
  /** Liveness verdicts, keyed by site URL. */
  live: new Map(),
  verifyToken: 0,
  rendered: 0,
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
 * Pages accumulate: `searchGitHub` walks page 1..N and returns the union, so
 * "show more" extends the set rather than replacing it.
 *
 * A selected tag becomes `topic:<tag>` rather than free text. GitHub's topic
 * qualifier is exact, so this searches for repos that carry that tag rather
 * than for repos that merely mention the word — which is what someone clicking
 * "portfolio" in a topic picker is asking for.
 */
async function runSearch(opts = {}) {
  const raw = $("q").value.trim();
  const q = state.tag ? `topic:${state.tag}` : raw;
  const fresh = opts.fresh || state.lastQuery !== q;

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

  if (!fresh && !opts.more && state.rows.length) return;
  const pages = fresh ? PAGE_STEP : state.pages + PAGE_STEP;

  state.inflight?.abort();
  const ctrl = new AbortController();
  state.inflight = ctrl;
  state.loading = true;
  state.hasQuery = true;
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
    res = await searchGitHub(q, { signal: ctrl.signal, pages });
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
  state.pages = 0;
  state.truncated = false;
  state.hasMore = false;
  state.partial = null;
  state.error = null;
  state.hasQuery = false;
  state.rendered = 0;
}

// ---------------------------------------------------------------- tag picker

/**
 * The tag picker: a short list of topics worth browsing, drawn once at boot.
 *
 * It is not derived from results. The previous version computed category chips
 * from whatever GitHub had just returned, which meant the control that was
 * supposed to help you *find* things could only describe what you had already
 * found, and its counts changed with every keystroke. A fixed list is a
 * starting point you can act on before you have any results at all.
 */
async function renderTagPicker() {
  const host = $("taglist");
  if (!host) return;

  // The module is imported once and the buttons written once. Later calls only
  // restate which tag is selected, because rebuilding the list on every click
  // would drop the button the visitor is interacting with out from under the
  // pointer mid-click.
  if (!host.childElementCount) {
    let tags = [];
    try {
      ({ BROWSE_TAGS: tags } = await import("./taxonomy.js"));
    } catch {
      // The picker is a convenience; a failure to load it must not break search.
      return;
    }
    host.innerHTML =
      tags
        .map((t) => `<button type="button" class="tagbtn" data-tag="${esc(t)}" aria-pressed="false">${esc(t)}</button>`)
        .join("") +
      `<button type="button" class="tagmore" id="tagmore" data-total="${tags.length}"
         aria-expanded="false" aria-controls="taglist">all ${tags.length}</button>`;
    // Collapsed by default. Eighty chips in full view pushed the results far
    // enough down the page that a visitor who searched had to scroll past the
    // whole picker to reach the answer.
    host.classList.add("collapsed");
  }

  for (const btn of host.querySelectorAll(".tagbtn")) {
    btn.setAttribute("aria-pressed", String(btn.dataset.tag === state.tag));
  }
}

/**
 * Selecting a tag searches for that topic. Selecting the selected tag clears it,
 * so the control is a toggle rather than a one-way door.
 */
$("taglist").addEventListener("click", (e) => {
  // The expander shares the container, so it is handled first: it has no
  // data-tag and would otherwise fall through and clear the selection.
  if (e.target.closest("#tagmore")) {
    const host = $("taglist");
    const open = host.classList.toggle("collapsed") === false;
    $("tagmore").setAttribute("aria-expanded", String(open));
    $("tagmore").textContent = open ? "fewer" : `all ${$("tagmore").dataset.total ?? ""}`.trim();
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
  const slice = state.rows.slice(state.rendered, state.rendered + PAGE);
  const rows = slice.map(rowHtml).join("");
  if (state.rendered === 0) {
    // The summary and the "show more" control are rebuilt with the first page,
    // then left alone as the sentinel appends more rows: they describe the
    // result set, not the slice currently on screen.
    el.innerHTML = rows + `<p class="note">${summaryHtml()}</p>` + moreHtml();
  } else {
    el.insertAdjacentHTML("beforeend", rows);
  }
  state.rendered += slice.length;
  $("sentinel").hidden = state.rendered >= state.rows.length;
}

/** The line under the results: how many, from where, and what was checked. */
function summaryHtml() {
  const n = state.rows.length;
  const bits = [`${n.toLocaleString()} Pages site${n === 1 ? "" : "s"}, live from GitHub`];
  if (state.tag) bits.push(`topic: ${state.tag}`);
  if (state.total > n) {
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
    return `<button type="button" id="more" class="tagbtn" ${state.loading ? "disabled" : ""}>` +
      (state.loading ? "Loading…" : `Show more (${state.rows.length.toLocaleString()} so far)`) +
      `</button>`;
  }
  if (state.total > state.rows.length) {
    return `<p class="note">Reached GitHub's per-query limit. Try a narrower search.</p>`;
  }
  return "";
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
    $("sentinel").hidden = true;
    return;
  }
  if (state.error) {
    el.innerHTML = `<div class="empty">${esc(state.error)}</div>`;
    $("sentinel").hidden = true;
    return;
  }

  state.rendered = 0;

  // With no query there is nothing to show, and the tag picker below the hero is
  // the page's offer. Leaving an empty box there would just be a gap.
  if (!state.hasQuery || !state.rows.length) {
    el.innerHTML = state.hasQuery
      ? `<div class="empty">No Pages sites matched. Try a broader search.</div>`
      : "";
    $("sentinel").hidden = true;
    return;
  }
  renderPage();
  paintLiveRows();
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

/** "Show more" is delegated, because the button is re-rendered on every update. */
document.addEventListener("click", (e) => {
  if (e.target instanceof HTMLElement && e.target.id === "more") {
    runSearch({ more: true });
  }
});

// ---------------------------------------------------------------- boot

renderTagPicker();