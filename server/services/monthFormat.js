/**
 * Turning a month KEY into a month LABEL.
 *
 * Throughout the pipeline a month is stored as "2026-07". That is deliberate
 * and must stay: metrics.js sorts months with `a.month.localeCompare(b.month)`,
 * analytics.js pivots on it, and widgets group by it. Sorting "July 2026"
 * alphabetically would put April before January, so the key is never the thing
 * to change — only what gets printed from it.
 *
 * Before this, four files each had their own private monthLabel() producing
 * four different results ("Jul 2026", "Jul '26", "Jul 26"), and several places
 * printed the raw key straight to the screen, which is where "2026-07" was
 * reaching pharmacy owners.
 *
 * Two forms, because they solve different problems:
 *
 *   monthLong  — "July 2026". The default. Use for prose, tables, headings,
 *                anything read as a sentence.
 *   monthShort — "Jul '26". ONLY for chart tick labels sitting under a bar,
 *                where the available width is CONTENT_WIDTH / number-of-months
 *                and a long label overlaps its neighbours. That is a real
 *                layout constraint, not a style preference.
 */

const LONG = ['January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December'];
const SHORT = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
  'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/**
 * Split "2026-07" (or "2026-07-15") into parts. Returns null for anything
 * that isn't a recognisable year-month, so callers can fall back to echoing
 * the original rather than printing "undefined 2026" or "NaN".
 */
function parse(ym) {
  if (ym == null) return null;
  const m = /^(\d{4})-(\d{1,2})/.exec(String(ym).trim());
  if (!m) return null;
  const monthIdx = parseInt(m[2], 10) - 1;
  if (monthIdx < 0 || monthIdx > 11) return null;
  return { year: m[1], monthIdx };
}

/** "2026-07" -> "July 2026". Unparseable input is returned unchanged. */
function monthLong(ym) {
  const p = parse(ym);
  if (!p) return ym == null ? '' : String(ym);
  return `${LONG[p.monthIdx]} ${p.year}`;
}

/**
 * "2026-07" -> "Jul '26". Reserve for width-constrained chart axes; prefer
 * monthLong everywhere a full label fits.
 */
function monthShort(ym) {
  const p = parse(ym);
  if (!p) return ym == null ? '' : String(ym);
  return `${SHORT[p.monthIdx]} '${p.year.slice(2)}`;
}

module.exports = { monthLong, monthShort, LONG_MONTH_NAMES: LONG, SHORT_MONTH_NAMES: SHORT };
