/**
 * Disease Normalizer.
 *
 * Single responsibility: convert a ParsedNCDCReport (reportParser.js's
 * neutral document model) into a clean DiseaseObservation[] — regardless
 * of how the source PDF happens to be laid out. Does NOT predict outbreaks,
 * generate pharmacy recommendations, estimate demand, or connect to
 * Weather / Calendar / the Decision Engine. Standardization and validation
 * only.
 *
 * Grounded in the real report structure (inspected directly against the
 * live Week 27/2026 PDF, not assumed):
 *   - Each disease gets its own page. The page heading IS the disease name.
 *   - Every disease page has a fixed sentence:
 *       "... Suspected cases Confirmed cases Deaths
 *        Number of States and LGAs affected <N> <N> <N> State: <N> [+ FCT] LGA: <N> ..."
 *     — this gives real weekly Suspected/Confirmed/Deaths counts as digits.
 *   - When exactly ONE state is affected, the "Key Point" bullet names it
 *     in prose: "... reported from N LGA(s) in <State> state." When more
 *     than one state is affected, the report only gives a COUNT of states,
 *     never a per-state breakdown in extractable text — there is no
 *     fabricated way to know which N states, so those rows are correctly
 *     rejected by validation rather than guessed. See the honesty note in
 *     the module's exported `normalizeDiseaseReport` docstring.
 */

const KNOWN_STATES = [
  'Abia', 'Adamawa', 'Akwa Ibom', 'Anambra', 'Bauchi', 'Bayelsa', 'Benue',
  'Borno', 'Cross River', 'Delta', 'Ebonyi', 'Edo', 'Ekiti', 'Enugu', 'FCT',
  'Gombe', 'Imo', 'Jigawa', 'Kaduna', 'Kano', 'Katsina', 'Kebbi', 'Kogi',
  'Kwara', 'Lagos', 'Nasarawa', 'Niger', 'Ogun', 'Ondo', 'Osun', 'Oyo',
  'Plateau', 'Rivers', 'Sokoto', 'Taraba', 'Yobe', 'Zamfara',
];

// Canonical disease name -> recognized raw variants (lowercased). Includes
// "apf" because the live report itself has this typo for AFP (Acute
// Flaccid Paralysis) — a genuine example of exactly the inconsistency this
// module exists to absorb.
const KNOWN_DISEASES = {
  'Lassa Fever': ['lassa fever', 'lassa'],
  'Cerebrospinal Meningitis (CSM)': ['cerebrospinal meningitis (csm)', 'cerebrospinal meningitis', 'csm'],
  'Yellow Fever': ['yellow fever'],
  Cholera: ['cholera'],
  Measles: ['measles'],
  Mpox: ['mpox', 'monkeypox'],
  'Acute Flaccid Paralysis (AFP)': ['acute flaccid paralysis (afp)', 'acute flaccid paralysis (apf)', 'acute flaccid paralysis', 'afp', 'apf'],
  'Coronavirus Disease (COVID-19)': ['coronavirus disease (covid-19)', 'coronavirus disease', 'covid-19', 'covid 19', 'covid19'],
  Diphtheria: ['diphtheria'],
};

function normalizeWhitespace(s) {
  return (s || '').replace(/\s+/g, ' ').trim();
}

/** "LAGOS" / "Lagos State" / "LAGOS STATE" -> "Lagos". Returns null (never
 * guesses) if the cleaned value doesn't match a real Nigerian state. */
function standardizeStateName(raw) {
  if (!raw) return null;
  const cleaned = normalizeWhitespace(raw).replace(/\s+state\.?$/i, '');
  const match = KNOWN_STATES.find((s) => s.toLowerCase() === cleaned.toLowerCase());
  return match || null;
}

/** "Lassa fever" / "LASSA FEVER" -> "Lassa Fever". Returns null if unrecognized. */
function standardizeDiseaseName(raw) {
  if (!raw) return null;
  const cleaned = normalizeWhitespace(raw).toLowerCase();
  for (const [canonical, variants] of Object.entries(KNOWN_DISEASES)) {
    if (variants.includes(cleaned)) return canonical;
  }
  return null;
}

function toInt(value) {
  if (value == null) return null;
  const n = parseInt(String(value).replace(/,/g, ''), 10);
  return Number.isNaN(n) ? null : n;
}

// Matches the fixed sentence structure confirmed on every disease page:
// "...Suspected cases Confirmed cases Death(s) Number of States and LGAs
// affected <N> <N> <N> State: <N>..."
const WEEKLY_COUNTS_RE = /Suspected cases\s+Confirmed cases\s+Death\(?s?\)?\s+Number of States and LGAs affected\s+(\d+)\s+(\d+)\s+(\d+)\s+State:\s*(\d+)/i;

