/**
 * Weather Decision Rules — the WeatherDemandRule table + evaluator.
 *
 * Lives outside services/weather/ deliberately: it reads Sales + Inventory
 * data, which the weather module itself must never know about (weather only
 * ever produces risk labels; only this file combines them with real sales
 * history). Everything here is read-only against data that already exists —
 * no writes, no schema changes, no touches to normalizer.js /
 * schemaDetector.js / database.js's own schema.
 *
 * interface WeatherDemandRule {
 *   weatherSignal: string;
 *   category: string;
 *   expectedDemand: 'Increase' | 'Slight Increase' | 'Decrease' | 'Neutral';
 *   confidence: 'High' | 'Medium' | 'Low';
 *   rationale: string;
 * }
 */

// ---- category -> matching keywords (header/name/generic text, lowercase) ----
// Deliberately keyword-based, same pattern as the original antimalarial
// matcher — no ML, no new taxonomy, just terms a real Nigerian pharmacy
// dataset is likely to contain for that category.
const CATEGORY_KEYWORDS = {
  'Anti-Malarial': [
    'malaria', 'antimalarial', 'artemether', 'lumefantrine', 'artesunate',
    'amodiaquine', 'coartem', 'fansidar', 'camoquine',
  ],
  'Oral Rehydration Therapy': [
    'oral rehydration', 'ors', 'rehydration salt', 'electrolyte',
  ],
  Antibiotic: [
    'antibiotic', 'amoxicillin', 'ampiclox', 'augmentin', 'ciprofloxacin',
    'metronidazole', 'azithromycin', 'doxycycline', 'flagyl',
  ],
  Antifungal: [
    'antifungal', 'fluconazole', 'ketoconazole', 'griseofulvin',
    'clotrimazole', 'nystatin', 'terbinafine',
  ],
  'Topical Anti-Infective': [
    'topical', 'antiseptic cream', 'betadine', 'gentian violet', 'ointment',
  ],
  'Asthma / COPD Agent': [
    'asthma', 'copd', 'salbutamol', 'ventolin', 'bronchodilator', 'inhaler', 'theophylline',
  ],
  'Antihistamine / Anti-Allergy': [
    'antihistamine', 'allergy', 'cetirizine', 'loratadine', 'chlorpheniramine',
    'piriton', 'promethazine', 'fexofenadine',
  ],
  Mucolytic: [
    'mucolytic', 'ambroxol', 'bromhexine', 'acetylcysteine', 'expectorant', 'cough syrup',
  ],
  Analgesic: [
    'analgesic', 'paracetamol', 'panadol', 'ibuprofen', 'diclofenac', 'aspirin',
  ],
  'IV Drug': [
    'iv fluid', 'intravenous', 'normal saline', 'dextrose', 'ringer',
  ],
  'GI Agent': [
    'gastrointestinal', 'antacid', 'omeprazole', 'metoclopramide', 'loperamide', 'antidiarrheal',
  ],
};

// ---- weatherSignal name -> which classified risk field must read HIGH ----
const SIGNAL_RISK_FIELD = {
  'Heavy Rainfall': 'rainfallRisk',
  'High Humidity': 'humidityRisk',
  'Harmattan / Dust': 'harmattanRisk',
  'Cold Weather': 'coldRisk',
  'Extreme Heat': 'heatwaveRisk',
};

// Weather signals tied to a fixed Nigerian season — compared season-vs-season.
// Signals not listed here (High Humidity, Cold Weather, Extreme Heat) aren't
// tied to one season, so they're compared recent-vs-prior instead.
const SEASON_MONTHS = {
  'Heavy Rainfall': new Set([4, 5, 6, 7, 8, 9, 10]),   // rainy season
  'Harmattan / Dust': new Set([11, 12, 1, 2]),          // Harmattan
};

const CONFIDENCE_MAP = { High: 90, Medium: 70, Low: 50 };

