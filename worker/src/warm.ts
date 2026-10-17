/**
 * Which states the cron warming pass should fill.
 *
 * Warming everything is not possible and would be wrong anyway. The full key
 * space is roughly 5,000 search states, and a trigger has to finish inside the
 * free tier's 10ms CPU allowance per invocation, so the list is deliberately
 * short and deliberately the pages people actually land on.
 *
 * Two decisions worth stating:
 *
 * - First pages only. Someone arriving on page 1 is the overwhelmingly common
 *   case; a visitor who pages to 7 has already proven they will wait, and their
 *   request still coalesces onto a single upstream call thanks to single-flight.
 *
 * - `resume` leads because it is the query this index is built around, followed
 *   by the categories the tag picker offers. Those are the terms whose absence
 *   would be felt; everything else can afford to be cold.
 *
 * Kept here rather than in the scheduled handler so it can be asserted directly
 * by the tests.
 */
export const WARM_QUERIES = [
  "resume",
  "portfolio",
  "personal website",
  "web app",
  "game",
  "dashboard",
] as const;

/** The page counts to warm per query. Page 1 always; page 2 for the top terms. */
export const WARM_PAGES = [1] as const;

/** The sorts to warm. `updated` first: it is the one that goes stale fastest. */
export const WARM_SORTS = ["updated", "best"] as const;

/**
 * Every cache key the warming pass intends to fill.
 *
 * Kept small on purpose. Each entry is one upstream GitHub request when cold, so
 * this list is really a statement of the request budget the trigger is willing
 * to spend. Doubling it does not double the benefit; it just doubles the cost of
 * a trigger that is already competing with real visitors for the same 30/minute
 * bucket.
 */
export function warmKeys(): Array<{ q: string; page: number; sort: string }> {
  const out: Array<{ q: string; page: number; sort: string }> = [];
  for (const q of WARM_QUERIES) {
    for (const page of WARM_PAGES) {
      for (const sort of WARM_SORTS) {
        out.push({ q, page, sort });
      }
    }
  }
  return out;
}