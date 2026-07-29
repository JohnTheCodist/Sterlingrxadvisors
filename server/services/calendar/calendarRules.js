/**
 * Calendar Intelligence — configuration-driven demand rules.
 *
 * Pure data, no logic. Every rule matches the CalendarDemandRule shape
 * documented in calendarTypes.js. Category names deliberately reuse the
 * same strings as weatherDecisionRules.js's CATEGORY_KEYWORDS where the
 * same therapeutic category applies (Analgesic, GI Agent, Oral Rehydration
 * Therapy, Anti-Malarial, Antihistamine / Anti-Allergy) so a future
 * Decision Engine phase can reconcile weather- and calendar-driven signals
 * without a translation layer — this file does not import or reference
 * that module in any way.
 */

const CALENDAR_RULES = [
  // ---- Christmas (Dec 25) ----
  { event: 'Christmas', category: 'Contraceptive', expectedDemand: 'Increase', evidenceStrength: 'Moderate',
    rationale: 'Social gatherings and travel may increase seasonal demand.', startOffsetDays: -14, endOffsetDays: 3 },
  { event: 'Christmas', category: 'GI Agent', expectedDemand: 'Increase', evidenceStrength: 'Strong',
    rationale: 'Holiday meals commonly increase digestive complaints.', startOffsetDays: -3, endOffsetDays: 7 },
  { event: 'Christmas', category: 'Analgesic', expectedDemand: 'Increase', evidenceStrength: 'Moderate',
    rationale: 'Increased alcohol consumption and travel fatigue raise headache and pain complaints.', startOffsetDays: -3, endOffsetDays: 5 },

  // ---- New Year (Jan 1) ----
  { event: 'New Year', category: 'Analgesic', expectedDemand: 'Increase', evidenceStrength: 'Strong',
    rationale: "New Year's Eve celebrations and alcohol consumption increase headache and hangover-related purchases.", startOffsetDays: -1, endOffsetDays: 2 },
  { event: 'New Year', category: 'GI Agent', expectedDemand: 'Increase', evidenceStrength: 'Moderate',
    rationale: 'Continued holiday feasting causes digestive complaints into the new year.', startOffsetDays: -1, endOffsetDays: 5 },
  { event: 'New Year', category: 'Vitamin / Supplement', expectedDemand: 'Increase', evidenceStrength: 'Limited',
    rationale: 'New Year health resolutions drive a short-term rise in supplement purchases.', startOffsetDays: 0, endOffsetDays: 14 },

  // ---- Valentine's Day (Feb 14) ----
  { event: "Valentine's Day", category: 'Contraceptive', expectedDemand: 'Increase', evidenceStrength: 'Strong',
    rationale: "Valentine's Day is strongly associated with increased sexual activity and related purchases.", startOffsetDays: -3, endOffsetDays: 2 },

  // ---- Ramadan (movable — see MOVABLE_ANCHORS in calendarService.js) ----
  { event: 'Ramadan', category: 'Oral Rehydration Therapy', expectedDemand: 'Increase', evidenceStrength: 'Strong',
    rationale: 'Extended daytime fasting without water increases dehydration risk, especially in hot months.', startOffsetDays: -3, endOffsetDays: 30 },
  { event: 'Ramadan', category: 'GI Agent', expectedDemand: 'Increase', evidenceStrength: 'Moderate',
    rationale: 'Fasting followed by large meals (Iftar) disrupts normal eating patterns and increases digestive complaints.', startOffsetDays: -3, endOffsetDays: 30 },
  { event: 'Ramadan', category: 'Vitamin / Supplement', expectedDemand: 'Increase', evidenceStrength: 'Moderate',
    rationale: 'Fasting individuals often seek vitamins and energy supplements to sustain energy levels.', startOffsetDays: -3, endOffsetDays: 30 },

  // ---- Easter (movable — see MOVABLE_ANCHORS in calendarService.js) ----
  { event: 'Easter', category: 'GI Agent', expectedDemand: 'Increase', evidenceStrength: 'Moderate',
    rationale: 'Holiday feasting increases digestive complaints.', startOffsetDays: -3, endOffsetDays: 5 },
  { event: 'Easter', category: 'Analgesic', expectedDemand: 'Increase', evidenceStrength: 'Limited',
    rationale: 'Travel and family gatherings increase minor aches and headaches.', startOffsetDays: -3, endOffsetDays: 3 },

  // ---- School Resumption (three terms — see FIXED_ANCHORS in calendarService.js) ----
  { event: 'School Resumption', category: 'Vitamin / Supplement', expectedDemand: 'Increase', evidenceStrength: 'Moderate',
    rationale: 'Parents purchase vitamins and immune boosters ahead of school resumption.', startOffsetDays: -7, endOffsetDays: 3 },
  { event: 'School Resumption', category: 'Anti-Malarial', expectedDemand: 'Increase', evidenceStrength: 'Limited',
    rationale: 'Boarding-school preparation commonly includes stocking malaria prevention/treatment supplies.', startOffsetDays: -7, endOffsetDays: 3 },

  // ---- School Vacation (main long vacation, ~late July to early September) ----
  { event: 'School Vacation', category: 'Anti-Malarial', expectedDemand: 'Increase', evidenceStrength: 'Moderate',
    rationale: 'Children spend more time outdoors during vacation, increasing mosquito exposure and malaria risk.', startOffsetDays: -3, endOffsetDays: 21 },
  { event: 'School Vacation', category: 'Analgesic', expectedDemand: 'Increase', evidenceStrength: 'Limited',
    rationale: 'Increased outdoor activity and travel among children raises minor injuries and related complaints.', startOffsetDays: -3, endOffsetDays: 21 },
];

module.exports = { CALENDAR_RULES };
