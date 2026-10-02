/**
 * Search worker (plain JS on purpose — no build step in the publish pipeline).
 *
 * Scoring runs here so typing never blocks the main thread. The worker owns the
 * shard cache: the main thread never touches record data directly, it just
 * receives ranked rows back.
 *
 * Protocol
 *   in : {type:'init', manifest}
 *        {type:'query', id, q, filters}
 *   out: {type:'ready', total}
 *        {type:'landing', landing}
 *        {type:'results', id, q, rows, total, tags, elapsedMs}
 */

let manifest = null;
const cache = new Map();

function loadShard(id) {
  let p = cache.get(id);
  if (!p) {
    p = fetch("./data/" + id + ".json")
      .then((r) => (r.ok ? r.json() : []))
      .catch(() => []);
    cache.set(id, p);
  }
  return p;
}

/**
 * Score one record. Higher is better; -1 means no match.
 * Exact owner > owner prefix > repo exact > owner substring > repo prefix >
 * title > repo substring > title substring > tag > description > subsequence.
 * The subsequence fallback is what gives recall when a user half-remembers.
 */
function score(row, qy) {
  const owner = (row.o || "").toLowerCase();
  const repo = (row.r || "").toLowerCase();
  const title = (row.t || "").toLowerCase();

  if (owner === qy) return 1000;
  if (owner.indexOf(qy) === 0) return 900 - owner.length;
  if (repo === qy) return 850;
  if (owner.indexOf(qy) !== -1) return 700;
  if (repo.indexOf(qy) === 0) return 650 - repo.length;
  if (title.indexOf(qy) === 0) return 600;
  if (repo.indexOf(qy) !== -1) return 500;
  if (title.indexOf(qy) !== -1) return 450;
  const tags = row.g || [];
  for (let i = 0; i < tags.length; i++) {
    if (tags[i].toLowerCase().indexOf(qy) !== -1) return 300;
  }
  if ((row.d || "").toLowerCase().indexOf(qy) !== -1) return 200;

  const hay = owner + " " + repo;
  let j = 0;
  for (let i = 0; i < hay.length && j < qy.length; i++) {
    if (hay[i] === qy[j]) j++;
  }
  return j === qy.length ? 100 : -1;
}

/** Owner-initial shards, plus wildcard buckets for other owners. */
function candidateShards(q) {
  if (!manifest) return [];
  const ids = manifest.shards.map((s) => s.id);
  const first = (q || "").trim().toLowerCase().charAt(0);
  if (!first) return ids;
  const out = new Set(["_", "#"].filter((x) => ids.indexOf(x) !== -1));
  if (ids.indexOf(first) !== -1) out.add(first);
  return Array.from(out);
}

function passesFilters(row, f) {
  if (f.minStars > 0 && (row.s || 0) < f.minStars) return false;
  // Category facet: OR within selection, same as tags.
  if (f.cats && f.cats.length) {
    const have = new Set(row.c || []);
    let ok = false;
    for (const c of f.cats) {
      if (have.has(c)) { ok = true; break; }
    }
    if (!ok) return false;
  }
  if (f.tags && f.tags.length) {
    const have = new Set((row.g || []).map((g) => g.toLowerCase()));
    let ok = false;
    for (const t of f.tags) {
      if (have.has(t)) { ok = true; break; }
    }
    if (!ok) return false;
  }
  return true;
}

async function runQuery(id, q, filters) {
  const t0 = performance.now();
  const ids = candidateShards(q);
  const groups = await Promise.all(ids.map(loadShard));

  const seen = new Set();
  const hits = [];
  const tagCounts = new Map();
  const catCounts = new Map();
  const qy = (q || "").toLowerCase();

  for (const g of groups) {
    for (const row of g || []) {
      if (seen.has(row.u)) continue;
      seen.add(row.u);
      const tags = row.g || [];
      for (let i = 0; i < tags.length; i++) {
        tagCounts.set(tags[i], (tagCounts.get(tags[i]) || 0) + 1);
      }
      const cats = row.c || [];
      for (let i = 0; i < cats.length; i++) {
        catCounts.set(cats[i], (catCounts.get(cats[i]) || 0) + 1);
      }
      if (!passesFilters(row, filters)) continue;
      const s = qy ? score(row, qy) : 1;
      if (s > 0) hits.push({ row: row, s: s });
    }
  }

  hits.sort((a, b) => (b.s - a.s) || ((b.row.s || 0) - (a.row.s || 0)));

  const topTags = Array.from(tagCounts.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, 40)
    .map((e) => [e[0], e[1]]);

  const topCats = Array.from(catCounts.entries())
    .sort((a, b) => b[1] - a[1])
    .map((e) => [e[0], e[1]]);

  self.postMessage({
    type: "results",
    id: id,
    q: q,
    rows: hits.slice(0, 300).map((h) => h.row),
    total: hits.length,
    tags: topTags,
    cats: topCats,
    elapsedMs: Math.round(performance.now() - t0),
  });
}

