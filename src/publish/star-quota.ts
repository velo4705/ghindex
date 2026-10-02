/**
 * Balancing the published index by capping how many sites each star band
 * contributes.
 *
 * Kept in its own module because build.ts runs main() on import, so a function
 * living there could not be unit tested without triggering a whole build.
 */

/**
 * Star bands, lowest first. The edges are chosen so each band is roughly an
 * order of magnitude, which is also how star counts read to a person.
 */
export const STAR_BANDS: ReadonlyArray<{ lo: number; hi: number; label: string }> = [
  { lo: 0, hi: 100, label: "0-99" },
  { lo: 100, hi: 1000, label: "100-999" },
  { lo: 1000, hi: 10000, label: "1k-9.9k" },
  { lo: 10000, hi: Infinity, label: "10k+" },
];

/** Most sites kept per band. See applyStarQuota for why this number is what it is. */
export const STAR_QUOTA = 600;

/** The subset of a corpus record this rule looks at. */
export interface QuotaCandidate {
  stars?: number | null;
  description?: string | null;
  topics?: string[] | null;
  owner?: string | null;
}

/**
 * Cap how many sites each star band contributes, so the index has roughly equal
 * weight at every level of popularity instead of being swamped by the bottom.
 *
 * Why a quota and not a ceiling
 * -----------------------------
 * The obvious version of this is "drop anything above N stars". Measured against
 * the corpus, that cannot work: the distribution is 4,868 / 1,545 / 1,141 / 259
 * across the four bands, so the excess is at the BOTTOM, and a ceiling only ever
 * deletes a whole band from the top. Band entropy is highest with no filter at
 * all (1.456) and falls to 1.289 at a 10,000-star ceiling — every cut made the
 * spread worse, never better.
 *
 * A quota fixes it by trimming the oversized band down to the size of the others,
 * which also caps the top. At 600 the index becomes 600 / 600 / 600 / 259 for
 * 2,059 sites, entropy 1.931, about 26% of the previous size.
 *
 * What this costs, stated plainly
 * -------------------------------
 * Stars are a weak signal inside the 0-99 band, so trimming 4,868 down to 600
 * keeps the 600 highest-starred of them, and that set is not especially good: it
 * is full of template, resume and boilerplate pages, and 17% of the band matches
 * that pattern outright. This makes the index flatter and smaller; it does not
 * make the low end better curated. That needs quality signals, not stars.
 */
export function applyStarQuota<T extends QuotaCandidate>(
  records: T[],
  quota: number = STAR_QUOTA,
  bands: ReadonlyArray<{ lo: number; hi: number; label: string }> = STAR_BANDS,
): T[] {
  if (quota <= 0) return records.slice();
  const stars = (r: QuotaCandidate) => Number(r.stars) || 0;
  const kept: T[] = [];
  const detail: string[] = [];
  for (const band of bands) {
    const inBand = records.filter((r) => stars(r) >= band.lo && stars(r) < band.hi);
    if (inBand.length <= quota) {
      kept.push(...inBand);
      detail.push(`${band.label}=${inBand.length}`);
      continue;
    }
    // Stars descending, then the two signals that mean someone cared enough to
    // write about the thing. The tiebreak matters because a whole band often
    // shares a star count, and without it the cut would be decided by shard
    // order, which is arbitrary.
    inBand.sort(
      (a, b) =>
        stars(b) - stars(a) ||
        String(b.description ?? "").length - String(a.description ?? "").length ||
        (b.topics?.length ?? 0) - (a.topics?.length ?? 0) ||
        String(a.owner ?? "").localeCompare(String(b.owner ?? "")),
    );
    kept.push(...inBand.slice(0, quota));
    detail.push(`${band.label}=${quota}/${inBand.length}`);
  }
  const dropped = records.length - kept.length;
  const summary = `[star-quota] ${quota}/band: ${kept.length} kept from ${records.length}` +
    (dropped ? ` (${dropped} dropped) · ${detail.join(" ")}` : "");
  console.log(summary);
  return kept;
}

/** Band label for a star count, for tests and reporting. */
export function bandOf(stars: number, bands = STAR_BANDS): string {
  for (const b of bands) if (stars >= b.lo && stars < b.hi) return b.label;
  return "out of range";
}
