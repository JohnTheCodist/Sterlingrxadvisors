const MONTH_NAMES = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/**
 * Parse a label from the widget data into its date parts.
 * Handles: "2025", "2025-02", "2025/02", "2025-01-15", "2025-W01", "2025-Q1"
 * Returns null if it doesn't look like a date label.
 */
export function parseDateLabel(label) {
  if (!label || typeof label !== 'string') return null;
  const trimmed = label.trim();
  // year-month-day (dash or slash)
  let m = trimmed.match(/^(\d{4})[\/\-](\d{2})[\/\-](\d{2})$/);
  if (m) return { year: +m[1], month: +m[2], day: +m[3] };
  // year-month (dash or slash)
  m = trimmed.match(/^(\d{4})[\/\-](\d{2})$/);
  if (m) return { year: +m[1], month: +m[2], day: null };
  // year-week
  m = trimmed.match(/^(\d{4})-W(\d{2})$/);
  if (m) return { year: +m[1], week: +m[2] };
  // year only
  m = trimmed.match(/^(\d{4})$/);
  if (m) return { year: +m[1] };
  return null;
}

/**
 * Build a smart XAxis tick formatter. If all data points are from the same year,
 * display just the month name (e.g. "Feb"). If they span multiple years,
 * display abbreviated month + year (e.g. "Feb '25").
 *
 * @param {Array} chartData — array of data objects
 * @param {string} [key='label'] — the data key containing date strings
 */
export function makeDateFormatter(chartData, key = 'label') {
  const parsed = (chartData || [])
    .map(d => parseDateLabel(d[key]))
    .filter(Boolean);

  if (parsed.length === 0) return { tickFormatter: (v) => v, monthOnly: false };

  const years = new Set(parsed.map(p => p.year));
  const singleYear = years.size === 1;

  const tickFormatter = (label) => {
    const p = parseDateLabel(label);
    if (!p) return label;
    // Year-only data
    if (p.year && p.month == null && p.week == null) return String(p.year);
    // Year-week
    if (p.week != null) {
      return singleYear ? `W${p.week}` : `W${p.week} '${String(p.year).slice(2)}`;
    }
    // Year-month-day
    if (p.day != null) {
      const mon = MONTH_NAMES[p.month - 1];
      return singleYear ? `${mon} ${p.day}` : `${mon} ${p.day} '${String(p.year).slice(2)}`;
    }
    // Year-month (most common)
    if (p.month != null) {
      return singleYear ? MONTH_NAMES[p.month - 1] : `${MONTH_NAMES[p.month - 1]} '${String(p.year).slice(2)}`;
    }
    return label;
  };

  return { tickFormatter, monthOnly: singleYear };
}

const LONG_MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December'];

/**
 * "2026-07" -> "July 2026".
 *
 * The month KEY stays "2026-07" everywhere — it is what the server sorts and
 * groups on — so this is display only. Use it wherever a month is read as
 * text (table cells, headings, sentences); chart tick labels keep using
 * makeDateFormatter above, which deliberately abbreviates because axis labels
 * have to fit between neighbouring ticks.
 *
 * Anything that isn't a recognisable year-month is returned unchanged rather
 * than rendered as "undefined 2026".
 */
export function formatMonthLong(ym) {
  const p = parseDateLabel(typeof ym === 'string' ? ym : String(ym ?? ''));
  if (!p || p.month == null || p.year == null) return ym == null ? '' : String(ym);
  const name = LONG_MONTH_NAMES[p.month - 1];
  return name ? `${name} ${p.year}` : String(ym);
}
