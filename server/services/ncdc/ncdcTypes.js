/**
 * NCDC module — type definitions only. No logic, no I/O.
 *
 * @typedef {Object} NCDCReportMetadata
 * @property {number} year - Report year (e.g. 2026).
 * @property {number} epiWeek - Epidemiological week number.
 * @property {string} title - Report title.
 * @property {Date} publishedDate - When the report was posted.
 * @property {string} reportUrl - Absolute URL to the report (metadata only — never fetched/downloaded by this module).
 * @property {boolean} isNew - Whether this is newer than the last processed report on record.
 */

/**
 * A neutral internal document model — deliberately NOT "extractedText" /
 * "extractedTables" leaking PDF-specific shape into the rest of the system.
 * Later modules (Normalizer, Disease Extractor, Decision Engine) consume
 * this without caring whether the source was a PDF today or an API
 * tomorrow. The parser does not interpret content — it only converts the
 * source document into this consistent structure.
 *
 * @typedef {Object} ParsedNCDCReport
 * @property {Object} metadata - { year, epiWeek, title, publishedDate, reportUrl, localPath }
 * @property {number} pages - Page count.
 * @property {Array<{pageNumber:number, heading:string|null, text:string}>} sections - One per page; heading is a structural (font-size) guess, not a semantic one.
 * @property {Array<{pageNumber:number, rows:string[][]}>} tables - Best-effort, position-based extraction; only present where a page shows a real multi-column pattern.
 */

/**
 * The stable, source-agnostic record the rest of the platform should
 * consume — "source" exists precisely so a future non-NCDC source can
 * produce the same shape without downstream code changing.
 *
 * @typedef {Object} DiseaseObservation
 * @property {string} disease - Standardized disease name (e.g. "Lassa Fever").
 * @property {string} state - Standardized Nigerian state name (e.g. "Lagos").
 * @property {number} epiWeek
 * @property {number} year
 * @property {number} cases
 * @property {number|null} deaths
 * @property {"NCDC"} source
 */

/**
 * A structured pharmacy demand signal derived from observed disease trend
 * data. evidenceScore is quantitative (0.0-1.0) rather than a categorical
 * label specifically so it can be combined consistently with Weather and
 * Calendar Intelligence's own confidence figures later, in the Decision
 * Engine — this module does not do that combining itself.
 *
 * @typedef {Object} DiseaseSignal
 * @property {string} disease
 * @property {string} category - Pharmacy therapeutic category.
 * @property {"Increasing"|"Stable"|"Decreasing"} trend - Observed only; never predictive.
 * @property {"Increase"|"Neutral"|"Decrease"} expectedDemand
 * @property {number} evidenceScore - 0.0-1.0.
 * @property {string} rationale
 * @property {"NCDC"} source
 */

module.exports = {};
