/**
 * M0 Metrics 2-4 — liveness probe.
 *
 * For each domain: HEAD to classify, then GET the survivors to measure
 *   2. live rate
 *   3. X-Frame-Options / CSP frame-ancestors rate   (does Grid-view iframe work?)
 *   4. <title> / meta[description] yield            (are descriptions real?)
 */

const UA =
  "Mozilla/5.0 (compatible; ghindex-m0/0.1; +https://github.com/; feasibility spike)";
const CONCURRENCY = 24;
const TIMEOUT_MS = 12_000;

export interface ProbeResult {
  domain: string;
  labels: number;
  status: number;
  finalUrl: string | null;
  error: string | null;
  blocksFraming: boolean | null;
  hasTitle: boolean | null;
  hasDescription: boolean | null;
}

/**
 * GitHub's Pages cert is a single-label wildcard (*.github.io), so it cannot
 * validate a.b.github.io. Those names appear in CT logs but are unreachable on
 * both HTTPS and HTTP — they are structural noise, not dead sites.
 */
export function isIndexable(domain: string): boolean {
  return domain.split(".").length === 3;
}

function titleOf(html: string): string | null {
  const m = html.match(/<title[^>]*>([\s\S]{1,300}?)<\/title>/i);
  if (!m) return null;
  const t = m[1].replace(/\s+/g, " ").trim();
  return t.length > 0 ? t : null;
}

function descriptionOf(html: string): string | null {
  const re = /<meta[^>]+name\s*=\s*["']?description["']?[^>]*>/i;
  const tag = html.match(re)?.[0];
  if (!tag) return null;
  const c = tag.match(/content\s*=\s*["']([^"']{1,500})["']/i)?.[1];
  return c && c.trim().length > 0 ? c.trim() : null;
}

/** Only these block embedding. A permissive value means framing is allowed. */
function blocksFraming(headers: Headers): boolean {
  const xfo = headers.get("x-frame-options");
  if (xfo) {
    const v = xfo.toLowerCase();
    if (!v.includes("allowall") && !v.includes("allow-from")) return true;
  }
  const csp = headers.get("content-security-policy");
  if (csp && /frame-ancestors/i.test(csp)) {
    const fa = csp.match(/frame-ancestors\s+([^;]+)/i)?.[1]?.toLowerCase() ?? "";
    if (!/\*|\bself\b/.test(fa)) return true;
  }
  return false;
}

async function probeOne(domain: string): Promise<ProbeResult> {
  const url = `https://${domain}/`;
  const base: ProbeResult = {
    domain,
    labels: domain.split(".").length,
    status: 0,
    finalUrl: null,
    error: null,
    blocksFraming: null,
    hasTitle: null,
    hasDescription: null,
  };

  let headRes: Response;
  try {
    headRes = await fetch(url, {
      method: "HEAD",
      redirect: "follow",
      signal: AbortSignal.timeout(TIMEOUT_MS),
      headers: { "User-Agent": UA },
    });
  } catch (err) {
    return { ...base, error: String(err).slice(0, 120) };
  }

  base.status = headRes.status;
  base.finalUrl = headRes.url;
  base.blocksFraming = blocksFraming(headRes.headers);

  if (!headRes.ok) return base;

  // Alive: spend a GET to measure metadata yield.
  try {
    const getRes = await fetch(headRes.url, {
      method: "GET",
      redirect: "follow",
      signal: AbortSignal.timeout(TIMEOUT_MS),
      headers: { "User-Agent": UA, Accept: "text/html" },
    });
    const ctype = getRes.headers.get("content-type") ?? "";
    if (!ctype.includes("html")) return base;
    const html = await getRes.text();
    base.hasTitle = titleOf(html) !== null;
    base.hasDescription = descriptionOf(html) !== null;
  } catch {
    // Keep liveness + framing; metadata stays unknown.
  }

  return base;
}

async function pool<T, R>(items: T[], size: number, fn: (t: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.min(size, items.length) }, async () => {
    for (;;) {
      const i = cursor++;
      if (i >= items.length) return;
      out[i] = await fn(items[i]);
    }
  });
  await Promise.all(workers);
  return out;
}

export async function probe(domains: string[]): Promise<ProbeResult[]> {
  let done = 0;
  return pool(domains, CONCURRENCY, async (d) => {
    const r = await probeOne(d);
    done++;
    if (done % 50 === 0 || done === domains.length) {
      process.stdout.write(`\r  probed ${done}/${domains.length}`);
    }
    return r;
  });
}

if (import.meta.main) {
  const file = Bun.file("m0/data/domains.tsv");
  if (!(await file.exists())) {
    console.error("run `bun run m0/harvest.ts` first");
    process.exit(1);
  }

  const text = await file.text();
  const all = text
    .split("\n")
    .map((l) => l.split("\t")[0]?.trim())
    .filter((s): s is string => !!s);

  // Probe every indexable (owner.github.io) domain — the 3-label population is
  // the only one a user can actually visit, so it is the only one that matters.
  const indexable = all.filter(isIndexable);
  const excluded = all.length - indexable.length;

  const SAMPLE = Number(process.env.SAMPLE ?? 300);
  const step = Math.max(1, Math.floor(indexable.length / SAMPLE));
  const sample = indexable.filter((_, i) => i % step === 0).slice(0, SAMPLE);

  console.log(
    `[probe] harvested=${all.length} indexable=${indexable.length} ` +
      `structurally-unreachable=${excluded} sampling=${sample.length}`,
  );
  const t0 = Date.now();
  const results = await probe(sample);
  const secs = (Date.now() - t0) / 1000;
  console.log(`\n[probe] done in ${secs.toFixed(1)}s`);

  await Bun.write(
    "m0/data/probe-results.json",
    JSON.stringify(
      {
        universe: all.length,
        indexableUniverse: indexable.length,
        structurallyUnreachable: excluded,
        sampleSize: sample.length,
        seconds: secs,
        results,
      },
      null,
      2,
    ),
  );
  console.log("[probe] wrote m0/data/probe-results.json");
}