/**
 * Landing page content, computed once from the shards already in memory.
 *
 * Why this exists
 * ---------------
 * With no query the result list is ordered by stars, and that is the right order
 * for "show me the most popular things". It is the wrong first impression for a
 * directory. Measured against the real corpus, the top twenty by stars are
 * almost entirely framework documentation and "awesome" lists: Docusaurus, Ant
 * Design, zustand, awesome-python. Those are projects people arrive at already
 * knowing they exist, and several of those Pages URLs are redirect stubs. A
 * visitor who lands here is asking "what is out there?", and a star leaderboard
 * answers a question they did not ask.
 *
 * So the front page gets shelves they can browse by kind, plus a band of
 * obscure-but-descriptive sites. Star order is kept for the full list below,
 * where it is the expected meaning of "no filter".
 *
 * This lives here rather than in app.js because the shards are already loaded in
 * this worker for a broad query; building the landing on the main thread would
 * mean downloading 2.3 MB a second time.
 */

/**
 * Landing page content: shelves a person chose.
 *
 * Why this is hand-written
 * ------------------------
 * The first attempt derived the shelves from the corpus automatically: take the
 * most-starred rows in each category. Measured against the real data that
 * produced a front page of "Redirecting..." stubs and documentation —
 * langchain-ai's row is titled "Redirecting to LangGraph Documentation",
 * apache's is "Redirecting to Apache Superset", and the "blogs" shelf came out
 * as Tabler Admin Template and MkDocs. The categories are the classifier's
 * opinion, so any heuristic inherits its mistakes.
 *
 * A second attempt added an "obscure gems" band scored on description length
 * and topic count. Of 2,265 low-star candidates that passed, the top of the
 * ranking was resume builders, "online CV" pages and AI landing-page templates.
 * There is no honest version of that section for this corpus, so it was dropped
 * rather than shipped with flattering copy over it.
 *
 * So these are chosen, and the choice is defensible in a way an automatic one
 * was not: every entry was checked to exist in the corpus and to actually serve,
 * and each shelf is a kind of site rather than a rank. They will rot, which is
 * why the front page link-checks them live and why `missing` is reported below.
 */
