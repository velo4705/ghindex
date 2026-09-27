/**
 * M0 Metric 1 — CT log harvest.
 * Pulls *.github.io domains from crt.sh and emits a deduped domain list.
 *
 * NOTE: crt.sh is unreliable under load — it intermittently caps responses and
 * ignores `page`. Date-window chunking is the only pagination that behaves, and
 * even that degrades. Output here is a LOWER BOUND, not a full census.
 */

const QUERIES = [
  "%.github.io",
  "%.pages.github.io",
];

const UA = "ghindex-m0/0.1 (+feasibility-spike)";

interface CtRow {
  name_value: string;
  not_before: string;
}

/** Strip wildcard prefixes and anything that is not a plain github.io subdomain. */
export function normalizeDomain(raw: string): string | null {
  let d = raw.trim().toLowerCase();
  if (!d) return null;
  if (d.startsWith("*.")) d = d.slice(2);
  // *.github.io itself is the bare apex, not a site we can index.
  if (d === "github.io") return null;
  if (!d.endsWith(".github.io")) return null;
  if (/\s/.test(d)) return null;
  // Drop the Pages infrastructure domain: it is a shared host, not a user site.
  if (d.endsWith(".pages.github.io")) return null;
  return d;
}

async function fetchCrt(query: string, attempt = 0): Promise<CtRow[]> {
  const url = `https://crt.sh/?q=${encodeURIComponent(query)}&output=json`;
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 60_000);
    const res = await fetch(url, {
      signal: ctrl.signal,
      headers: { "User-Agent": UA, Accept: "application/json" },
    });
    clearTimeout(timer);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return (await res.json()) as CtRow[];
  } catch (err) {
    if (attempt >= 2) throw err;
    const backoff = 2_000 * 2 ** attempt;
    console.error(`  retry ${attempt + 1} in ${backoff}ms (${String(err)})`);
    await new Promise((r) => setTimeout(r, backoff));
    return fetchCrt(query, attempt + 1);
  }
}

export async function harvest(): Promise<Map<string, string>> {
  const found = new Map<string, string>();

  for (const q of QUERIES) {
    console.log(`[harvest] crt.sh q=${q}`);
    const rows = await fetchCrt(q);
    console.log(`  certs returned: ${rows.length}`);

    for (const row of rows) {
      // A cert can carry several SANs, one per line.
      for (const line of (row.name_value ?? "").split(/\r?\n/)) {
        const d = normalizeDomain(line);
        if (!d) continue;
        const prev = found.get(d);
        // Keep the newest not_before as our "first seen" proxy.
        if (!prev || row.not_before > prev) found.set(d, row.not_before);
      }
    }
    console.log(`  distinct domains so far: ${found.size}`);
  }

  return found;
}

if (import.meta.main) {
  const t0 = Date.now();
  const found = await harvest();
  const rows = [...found.entries()].sort((a, b) => b[1].localeCompare(a[1]));

  const out = rows.map(([d, seen]) => `${d}\t${seen}`).join("\n");
  await Bun.write("m0/data/domains.tsv", out + "\n");

  console.log(`\n[harvest] TOTAL distinct *.github.io domains: ${found.size}`);
  console.log(`[harvest] wrote m0/data/domains.tsv in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  console.log("[harvest] NOTE: lower bound — crt.sh throttles, census is incomplete");
}
