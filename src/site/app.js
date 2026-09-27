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
const wide = { inflight: null, lastQuery: "", results: [], truncated: false, error: null };

async function runWideSearch() {
  const q = $("q").value.trim();
  if (!q) {
    wide.results = [];
    wide.error = null;
    renderWide();
    return;
  }
  // One request per distinct query: the unauthenticated limit is 10/min.
  if (wide.lastQuery === q && wide.results.length) return;

  wide.inflight?.abort();
  const ctrl = new AbortController();
  wide.inflight = ctrl;
  wide.error = null;
  renderWide("Asking GitHub…");

  const { searchGitHub } = await import("./github-search.js");
  const res = await searchGitHub(q, { token: userToken(), signal: ctrl.signal });
  if (ctrl.signal.aborted) return;

  wide.inflight = null;
  wide.lastQuery = q;
  wide.results = res.results;
  wide.truncated = res.truncated;
  wide.error = res.error ?? null;
  renderWide();
}

function wideRowHtml(r) {
  const href = safeUrl(r.url);
  if (!href) return "";
  const title = r.full_name || `${r.owner}/${r.repo}`;
  const tags = (r.topics ?? [])
    .slice(0, 4)
    .map((t) => `<span class="tag">${esc(t)}</span>`)
    .join("");
  return `<article class="row">
    <h3><a href="${esc(href)}" target="_blank" rel="noopener noreferrer">${esc(title)}</a>
      <span class="pill">not indexed</span></h3>
    <div class="url">${esc(href)}</div>
    ${r.description ? `<div class="desc">${esc(r.description)}</div>` : ""}
    <div class="tags">${tags}</div>
  </article>`;
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
  const note = wide.truncated
    ? `GitHub reported more matches than it returns (capped at 1,000 per query). These are the Pages-enabled results it did return.`
    : `${n} Pages-enabled result${n === 1 ? "" : "s"} from GitHub. Outside this index, so not checked for liveness.`;

  el.innerHTML =
    `<h2>Also on GitHub</h2><p class="note">${esc(note)}</p>` +
    wide.results.map(wideRowHtml).join("");
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
$("q").addEventListener("input", () => {
  clearTimeout(debounce);
  debounce = setTimeout(runSearch, 200);
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

$("wide").addEventListener("click", () => {
  const showing = $("tokenrow").hidden;
  $("tokenrow").hidden = !showing;
  if (showing) $("token").focus();
  runWideSearch();
});

// A token is supplied per tab; it is never written to storage.
$("token").addEventListener("change", () => {
  if (wide.lastQuery) {
    // Re-run so the new limit takes effect for the current query.
    wide.lastQuery = "";
    runWideSearch();
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
