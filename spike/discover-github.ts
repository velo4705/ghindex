/**
 * M0 follow-up — discovery via the GitHub API, and the liveness question.
 *
 * M0's CT-log probe found only 44.2% of harvested domains alive. But CT logs
 * skew to OLD, ABANDONED repos. This script builds a population from repos
 * GitHub reports as actively Pages-enabled, then probes the same way, to test
 * whether 44% is a real death rate or a sampling artifact of CT.
 *
 * Also settles the URL-shape question: a Pages site is served at
 * owner.github.io ONLY when the repo is named "owner.github.io"; otherwise it
 * is a subpath at owner.github.io/<repo>/.
 */

import { readFileSync } from "node:fs";

const TOKEN = process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN ?? "";
if (!TOKEN) {
  console.error("set GITHUB_TOKEN (gh auth token) — unauth search is only 10/min");
  process.exit(1);
}

const H = {
  Authorization: `Bearer ${TOKEN}`,
  "User-Agent": "ghindex-m0/0.1",
  Accept: "application/vnd.github+json",
};

interface Repo {
  full_name: string;
  owner: { login: string };
  name: string;
  has_pages: boolean;
  homepage: string | null;
  topics?: string[];
  description: string | null;
  stargazers_count: number;
  pushed_at: string;
}

async function search(q: string, page = 1): Promise<{ total: number; items: Repo[] }> {
  const url = `https://api.github.com/search/repositories?q=${encodeURIComponent(q)}&per_page=100&page=${page}`;
  const res = await fetch(url, { headers: H });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`search HTTP ${res.status}: ${body.slice(0, 160)}`);
  }
  return await res.json();
}

/**
 * A Pages site URL for a repo. GitHub serves owner.github.io directly when the
 * repo is the user's own site repo; everything else is a subpath.
 */
export function pagesUrlFor(repo: Repo): string {
  const owner = repo.owner.login.toLowerCase();
  if (repo.homepage && /\.github\.io/.test(repo.homepage)) return repo.homepage;
  if (repo.name.toLowerCase() === `${owner}.github.io`) return `https://${owner}.github.io/`;
  return `https://${owner}.github.io/${repo.name.toLowerCase()}/`;
}

async function main() {
  // Diverse seeds so the sample is not dominated by one ecosystem.
  const SEEDS = [
    "topic:portfolio",
    "topic:game",
    "topic:documentation",
    "topic:blog",
    "topic:dashboard",
    "topic:react",
  ];

  const repos = new Map<string, Repo>();
  for (const seed of SEEDS) {
    for (let page = 1; page <= 2; page++) {
      try {
        const { total, items } = await search(`${seed} stars:>5`, page);
        const paged = items.filter((r) => r.has_pages);
        for (const r of paged) repos.set(r.full_name, r);
        console.log(
          `[search] ${seed} p${page}: total=${total} items=${items.length} has_pages=${paged.length} (cum ${repos.size})`,
        );
      } catch (err) {
        console.error(`[search] ${seed} p${page} FAILED: ${String(err).slice(0, 120)}`);
      }
      // Search is 30/min authenticated — pace to stay under secondary limits.
      await new Promise((r) => setTimeout(r, 2500));
    }
  }

  const list = [...repos.values()];
  console.log(`\n[discover] ${list.length} Pages-enabled repos found`);

  // Subpath vs apex — this is the URL-shape risk.
  const subpath = list.filter((r) => {
    const owner = r.owner.login.toLowerCase();
    return r.name.toLowerCase() !== `${owner}.github.io`;
  });
  const apex = list.length - subpath.length;
  console.log(`[discover] served at owner.github.io/<repo>/ (subpath): ${subpath.length}`);
  console.log(`[discover] served at owner.github.io/ (apex):          ${apex}`);
  console.log(`[discover] sample subpath URL: ${subpath[0] ? pagesUrlFor(subpath[0]) : "n/a"}`);

  await Bun.write(
    "m0/data/github-repos.json",
    JSON.stringify(
      list.map((r) => ({
        full_name: r.full_name,
        owner: r.owner.login,
        name: r.name,
        url: pagesUrlFor(r),
        homepage: r.homepage,
        topics: r.topics ?? [],
        description: r.description,
        stars: r.stargazers_count,
        pushed_at: r.pushed_at,
      })),
      null,
      2,
    ),
  );
  console.log("[discover] wrote m0/data/github-repos.json");
}

await main();
