/**
 * Calendar Intelligence Service.
 *
 * Single responsibility: given a date, return which configured calendar
 * demand rules are currently active. Nothing else.
 *
 * Explicitly does NOT: generate recommendations, trigger reorder alerts,
 * calculate stock requirements, calculate confidence scores, or touch
 * sales data, inventory data, weather data, or NCDC data. It does not
 * import database.js, businessHealth.js, recommendations.js, or anything
 * under services/weather/ — this module has zero dependencies beyond the
 * calendar configuration itself.
 */

const { CALENDAR_RULES } = require('./calendarRules');

// Fixed Gregorian-calendar anchors — same month/day every year. Some events
// (School Resumption, School Vacation) recur more than once a year, so each
// maps to an array of anchors.
const FIXED_ANCHORS = {
  Christmas: [{ month: 12, day: 25 }],
  'New Year': [{ month: 1, day: 1 }],
  "Valentine's Day": [{ month: 2, day: 14 }],
  // Nigeria's three school terms, approximate typical resumption dates.
  'School Resumption': [
    { month: 1, day: 8 },   // second term
    { month: 4, day: 22 },  // third term
    { month: 9, day: 16 },  // first term / new academic year
  ],
  // Main long vacation (the short Dec/April breaks are already covered by
  // the Christmas/Easter/School Resumption windows above).
  'School Vacation': [{ month: 7, day: 20 }],
};

// Movable feasts don't fall on a fixed month/day — Phase 1 uses a known-date
// table rather than a lunar/computus calculation, so it only resolves for
// the years listed here. Extend this table as further years are needed.
const MOVABLE_ANCHORS = {
  Ramadan: {
    2024: { month: 3, day: 11 },
    2025: { month: 3, day: 1 },
    2026: { month: 2, day: 18 },
    2027: { month: 2, day: 8 },
  },
  Easter: {
    2024: { month: 3, day: 31 },
    2025: { month: 4, day: 20 },
    2026: { month: 4, day: 5 },
    2027: { month: 3, day: 28 },
  },
};

function stripTime(date) {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate());
}

function addDays(date, days) {
  const d = new Date(date);
  d.setDate(d.getDate() + days);
  return d;
}

/**
 * Resolve every anchor date for an event in a given year. Returns an empty
 * array (not a guess) if the event has no configured anchor for that year —
 * relevant for movable feasts outside the configured MOVABLE_ANCHORS range.
 */
function resolveAnchors(event, year) {
  if (FIXED_ANCHORS[event]) {
    return FIXED_ANCHORS[event].map((a) => new Date(year, a.month - 1, a.day));
  }
  if (MOVABLE_ANCHORS[event]) {
    const a = MOVABLE_ANCHORS[event][year];
    return a ? [new Date(year, a.month - 1, a.day)] : [];
  }
  return [];
}

/**
 * Which configured calendar demand rules are active for the supplied date.
 * Checks anchors in the surrounding years too, so windows that cross a
 * year boundary (e.g. New Year's -1 day offset landing on Dec 31) resolve
 * correctly. Does not merge or deduplicate — if two anchor instances of the
 * same event both cover the date, both are returned.
 *
 * @param {Date} date
 * @returns {Array<{event:string, category:string, expectedDemand:string, evidenceStrength:string, rationale:string}>}
 */
function getCalendarSignals(date) {
  const target = stripTime(date);
  const eventNames = [...new Set(CALENDAR_RULES.map((r) => r.event))];
  const active = [];

  for (const event of eventNames) {
    const anchors = [
      ...resolveAnchors(event, target.getFullYear() - 1),
      ...resolveAnchors(event, target.getFullYear()),
      ...resolveAnchors(event, target.getFullYear() + 1),
    ];
    if (anchors.length === 0) continue;

    const rulesForEvent = CALENDAR_RULES.filter((r) => r.event === event);
    for (const anchor of anchors) {
      for (const rule of rulesForEvent) {
        const windowStart = addDays(anchor, rule.startOffsetDays);
        const windowEnd = addDays(anchor, rule.endOffsetDays);
        if (target >= windowStart && target <= windowEnd) {
          active.push({
            event: rule.event,
            category: rule.category,
            expectedDemand: rule.expectedDemand,
            evidenceStrength: rule.evidenceStrength,
            rationale: rule.rationale,
          });
        }
      }
    }
  }

  return active;
}

module.exports = { getCalendarSignals };