// The 14 rules from the pharmacist-reviewed table. Categories NOT listed
// here (Hypertension, Diabetes, ARV, etc.) simply have no rule — that
// absence, not a runtime exclusion check, is what keeps chronic-disease
// demand from ever being treated as weather-driven.
const WEATHER_DEMAND_RULES = [
  { weatherSignal: 'Heavy Rainfall', category: 'Anti-Malarial', expectedDemand: 'Increase', confidence: 'High',
    rationale: 'Increased mosquito breeding raises malaria risk.' },
  { weatherSignal: 'Heavy Rainfall', category: 'Oral Rehydration Therapy', expectedDemand: 'Increase', confidence: 'High',
    rationale: 'Increased diarrheal disease risk during rainy periods.' },
  { weatherSignal: 'Heavy Rainfall', category: 'Antibiotic', expectedDemand: 'Slight Increase', confidence: 'Medium',
    rationale: 'Secondary infections may increase, but outbreak data should confirm.' },
  { weatherSignal: 'High Humidity', category: 'Antifungal', expectedDemand: 'Increase', confidence: 'High',
    rationale: 'Fungal skin infections become more common.' },
  { weatherSignal: 'High Humidity', category: 'Topical Anti-Infective', expectedDemand: 'Increase', confidence: 'Medium',
    rationale: 'Moist environments increase skin infections.' },
  { weatherSignal: 'Harmattan / Dust', category: 'Asthma / COPD Agent', expectedDemand: 'Increase', confidence: 'High',
    rationale: 'Dust worsens asthma and COPD symptoms.' },
  { weatherSignal: 'Harmattan / Dust', category: 'Antihistamine / Anti-Allergy', expectedDemand: 'Increase', confidence: 'High',
    rationale: 'Dust triggers allergic rhinitis and related symptoms.' },
  { weatherSignal: 'Harmattan / Dust', category: 'Mucolytic', expectedDemand: 'Increase', confidence: 'Medium',
    rationale: 'Increased cough and mucus production.' },
  { weatherSignal: 'Harmattan / Dust', category: 'Analgesic', expectedDemand: 'Slight Increase', confidence: 'Low',
    rationale: 'Headaches and body aches may increase slightly.' },
  { weatherSignal: 'Cold Weather', category: 'Antihistamine / Anti-Allergy', expectedDemand: 'Increase', confidence: 'Medium',
    rationale: 'Respiratory allergies often increase.' },
  { weatherSignal: 'Cold Weather', category: 'Mucolytic', expectedDemand: 'Increase', confidence: 'High',
    rationale: 'Increased respiratory symptoms.' },
  { weatherSignal: 'Extreme Heat', category: 'Oral Rehydration Therapy', expectedDemand: 'Increase', confidence: 'High',
    rationale: 'Dehydration becomes more common.' },
  { weatherSignal: 'Extreme Heat', category: 'IV Drug', expectedDemand: 'Slight Increase', confidence: 'Medium',
    rationale: 'More dehydration-related clinical use.' },
  { weatherSignal: 'Extreme Heat', category: 'GI Agent', expectedDemand: 'Slight Increase', confidence: 'Medium',
    rationale: 'Heat-related gastrointestinal complaints may increase.' },
];

/**
 * Builds a Postgres boolean fragment matching any of the given keywords
 * against category/name/resolved_generic, case-insensitively (ILIKE is
 * Postgres's case-insensitive LIKE — SQLite's LIKE was case-insensitive by
 * default for ASCII, so ILIKE preserves that same matching behavior).
 */
function categoryWhereFragment(sqlTag, keywords) {
  return keywords
    .map((kw) => `%${kw}%`)
    .map((like) => sqlTag`(p.category ilike ${like} or p.name ilike ${like} or p.resolved_generic ilike ${like})`)
    .reduce((acc, frag) => sqlTag`${acc} or ${frag}`);
}

/**
 * Season-vs-season (or recent-vs-prior, when no fixed season applies)
 * revenue comparison for a category, using whatever date range the
 * uploaded data actually covers. Honest by construction: returns
 * available:false with a stated reason rather than a guessed number
 * whenever either side of the comparison has no real data.
 */
