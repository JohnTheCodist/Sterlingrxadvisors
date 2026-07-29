# NCDC Module — Backlog

## Narrative State Extraction (deferred)

**Status:** Not implemented. Explicitly deferred by product decision during Sprint 5.

**Context:** Sprint 4's Disease Normalizer found that NCDC's current weekly
report PDFs only name an affected state in prose when *exactly one* state
is affected (e.g. "...reported from 1 LGA in Akwa Ibom state."). When
multiple states are affected, the report gives only a count ("State: 14 +
FCT"), never a per-state breakdown in extractable text. As a result, most
diseases in a typical report currently produce zero `DiseaseObservation`
records — real, but a narrow slice of the data.

**Why deferred rather than built now:** the Decision Engine and Disease
Intelligence must stay deterministic and testable against a stable,
structured schema (`DiseaseObservation[]`). Parsing free-text narrative to
infer locations is inherently fuzzier and more fragile to report-wording
changes than structured-field extraction. Building it now would make
Disease Intelligence depend on prose-parsing accuracy; the decision is to
keep that dependency out until it's a deliberate, optional enrichment
layer instead.

**What it would involve, when picked up:**
- Multi-state narrative lists (not yet seen in a real report, but plausible
  given NCDC's phrasing patterns): "...reported from LGAs in Lagos, Ogun,
  and Oyo states."
- Would sit *before* `diseaseNormalizer.js` in the pipeline (or as an
  alternate extraction path feeding it), producing the same
  `DiseaseObservation[]` shape — so Disease Intelligence and everything
  downstream would not need to change at all.
- Should ship behind a flag / as an optional enrichment pass, not a
  required step — normalization must keep working correctly with it
  disabled, exactly as it does today.

**Explicit constraint carried into Sprint 5 and beyond:** the Disease
Intelligence module consumes only normalized `DiseaseObservation` records
produced by `diseaseNormalizer.js`. It must not parse report prose or
infer locations from narrative text itself.