const CURATED = [
  {
    id: "play",
    label: "Games to play",
    blurb: "Things you can open and poke.",
    cats: ["games"],
    urls: [
      "https://gabrielecirulli.github.io/2048/",
      "https://maxbittker.github.io/sandspiel/",
      "https://victorqribeiro.github.io/isocity/",
      "https://thomaspark.github.io/flexboxfroggy/",
      "https://thomaspark.github.io/gridgarden/",
      "https://ihhub.github.io/fheroes2/",
      "https://lxgr-linux.github.io/pokete",
      "https://pshenok.github.io/server-survival/",
    ],
  },
  {
    id: "viz",
    label: "Data visualisation",
    blurb: "Charts, maps and visual explainers.",
    cats: ["showcase"],
    urls: [
      "https://marceloprates.github.io/prettymaps/",
      "https://nbedos.github.io/termtosvg/",
      "https://williamngan.github.io/pts/",
      "https://plouc.github.io/nivo/",
      "https://visgl.github.io/deck.gl/",
      "https://tensorflow.github.io/tfjs/",
      "https://deck-of-cards.github.io/deck-of-cards/",
    ],
  },
  {
    id: "tools",
    label: "Tools that do a job",
    blurb: "Software you install and use.",
    cats: ["tools", "dashboards"],
    urls: [
      "https://louislam.github.io/uptime-kuma/",
      "https://gethomepage.github.io/homepage/",
      "https://filebrowser.github.io/filebrowser/",
      "https://m1k1o.github.io/neko/",
      "https://spotdl.github.io/spotify-downloader/",
      "https://asdf-vm.github.io/asdf/",
      "https://gitleaks.github.io/gitleaks/",
      "https://pranshuparmar.github.io/witr/",
    ],
  },
  {
    id: "people",
    label: "People's sites",
    blurb: "Hand-made corners of the web.",
    cats: ["portfolio"],
    urls: [
      "https://bchiang7.github.io/",
      "https://ovilia.github.io/",
      "https://jarrekk.github.io/Jalpc/",
      "https://mldangelo.github.io/personal-site/",
      "https://renovamen.github.io/playground-macos/",
      "https://ryanfitzgerald.github.io/devportfolio",
      "https://varadbhogayata.github.io/",
      "https://rajaprerak.github.io/",
    ],
  },
  {
    id: "learn",
    label: "Learn something",
    blurb: "Guides and references worth your time.",
    cats: ["learning"],
    urls: [
      "https://keon.github.io/algorithms/",
      "https://federico-busato.github.io/Modern-CPP-Programming/",
      "https://github.github.io/opensource.guide/",
      "https://bloomberg.github.io/memray/",
      "https://beetbox.github.io/beets/",
      "https://serhii-londar.github.io/open-source-mac-os-apps/",
      "https://datawhalechina.github.io/easy-vibe/",
      "https://vinta.github.io/awesome-python/",
    ],
  },
  {
    id: "writing",
    label: "Blogs",
    blurb: "Long-form, on the open web.",
    cats: ["blog"],
    urls: [
      "https://qiubaiying.github.io/",
      "https://meekdai.github.io/",
      "https://mzlogin.github.io/",
      "https://dobiasd.github.io/articles/",
      "https://amandakelake.github.io/blog/",
      "https://xugaoyi.github.io/vuepress-theme-vdoing/",
      "https://varharrie.github.io/",
      "https://srid.github.io/neuron/",
    ],
  },
];

let landing = null;
let landingPending = null;

async function allRows() {
  const ids = candidateShards("");
  const groups = await Promise.all(ids.map(loadShard));
  const seen = new Set();
  const rows = [];
  for (const g of groups) {
    for (const row of g || []) {
      if (seen.has(row.u)) continue;
      seen.add(row.u);
      rows.push(row);
    }
  }
  return rows;
}

async function buildLanding() {
  const rows = await allRows();
  const byUrl = new Map(rows.map((r) => [r.u, r]));

  const missing = [];
  const shelves = CURATED.map((s) => {
    const picked = [];
    for (const u of s.urls) {
      const row = byUrl.get(u);
      if (row) picked.push(row);
      // Reported rather than dropped silently: a curated entry that falls out
      // of the corpus should be noticed and replaced, not quietly disappear
      // from the front page.
      else missing.push({ shelf: s.id, url: u });
    }
    const count = rows.filter((row) => (row.c || []).some((c) => s.cats.includes(c))).length;
    return {
      id: s.id,
      label: s.label,
      blurb: s.blurb,
      cats: s.cats,
      count,
      rows: picked,
    };
  }).filter((s) => s.rows.length > 0);

  return { shelves, missing, total: rows.length };
}

function landingPayload() {
  if (landing) return Promise.resolve(landing);
  if (!landingPending) {
    landingPending = buildLanding().then(
      (l) => { landing = l; return l; },
      () => null,
    );
  }
  return landingPending;
}

self.onmessage = async (e) => {
  const msg = e.data || {};
  try {
    if (msg.type === "init") {
      manifest = msg.manifest;
      self.postMessage({ type: "ready", total: manifest.total });
      landingPayload().then((l) => {
        if (l) self.postMessage({ type: "landing", landing: l });
      });
      return;
    }
    if (msg.type === "query") {
      await runQuery(msg.id, msg.q || "", msg.filters || { tags: [], minStars: 0 });
    }
  } catch (err) {
    self.postMessage({ type: "error", id: msg.id, message: String(err) });
  }
};