async function categoryDemandEvidence(organizationId, categoryKeywords, seasonMonths) {
  const { getSql, assertOrgId } = require('./db');
  assertOrgId(organizationId);
  const db = getSql();
  const whereFragment = categoryWhereFragment(db, categoryKeywords);

  if (seasonMonths) {
    const rows = await db`
      select to_char(s.sale_date, 'YYYY-MM') as month, c.month as "monthNum",
             sum(s.unit_price * s.quantity) as revenue
      from sale s
      join product p on s.product_id = p.id
      join calendar c on s.calendar_id = c.id
      where s.organization_id = ${organizationId} and (${whereFragment})
      group by month, c.month
    `;

    if (rows.length === 0) return { available: false, reason: 'No sales found for this category in the dataset.' };

    const inSeason = rows.filter((r) => seasonMonths.has(r.monthNum));
    const outSeason = rows.filter((r) => !seasonMonths.has(r.monthNum));
    if (inSeason.length === 0 || outSeason.length === 0) {
      return { available: false, reason: 'Not enough month coverage across both seasons to compare.' };
    }
    const avgIn = inSeason.reduce((s, r) => s + Number(r.revenue), 0) / inSeason.length;
    const avgOut = outSeason.reduce((s, r) => s + Number(r.revenue), 0) / outSeason.length;
    if (avgOut <= 0) return { available: false, reason: 'No off-season baseline revenue to compare against.' };

    const pctIncrease = Math.round(((avgIn - avgOut) / avgOut) * 1000) / 10;
    return { available: true, pctIncrease, comparedAs: 'season-vs-season', avgInPeriodRevenue: Math.round(avgIn), avgOutPeriodRevenue: Math.round(avgOut) };
  }

  // No fixed season for this signal — compare last 30 days vs. the 30 days before that.
  const [row] = await db`
    select
      sum(case when s.sale_date >= current_date - interval '30 days' then s.unit_price * s.quantity else 0 end) as recent,
      sum(case when s.sale_date >= current_date - interval '60 days' and s.sale_date < current_date - interval '30 days' then s.unit_price * s.quantity else 0 end) as prior
    from sale s
    join product p on s.product_id = p.id
    where s.organization_id = ${organizationId} and (${whereFragment})
  `;

  const recent = row ? Number(row.recent || 0) : 0;
  const prior = row ? Number(row.prior || 0) : 0;

  if (!recent && !prior) {
    return { available: false, reason: 'No sales found for this category in the dataset.' };
  }
  if (!prior || prior <= 0) {
    return { available: false, reason: 'Not enough recent history (need both the last 30 days and the 30 days before that) to compare.' };
  }

  const pctIncrease = Math.round(((recent - prior) / prior) * 1000) / 10;
  return { available: true, pctIncrease, comparedAs: 'recent-vs-prior', avgInPeriodRevenue: Math.round(recent), avgOutPeriodRevenue: Math.round(prior) };
}

/**
 * Evaluate every rule against the current weather signal. Returns the
 * qualifying rules (weather risk HIGH + category present in this pharmacy's
 * data), each with its numeric confidence and whatever demand evidence
 * could honestly be computed — capped to the top 2 so weather insights
 * don't crowd out everything else generateInsights() produces.
 */
async function evaluateWeatherDemandRules(organizationId, weatherSignal) {
  if (!weatherSignal) return [];

  const qualifying = WEATHER_DEMAND_RULES.filter((rule) => {
    const riskField = SIGNAL_RISK_FIELD[rule.weatherSignal];
    return riskField && weatherSignal[riskField] === 'HIGH' && CATEGORY_KEYWORDS[rule.category];
  });

  const results = await Promise.all(qualifying.map(async (rule) => {
    const keywords = CATEGORY_KEYWORDS[rule.category];
    const evidence = await categoryDemandEvidence(organizationId, keywords, SEASON_MONTHS[rule.weatherSignal] || null);
    return {
      rule,
      numericConfidence: CONFIDENCE_MAP[rule.confidence] || 60,
      evidence,
    };
  }));

  results.sort((a, b) => {
    // Prefer rules whose own historical data CONFIRMS the clinical
    // hypothesis, then rules with no data either way, then rules the
    // pharmacy's own history actually contradicts — a contradicted rule
    // is the least useful thing to surface as a top-2 recommendation.
    const evidenceScore = (r) => {
      if (!r.evidence.available) return 1;
      return r.evidence.pctIncrease > 0 ? 2 : 0;
    };
    if (evidenceScore(b) !== evidenceScore(a)) return evidenceScore(b) - evidenceScore(a);
    return b.numericConfidence - a.numericConfidence;
  });

  return results.slice(0, 2);
}

module.exports = { evaluateWeatherDemandRules, WEATHER_DEMAND_RULES, CATEGORY_KEYWORDS, categoryDemandEvidence };
