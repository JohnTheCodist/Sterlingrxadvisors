/**
 * Disease -> pharmacy therapeutic category mappings. Pure configuration —
 * diseaseIntelligence.js reads this and contains no hardcoded mappings of
 * its own.
 *
 * `disease` values match diseaseNormalizer.js's canonical KNOWN_DISEASES
 * names exactly, so rules actually connect to real DiseaseObservation
 * records (e.g. "Cerebrospinal Meningitis (CSM)", not the spec's shorthand
 * "Meningitis") — a rule that can never match anything is worse than no
 * rule.
 *
 * `expectedDemand` here is the rule's baseline hypothesis (more disease
 * cases -> more demand for the associated category) — diseaseIntelligence.js
 * derives the actual output expectedDemand from the *observed* trend, the
 * same "hypothesis vs. observed data" pattern weatherDecisionRules.js uses.
 *
 * `evidenceScore` (0.0-1.0) reflects how strong/direct the clinical link
 * between the disease and category is — e.g. Cholera -> Oral Rehydration
 * Therapy is a strong, direct link; Cholera -> Antibiotic is real but
 * secondary (used for severe/complicated cases), hence a lower score.
 *
 * Malaria and Influenza are included per spec even though they don't
 * currently appear in NCDC's Week 27/2026 report — this table is meant to
 * hold up across whichever diseases a given week's report actually covers.
 * Acute Flaccid Paralysis (AFP) is deliberately NOT mapped — it's a polio
 * surveillance indicator with no honest, direct pharmacy-category link;
 * per spec, diseases without a configured mapping are correctly ignored,
 * not force-mapped.
 */

const DISEASE_RULES = [
  { disease: 'Malaria', category: 'Anti-Malarial', expectedDemand: 'Increase', evidenceScore: 0.92,
    rationale: 'Increasing malaria cases typically increase demand for antimalarial medicines.' },

  { disease: 'Cholera', category: 'Oral Rehydration Therapy', expectedDemand: 'Increase', evidenceScore: 0.9,
    rationale: 'Cholera causes severe dehydration; oral rehydration therapy is the frontline response.' },
  { disease: 'Cholera', category: 'Antibiotic', expectedDemand: 'Increase', evidenceScore: 0.65,
    rationale: 'Antibiotics are used for moderate-to-severe cholera cases to reduce duration and transmission.' },

  { disease: 'Lassa Fever', category: 'IV Drug', expectedDemand: 'Increase', evidenceScore: 0.75,
    rationale: 'Severe Lassa Fever cases require IV fluids and supportive care.' },
  { disease: 'Lassa Fever', category: 'Antibiotic', expectedDemand: 'Increase', evidenceScore: 0.6,
    rationale: 'Antibiotics are commonly used to manage secondary bacterial infections in Lassa Fever cases.' },

  { disease: 'Cerebrospinal Meningitis (CSM)', category: 'Antibiotic', expectedDemand: 'Increase', evidenceScore: 0.85,
    rationale: 'Bacterial meningitis is treated with antibiotics; case increases raise antibiotic demand.' },

  { disease: 'Measles', category: 'Vitamin / Mineral', expectedDemand: 'Increase', evidenceScore: 0.7,
    rationale: 'Vitamin A supplementation is a standard part of measles case management.' },

  { disease: 'Influenza', category: 'Analgesic', expectedDemand: 'Increase', evidenceScore: 0.7,
    rationale: 'Influenza commonly drives demand for fever and pain relief medication.' },
  { disease: 'Influenza', category: 'Antihistamine / Anti-Allergy', expectedDemand: 'Increase', evidenceScore: 0.6,
    rationale: 'Antihistamines are commonly used for influenza-related respiratory symptoms.' },

  { disease: 'Coronavirus Disease (COVID-19)', category: 'Analgesic', expectedDemand: 'Increase', evidenceScore: 0.65,
    rationale: 'COVID-19 commonly drives demand for fever and pain relief medication.' },
  { disease: 'Coronavirus Disease (COVID-19)', category: 'Vitamin / Mineral', expectedDemand: 'Increase', evidenceScore: 0.55,
    rationale: 'Vitamin/mineral supplements are commonly sought during respiratory illness recovery.' },

  { disease: 'Yellow Fever', category: 'IV Drug', expectedDemand: 'Increase', evidenceScore: 0.6,
    rationale: 'Severe Yellow Fever cases require supportive IV care.' },
  { disease: 'Yellow Fever', category: 'Analgesic', expectedDemand: 'Increase', evidenceScore: 0.5,
    rationale: 'Analgesics are used for fever and body-ache symptoms in Yellow Fever cases.' },

  { disease: 'Diphtheria', category: 'Antibiotic', expectedDemand: 'Increase', evidenceScore: 0.8,
    rationale: 'Diphtheria is a bacterial infection treated with antibiotics alongside antitoxin.' },

  { disease: 'Mpox', category: 'Topical Anti-Infective', expectedDemand: 'Increase', evidenceScore: 0.6,
    rationale: 'Mpox skin lesions are commonly managed with topical anti-infective treatment.' },
  { disease: 'Mpox', category: 'Analgesic', expectedDemand: 'Increase', evidenceScore: 0.5,
    rationale: 'Analgesics are used for fever and pain associated with Mpox.' },
];

module.exports = { DISEASE_RULES };
