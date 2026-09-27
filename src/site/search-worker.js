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

self.onmessage = async (e) => {
  const msg = e.data || {};
  try {
    if (msg.type === "init") {
      manifest = msg.manifest;
      self.postMessage({ type: "ready", total: manifest.total });
      return;
    }
    if (msg.type === "query") {
      await runQuery(msg.id, msg.q || "", msg.filters || { tags: [], minStars: 0 });
    }
  } catch (err) {
    self.postMessage({ type: "error", id: msg.id, message: String(err) });
  }
};