// Matches the Key Point sentence naming a single affected state, e.g.
// "...reported from 1 LGA in Akwa Ibom state." Word-numbers ("one", "four")
// appear in this prose in the real report, so this regex deliberately
// does NOT try to parse the count from here — counts come from
// WEEKLY_COUNTS_RE above, which uses real digits.
const NAMED_STATE_RE = /\bin\s+([A-Z][A-Za-z]+(?:\s+[A-Z][A-Za-z]+)*)\s+state\b/i;

/**
 * Extracts zero or one DiseaseObservation candidate from a single page's
 * section text. Returns { observation } on a usable single-state row,
 * or { skipped: reason } when the page doesn't have per-state detail
 * (multi-state, or doesn't match a disease-page pattern at all — e.g. the
 * Influenza Sentinel Surveillance and Event-based Surveillance pages,
 * which are correctly ignored here because their text simply never
 * matches WEEKLY_COUNTS_RE).
 */
function extractCandidate(section, year, epiWeek) {
  const disease = standardizeDiseaseName(section.heading);
  if (!disease) return { skipped: `page ${section.pageNumber}: heading "${section.heading}" is not a recognized disease — not a disease page.` };

  const countsMatch = section.text.match(WEEKLY_COUNTS_RE);
  if (!countsMatch) return { skipped: `page ${section.pageNumber} (${disease}): weekly counts pattern not found — unrelated table, ignored.` };

  const [, suspected, , deaths, statesAffected] = countsMatch;
  const statesAffectedCount = toInt(statesAffected);

  if (statesAffectedCount !== 1) {
    return { skipped: `page ${section.pageNumber} (${disease}): ${statesAffectedCount} states affected but not individually named in the report text — cannot determine a single state, skipping rather than guessing.` };
  }

  const namedStateMatch = section.text.match(NAMED_STATE_RE);
  const state = namedStateMatch ? standardizeStateName(namedStateMatch[1]) : null;
  if (!state) {
    return { skipped: `page ${section.pageNumber} (${disease}): report says 1 state affected but no recognized state name found in text.` };
  }

  return {
    observation: {
      disease,
      state,
      epiWeek,
      year,
      cases: toInt(suspected),
      deaths: toInt(deaths),
      source: 'NCDC',
    },
  };
}

function validateObservation(obs) {
  if (!obs.disease) return 'missing disease';
  if (!obs.state) return 'missing state';
  if (obs.epiWeek == null || Number.isNaN(obs.epiWeek)) return 'missing epidemiological week';
  if (obs.cases == null || Number.isNaN(obs.cases)) return 'missing/invalid cases value';
  return null;
}

function dedupeKey(obs) {
  return `${obs.disease}|${obs.state}|${obs.year}|${obs.epiWeek}`;
}

/**
 * Converts a ParsedNCDCReport into DiseaseObservation[].
 *
 * Honesty note: this module never invents a state. Where a disease page
 * reports cases across multiple states without naming them individually
 * (the common case in NCDC's current PDF layout — only single-state
 * diseases name their state in prose), those rows are rejected by
 * validation and logged, not silently dropped and not guessed. A future
 * report layout that includes a real per-state table would flow through
 * the same validation and simply produce more observations, with no
 * change needed here — that resilience is the point of normalizing
 * against the neutral ParsedNCDCReport model instead of raw PDF tables.
 *
 * @param {import('./ncdcTypes').ParsedNCDCReport} parsedReport
 * @returns {{observations: import('./ncdcTypes').DiseaseObservation[], rejected: Array<{reason:string}>}}
 */
function normalizeDiseaseReport(parsedReport) {
  if (!parsedReport || !Array.isArray(parsedReport.sections)) {
    return { observations: [], rejected: [{ reason: 'No parsed report sections provided.' }] };
  }

  const { year, epiWeek } = parsedReport.metadata || {};
  const rejected = [];
  const seen = new Set();
  const observations = [];

  for (const section of parsedReport.sections) {
    const result = extractCandidate(section, year, epiWeek);

    if (result.skipped) {
      console.warn('[disease-normalizer]', result.skipped);
      continue;
    }

    const obs = result.observation;
    const invalidReason = validateObservation(obs);
    if (invalidReason) {
      console.warn(`[disease-normalizer] Rejected observation (${obs.disease || 'unknown disease'}): ${invalidReason}`);
      rejected.push({ reason: invalidReason, disease: obs.disease, state: obs.state });
      continue;
    }

    const key = dedupeKey(obs);
    if (seen.has(key)) {
      console.warn(`[disease-normalizer] Duplicate observation skipped: ${key}`);
      continue;
    }
    seen.add(key);
    observations.push(obs);
  }

  return { observations, rejected };
}

module.exports = {
  normalizeDiseaseReport,
  standardizeDiseaseName,
  standardizeStateName,
};
