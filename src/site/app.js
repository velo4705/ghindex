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
    $("count").textContent = `${m.total.toLocaleString()} live sites indexed`;
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
    <div class="meta">
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
  if (state.rendered === 0) el.innerHTML = `<p class="meta">No matches.</p>`;
}

/**
 * Cross-origin iframes give no reliable load/error event, so we cannot detect
 * a blocked frame. Instead, check the iframe's own document: a frame that
 * loaded cross-origin is inaccessible, but a blocked frame stays at about:blank
 * and is same-origin-readable. This is a heuristic, not a guarantee.
 */
function attachFrameFallbacks() {
  for (const frame of document.querySelectorAll(".card .frame iframe")) {
    const fb = frame.parentElement.querySelector(".fallback");
    const timer = setTimeout(() => {
      try {
        const loc = frame.contentWindow?.location;
        // about:blank means nothing navigated -> likely blocked or empty.
        if (!loc || loc.href === "about:blank") {
          frame.style.visibility = "hidden";
          fb.style.display = "flex";
        }
      } catch {
        // Cross-origin and loaded fine: leave the preview visible.
      }
    }, 3500);
    frame.addEventListener("load", () => clearTimeout(timer), { once: true });
  }
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
  btn.textContent = state.view === "grid" ? "Row view" : "Grid view";
  state.rendered = 0;
  renderPage();
});

$("stars").addEventListener("change", (e) => {
  state.minStars = Number(e.target.value);
  runSearch();
});

// ---------------------------------------------------------------- boot

try {
  const res = await fetch(`${DATA}manifest.json`);
  if (!res.ok) throw new Error(`manifest ${res.status}`);
  state.manifest = await res.json();
  for (const c of state.manifest.categories ?? []) state.catLabels[c.id] = c.label;
  worker.postMessage({ type: "init", manifest: state.manifest });
  runSearch();
} catch (err) {
  $("meta").textContent = `Could not load index: ${err.message}. Run 'bun run src/publish/build.ts'.`;
}
